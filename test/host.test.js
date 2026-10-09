/**
 * Host-plugin tests: the service's policy decisions and the wire contract the
 * browser half depends on.
 *
 * Every test builds the store it needs, so no test can be made green or red by
 * another test's deletions. The plugin runs against a stand-in context that
 * implements only the Cordis surface the plugin uses (`get`, `provide`,
 * `effect`, `on`, `emit`, `inject`, `logger`), so what is pinned here is the
 * plugin's behavior rather than a framework's.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { RPC_CHANNEL, RPC_DELETE, RPC_INSPECT, RPC_PENDING, RPC_STORE, rpcUrl } from '../lib/constants.js';
import { encodeSegment, projectKey } from '../lib/engine.js';
import plugin, { DEFAULTS, SessionAdmin, apply, inject, name, resolveConfig } from '../lib/index.js';
import { describeInspection } from '../lib/report.js';

/** Plugin config a deployment would resolve: the documented defaults. */
const BASE_CONFIG = { ...DEFAULTS };

/** @type {string[]} */
const created = [];

after(async () => {
  await Promise.all(created.map((entry) => rm(entry, { recursive: true, force: true })));
});

/**
 * Create a store holding one stored session in the real on-disk shape.
 *
 * @param {{ id?: string, title?: string|null, cwd?: string, live?: boolean }} [spec] - session to create.
 * @returns {Promise<{ home: string, id: string, dir: string }>} the store and the session in it.
 */
async function makeStore(spec = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-host-'));
  created.push(home);
  const id = spec.id ?? 'session-host-cold-0001';
  const cwd = spec.cwd ?? '/tmp/host-project';
  const dir = path.join(home, 'sessions', projectKey(cwd), encodeSegment(id));
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await writeFile(
    path.join(dir, 'session.v3.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session',
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      cwd,
      isSeeded: false,
    })}\n`)),
  );
  await writeFile(
    path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    `${JSON.stringify({
      version: 7,
      record: { identity: {}, rows: { title: { ver: 1, seq: 1, val: spec.title === undefined ? 'Host test session' : spec.title } } },
    })}\n`,
  );
  return { home, id, dir };
}

/** Minimal stand-in for a Cordis context, recording what the plugin registers. */
class FakeContext {
  /**
   * @param {Record<string, unknown>} [services] - services this context can resolve.
   */
  constructor(services = {}) {
    /** @type {Map<string, unknown>} */
    this.services = new Map(Object.entries(services));
    /** @type {Map<string, unknown>} */
    this.provided = new Map();
    /** @type {{ event: string, payload: unknown }[]} */
    this.emitted = [];
    /** @type {Function[]} */
    this.cleanups = [];
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** @type {unknown[]} */
    this.logs = [];
    /** @type {{ keys: string[], callback: Function|undefined }[]} */
    this.injected = [];
    /** @type {FakeContext[]} */
    this.children = [];
    this.logger = { info: (line) => this.logs.push(line), warn: (line) => this.logs.push(line) };
  }

  /** @param {string} key - service key. @returns {unknown} the service or undefined. */
  get(key) {
    return this.services.get(key);
  }

  /** @param {string} key - service key. @param {unknown} value - service value. @returns {() => void} disposer. */
  provide(key, value) {
    this.provided.set(key, value);
    return () => this.provided.delete(key);
  }

  /** @param {Function} factory - effect factory. @returns {void} */
  effect(factory) {
    const disposer = factory();
    if (typeof disposer === 'function') this.cleanups.push(disposer);
  }

  /** @param {string} event - event name. @param {Function} listener - listener. @returns {void} */
  on(event, listener) {
    this.listeners[event] = [...(this.listeners[event] ?? []), listener];
  }

  /** @param {string} event - event name. @param {unknown} payload - payload. @returns {void} */
  emit(event, payload) {
    this.emitted.push({ event, payload });
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }

  /**
   * Register a child that runs only when every named service is present.
   *
   * Mirrors the Cordis contract the plugin relies on: `ctx.inject(keys, fn)`
   * parks the registration until the keys resolve, and the callback receives a
   * context whose named properties are those services.
   *
   * @param {string[]|string} keys - required service keys.
   * @param {Function} [callback] - registration callback.
   * @returns {void}
   */
  inject(keys, callback) {
    const list = typeof keys === 'string' ? [keys] : keys;
    this.injected.push({ keys: list, callback });
    if (typeof callback !== 'function') return;
    if (!list.every((key) => this.services.has(key))) return;
    // The child is a normal context in every respect — it can register effects,
    // emit, and resolve further services — plus the injected keys as properties.
    const child = new FakeContext(Object.fromEntries(this.services));
    for (const key of list) child[key] = this.services.get(key);
    this.children.push(child);
    callback(child);
  }
}

/**
 * Build the service dependencies the plugin injects.
 *
 * @param {string[]} liveIds - session ids this stand-in process treats as live.
 * @returns {Record<string, unknown>} the service map.
 */
function services(liveIds = []) {
  return {
    sessions: {
      get: (id) => (liveIds.includes(id) ? { id } : undefined),
      list: () => liveIds.map((id) => ({ id })),
    },
    agents: { get: (id) => (liveIds.includes(id) ? { id } : undefined) },
    sessionPersistence: { list: async () => [] },
    storageDomain: { get: () => undefined },
  };
}

/**
 * Build a service with no transports attached.
 *
 * @param {{ home: string, live?: string[] }} options - store and liveness.
 * @returns {SessionAdmin} the service.
 */
function makeAdmin({ home, live = [] }) {
  return new SessionAdmin(new FakeContext(services(live)), { ...BASE_CONFIG, dshHome: home });
}

describe('plugin shape', () => {
  it('declares the dependencies it cannot degrade without', () => {
    assert.equal(name, 'session-admin');
    assert.deepEqual(inject, ['sessions', 'sessionPersistence', 'storageDomain']);
    assert.equal(DEFAULTS.backup, false);
    assert.equal(DEFAULTS.enableCommand, true);
    assert.equal(DEFAULTS.enableRpc, true);
    assert.equal(DEFAULTS.finishOnClose, true);
  });

  it('declares no Cordis Config schema, which would crash the loader', () => {
    // A plugin whose config is declared must export a Standard Schema; a plain
    // descriptor object makes Cordis throw during resolution and takes the
    // whole profile down at boot. The defaults live in lib/config.js instead.
    assert.equal(Object.hasOwn(plugin, 'Config'), false);
    assert.equal(typeof plugin.apply, 'function');
    const defaults = resolveConfig(undefined);
    assert.equal(defaults.commandName, 'delete');
    assert.equal(defaults.backup, false);
  });

  it('treats a hostile config object as untrusted input', () => {
    const normalized = resolveConfig({
      commandName: '../../../bin/sh',
      backup: 'yes',
      enableCommand: 1,
      dshHome: '',
      journal: null,
      surprise: true,
    });
    assert.equal(normalized.commandName, 'delete');
    assert.equal(normalized.backup, false);
    assert.equal(normalized.enableCommand, true);
    assert.equal(normalized.dshHome, undefined);
    assert.equal(normalized.journal, true);
    assert.equal(Object.hasOwn(normalized, 'surprise'), false);
    // A path-ish command name never reaches the registry.
    const allowed = resolveConfig({ commandName: 'purge-all' });
    assert.equal(allowed.commandName, 'purge-all');
  });

  it('provides the service and wires both transports on apply', async () => {
    const { home } = await makeStore();
    const ctx = new FakeContext({
      ...services(),
      connection: { requestRejection: () => undefined },
      webServer: { register: () => () => {} },
      commands: { register: () => () => {} },
    });
    apply(ctx, { ...BASE_CONFIG, dshHome: home });
    assert.ok(ctx.provided.get('sessionAdmin') instanceof SessionAdmin);
    const injectedKeys = ctx.injected.flatMap((entry) => entry.keys);
    assert.ok(injectedKeys.includes('commands'));
    assert.ok(injectedKeys.includes('connection'));
    assert.equal(ctx.logs.length, 1);
  });

  it('parks its transports when an optional service is absent', async () => {
    const { home } = await makeStore();
    const ctx = new FakeContext(services());
    apply(ctx, { ...BASE_CONFIG, dshHome: home });
    // No commands and no connection: the host capability still exists.
    assert.ok(ctx.provided.get('sessionAdmin') instanceof SessionAdmin);
    const admin = /** @type {SessionAdmin} */ (ctx.provided.get('sessionAdmin'));
    const report = await admin.inspect('session-host-cold-0001');
    assert.equal(report.sessionId, 'session-host-cold-0001');
  });

  it('serves its own RPC channel, never the reserved shared one', () => {
    assert.equal(RPC_CHANNEL, '/session-admin');
    assert.notEqual(RPC_CHANNEL, '/api');
    // Endpoints are relative names: the carrier strips the channel prefix and
    // refuses an envelope whose method is not the remainder.
    assert.deepEqual([RPC_INSPECT, RPC_DELETE, RPC_PENDING, RPC_STORE], ['inspect', 'delete', 'pending', 'store']);
    assert.equal(rpcUrl(RPC_DELETE), '/session-admin/delete');
    for (const endpoint of [RPC_INSPECT, RPC_DELETE, RPC_PENDING, RPC_STORE]) {
      assert.equal(endpoint.includes('/'), false, 'an endpoint name carries no separator');
    }
  });

  it('keeps the client bundle’s inlined vocabulary identical to the shared constants', async () => {
    const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    // The bundle is a classic script the page loads directly, so it cannot
    // import the constants module; this is the check that keeps the copy honest.
    for (const literal of ['dsh-session-admin', 'session-admin-delete', '/session-admin']) {
      assert.ok(bundle.includes(`'${literal}'`), `client bundle is missing ${literal}`);
    }
    assert.equal(bundle.includes('import '), false, 'client bundle must not contain an import statement');
    assert.ok(bundle.includes('window.__ModuleLoader__.load('));
    assert.ok(bundle.includes("require('react')"));
    // The endpoint names travel in the envelope, not in the URL alone.
    for (const verb of ["const RPC_INSPECT = 'inspect'", "const RPC_DELETE = 'delete'"]) {
      assert.ok(bundle.includes(verb), `client bundle is missing ${verb}`);
    }
    assert.equal(bundle.includes('createElement'), true);
  });
});

describe('service policy', () => {
  it('refuses to delete a live session and queues it instead', async () => {
    const { home, id } = await makeStore();
    const admin = makeAdmin({ home, live: [id] });
    await assert.rejects(
      () => admin.delete(id),
      (error) => error.code === 'SESSION_ADMIN_LIVE_SESSION',
    );
    const queued = await admin.queue(id);
    assert.equal(queued.queued, true);
    assert.deepEqual(admin.listQueued().map((entry) => entry.sessionId), [id]);
    assert.equal(admin.listQueued()[0].live, true);
  });

  it('unqueue removes the entry and emits the notification', async () => {
    const { home, id } = await makeStore();
    const ctx = new FakeContext(services([id]));
    const admin = new SessionAdmin(ctx, { ...BASE_CONFIG, dshHome: home });
    await admin.queue(id);
    assert.equal(admin.unqueue(id), true);
    assert.equal(admin.unqueue(id), false);
    assert.deepEqual(
      ctx.emitted.filter((entry) => entry.event === 'session/admin-unqueued').length,
      1,
    );
  });

  it('deletes immediately when a queued session turns out to be cold', async () => {
    const { home, id } = await makeStore();
    const admin = makeAdmin({ home });
    const outcome = await admin.queue(id);
    assert.equal(outcome.queued, false);
    assert.equal(outcome.reason, 'deleted');
    assert.equal(admin.listQueued().length, 0);
    await assert.rejects(() => admin.inspect(id), (error) => error.code === 'SESSION_ADMIN_NOT_FOUND');
  });

  it('settles a queued deletion only after the session is released', async () => {
    const { home, id } = await makeStore();
    const admin = makeAdmin({ home, live: [id] });
    await admin.queue(id);
    // Still live: settling must not touch it, and an ordinary delete is refused.
    assert.deepEqual(await admin.settleQueued(), { settled: [], failed: [] });
    await assert.rejects(
      () => admin.delete(id),
      (error) => error.code === 'SESSION_ADMIN_LIVE_SESSION',
    );
    // The store releases it; the next settle completes. `live: false` is the
    // caller asserting exactly that, which is what the disposal listener does.
    const released = makeAdmin({ home });
    released.queued.set(id, { sessionId: id, requestedAt: 'now', at: 0, by: 'test' });
    const result = await released.settleQueued();
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.settled.map((entry) => entry.sessionId), [id]);
    assert.equal(released.listQueued().length, 0);
  });

  it('contains a failure per session instead of stranding the queue', async () => {
    const { home, id } = await makeStore();
    const admin = makeAdmin({ home });
    admin.queued.set(id, { sessionId: id, requestedAt: 'now', at: 0, by: 'test' });
    admin.queued.set('session-already-gone-0001', { sessionId: 'session-already-gone-0001', requestedAt: 'now', at: 1, by: 'test' });
    const result = await admin.settleQueued();
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.settled.map((entry) => entry.sessionId), [id]);
    assert.equal(admin.listQueued().length, 0, 'a not-found entry must not stay queued forever');
  });

  it('reports store totals and the queue length', async () => {
    const { home, id } = await makeStore();
    const admin = makeAdmin({ home, live: [id] });
    await admin.queue(id);
    const summary = await admin.storeSummary();
    assert.equal(summary.dshHome, home);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.queued, 1);
    assert.equal(summary.live, 1);
    assert.equal(summary.backup, false);
  });

  it('lists sessions from persistence without reading a body', async () => {
    const { home, id } = await makeStore();
    const ctx = new FakeContext({
      ...services(),
      sessionPersistence: {
        list: async () => [{
          header: { id, cwd: '/tmp/host-project', createdAt: 1_700_000_000_000 },
          revision: 'r1',
          sizeBytes: 42,
        }],
      },
    });
    const admin = new SessionAdmin(ctx, { ...BASE_CONFIG, dshHome: home });
    const listing = await admin.listSessions();
    assert.equal(listing.total, 1);
    assert.equal(listing.sessions[0].id, id);
    assert.equal(listing.sessions[0].title, 'Host test session');
    assert.equal(listing.sessions[0].title, 'Host test session');
    assert.equal(listing.sessions[0].live, false);
  });
});

describe('RPC channel', () => {
  /**
   * Serve the plugin's channel on a real HTTP server.
   *
   * The plugin registers an HTTP prefix route and asks the connection service
   * for its trust decision, so the honest test is a real socket: it exercises
   * the envelope encoding, the JSON body limit, the endpoint derivation and the
   * rejection status codes, none of which a stubbed handler would cover.
   *
   * @param {{ home: string, live?: string[], trust?: (req: any) => number|undefined }} options - store, liveness, and an optional trust override.
   * @returns {Promise<{ url: string, call: (path: string, body: unknown, headers?: Record<string,string>) => Promise<{ status: number, body: any }>, close: () => Promise<void> }>} the server and a caller.
   */
  async function rpcServer({ home, live = [], trust }) {
    const { createServer } = await import('node:http');
    /** @type {any} */
    let route;
    const reject = trust ?? (() => undefined);
    /** @type {any[]} */
    const registrations = [];
    const ctx = new FakeContext({
      ...services(live),
      connection: { requestRejection: (req) => reject(req) },
      webServer: {
        register: (value) => {
          registrations.push(value);
          route = value;
          return () => {};
        },
      },
    });
    apply(ctx, { ...BASE_CONFIG, dshHome: home });
    assert.equal(registrations.length, 1, 'the plugin must register exactly one channel route');
    assert.equal(registrations[0].kind, 'prefix');
    assert.equal(registrations[0].path, RPC_CHANNEL);

    const server = createServer((req, res) => {
      route.handler(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {any} */ (server.address()).port;
    return {
      url: `http://127.0.0.1:${port}`,
      /**
       * Post one envelope the way the browser half does.
       *
       * @param {string} path - request path.
       * @param {unknown} body - request body.
       * @param {Record<string,string>} [headers] - extra headers.
       * @returns {Promise<{ status: number, body: any }>} the response.
       */
      call: async (path, body, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const text = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        return { status: response.status, body: parsed };
      },
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  /**
   * Build one request envelope.
   *
   * @param {string} method - endpoint name.
   * @param {unknown} payload - request payload.
   * @returns {Record<string, unknown>} the envelope.
   */
  function envelope(method, payload) {
    return { type: 'client-request', rpcId: `test-${method}`, method, payload };
  }

  it('answers store, inspect and delete with the documented envelopes', async () => {
    const { home, id } = await makeStore();
    const server = await rpcServer({ home });
    try {
      const store = await server.call('/session-admin/store', envelope('store', {}));
      assert.equal(store.status, 200);
      assert.equal(store.body.type, 'server-response');
      assert.equal(store.body.rpcId, 'test-store');
      assert.equal(store.body.result.ok, true);
      assert.equal(store.body.result.value.dshHome, home);

      const inspection = await server.call('/session-admin/inspect', envelope('inspect', { sessionId: id }));
      assert.equal(inspection.body.result.ok, true);
      assert.equal(inspection.body.result.value.sessionId, id);
      assert.equal(inspection.body.result.value.title, 'Host test session');
      assert.equal(inspection.body.result.value.live, false);
      assert.ok(inspection.body.result.value.lines.some((line) => /cannot be undone/i.test(line)));
      // Paths are host facts; the browser projection must not carry them.
      assert.equal(JSON.stringify(inspection.body.result.value).includes(home), false);

      const deleted = await server.call('/session-admin/delete', envelope('delete', { sessionId: id }));
      assert.equal(deleted.body.result.ok, true);
      assert.equal(deleted.body.result.value.queued, false);
      assert.ok(deleted.body.result.value.report.removedCount > 0);

      const again = await server.call('/session-admin/delete', envelope('delete', { sessionId: id }));
      assert.equal(again.body.result.ok, false);
      assert.equal(again.body.result.error.code, 'SESSION_ADMIN_NOT_FOUND');
    } finally {
      await server.close();
    }
  });

  it('refuses an unauthenticated request before reading a body', async () => {
    const { home } = await makeStore();
    // The default override in this harness is "trusted"; this one rejects with 401.
    const server = await rpcServer({ home, trust: () => 401 });
    try {
      const response = await server.call('/session-admin/store', envelope('store', {}));
      assert.equal(response.status, 401);
      assert.equal(response.body, 'unauthorized');
      const forbidden = await rpcServer({ home, trust: () => 403 });
      const denied = await forbidden.call('/session-admin/store', envelope('store', {}));
      assert.equal(denied.status, 403);
      assert.equal(denied.body, 'forbidden');
      await forbidden.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed envelope, an unknown endpoint and a bad path', async () => {
    const { home } = await makeStore();
    const server = await rpcServer({ home });
    try {
      const malformed = await server.call('/session-admin/store', { type: 'client-request', rpcId: 'x', method: 'other', payload: {} });
      assert.equal(malformed.status, 200);
      assert.equal(malformed.body.result.ok, false);
      assert.equal(malformed.body.result.error.code, 'SESSION_ADMIN_INVALID_OPTION');

      const unknown = await server.call('/session-admin/nope', envelope('nope', {}));
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.result.ok, false);
      assert.equal(unknown.body.result.error.code, 'SESSION_ADMIN_INVALID_OPTION');

      // A nested path names no endpoint.
      const nested = await server.call('/session-admin/a/b', envelope('a', {}));
      assert.equal(nested.status, 404);

      const notJson = await server.call('/session-admin/store', 'not json at all');
      assert.equal(notJson.status, 400);
    } finally {
      await server.close();
    }
  });

  it('rejects hostile payloads without touching the filesystem', async () => {
    const { home, dir } = await makeStore();
    const server = await rpcServer({ home });
    try {
      for (const payload of [
        { sessionId: '../etc/passwd' },
        { sessionId: 'a/b' },
        { sessionId: '' },
        { sessionId: 42 },
        { sessionId: 'x'.repeat(200) },
        { sessionId: '..' },
        { sessionId: null },
        {},
        null,
        'session-plain-string',
      ]) {
        const response = await server.call('/session-admin/delete', envelope('delete', payload));
        assert.equal(response.body.result.ok, false, `expected ${JSON.stringify(payload)} to be rejected`);
        assert.equal(response.body.result.error.code, 'SESSION_ADMIN_INVALID_OPTION');
      }
      const stillThere = await readFile(path.join(dir, 'session.v3.jsonl.zstd'));
      assert.ok(stillThere.length > 0);
    } finally {
      await server.close();
    }
  });

  it('reports a live session as live and queues only when asked', async () => {
    const { home, id } = await makeStore();
    const server = await rpcServer({ home, live: [id] });
    try {
      const inspection = await server.call('/session-admin/inspect', envelope('inspect', { sessionId: id }));
      assert.equal(inspection.body.result.value.live, true);

      const refused = await server.call('/session-admin/delete', envelope('delete', { sessionId: id }));
      assert.equal(refused.body.result.ok, false);
      assert.equal(refused.body.result.error.code, 'SESSION_ADMIN_LIVE_SESSION');

      const queued = await server.call('/session-admin/delete', envelope('delete', { sessionId: id, queue: true }));
      assert.equal(queued.body.result.ok, true);
      assert.equal(queued.body.result.value.queued, true);

      const pending = await server.call('/session-admin/pending', envelope('pending', {}));
      assert.equal(pending.body.result.ok, true);
      assert.equal(pending.body.result.value.queued.length, 1);
      assert.deepEqual(pending.body.result.value.unfinished, []);

      const repaired = await server.call('/session-admin/repair', envelope('repair', {}));
      assert.equal(repaired.body.result.ok, true);
      assert.deepEqual(repaired.body.result.value.repaired, []);
    } finally {
      await server.close();
    }
  });
});

describe('command surface', () => {
  /**
   * Apply the plugin with a recording command registry.
   *
   * @param {{ home: string, live?: string[], config?: Record<string, unknown> }} options - store, liveness and config overrides.
   * @returns {{ registrations: any[], ctx: FakeContext }} what was registered.
   */
  function commandHarness({ home, live = [], config = {} }) {
    /** @type {any[]} */
    const registrations = [];
    const ctx = new FakeContext({
      ...services(live),
      connection: { requestRejection: () => undefined },
      webServer: { register: () => () => {} },
      commands: { register: (value) => { registrations.push(value); return () => {}; } },
    });
    apply(ctx, { ...BASE_CONFIG, dshHome: home, ...config });
    return { registrations, ctx };
  }

  it('registers /delete and reports a missing session as an error result', async () => {
    const { home } = await makeStore();
    const { registrations } = commandHarness({ home });
    assert.equal(registrations.length, 1);
    const [definition] = registrations;
    assert.equal(definition.name, 'delete');
    assert.ok(typeof definition.description === 'string' && definition.description.length > 0);

    const result = await definition.handler({
      agent: { session: { id: 'session-agent-0001' } },
      rawInput: 'session-absent-0001',
      attachments: [],
      signal: new AbortController().signal,
      commandId: 'cmd-1',
    });
    assert.equal(result.kind, 'error');
    assert.ok(/no stored session/i.test(result.text));
  });

  it('falls back to the receiving session when no id is given', async () => {
    const { home, id } = await makeStore();
    const { registrations } = commandHarness({ home });
    const result = await registrations[0].handler({
      agent: { session: { id } },
      rawInput: '   ',
      attachments: [],
      signal: new AbortController().signal,
      commandId: 'cmd-2',
    });
    assert.equal(result.kind, 'success');
    assert.ok(result.text.includes(id));
  });

  it('queues instead of failing when the addressed session is live', async () => {
    const { home, id } = await makeStore();
    const { registrations } = commandHarness({ home, live: [id] });
    const result = await registrations[0].handler({
      agent: { session: { id: 'session-other-0001' } },
      rawInput: id,
      attachments: [],
      signal: new AbortController().signal,
      commandId: 'cmd-3',
    });
    assert.equal(result.kind, 'success');
    assert.ok(/queued/i.test(result.text));
  });

  it('errors when neither an argument nor a session id is available', async () => {
    const { home } = await makeStore();
    const { registrations } = commandHarness({ home });
    const result = await registrations[0].handler({
      agent: {},
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
      commandId: 'cmd-4',
    });
    assert.equal(result.kind, 'error');
    assert.ok(/usage/i.test(result.text));
  });

  it('honors a renamed command and skips registration when disabled', async () => {
    const { home } = await makeStore();
    const renamed = commandHarness({ home, config: { commandName: 'purge' } });
    assert.deepEqual(renamed.registrations.map((entry) => entry.name), ['purge']);
    const off = commandHarness({ home, config: { enableCommand: false } });
    assert.deepEqual(off.registrations, []);
  });

  it('does not register an RPC channel when disabled', async () => {
    const { home } = await makeStore();
    let handled = 0;
    const ctx = new FakeContext({
      ...services(),
      connection: { requestRejection: () => undefined },
      webServer: { register: () => { handled += 1; return () => {}; } },
    });
    apply(ctx, { ...BASE_CONFIG, dshHome: home, enableRpc: false });
    assert.equal(handled, 0);
  });
});

describe('search index disclosure', () => {
  it('reads the query index path from the service and ignores an in-memory index', async () => {
    const { home, id } = await makeStore();
    const inMemory = new SessionAdmin(
      new FakeContext({ ...services(), sessionQuery: { config: { path: ':memory:' } } }),
      { ...BASE_CONFIG, dshHome: home },
    );
    assert.equal(inMemory.searchIndexPath(), null);
    const onDisk = new SessionAdmin(
      new FakeContext({ ...services(), sessionQuery: { config: { path: '/var/lib/dsh/q.sqlite' } } }),
      { ...BASE_CONFIG, dshHome: home },
    );
    assert.equal(onDisk.searchIndexPath(), '/var/lib/dsh/q.sqlite');
    const inspection = await onDisk.inspect(id);
    assert.equal(inspection.searchIndex, '/var/lib/dsh/q.sqlite');
    assert.ok(describeInspection(inspection).some((line) => line.includes('/var/lib/dsh/q.sqlite')));
    // No service at all is not an error.
    const absent = new SessionAdmin(new FakeContext(services()), { ...BASE_CONFIG, dshHome: home });
    assert.equal(absent.searchIndexPath(), null);
  });
});
