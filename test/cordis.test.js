/**
 * Integration test against the real Cordis runtime.
 *
 * Every other test drives the plugin through a stand-in context, which is fast
 * and precise but cannot catch a mistake in how the plugin meets Cordis itself:
 * a config that crashes the loader, a service registered on the wrong key, an
 * `inject` list that never resolves. This file loads the actual
 * `@deepseek-ai/cordis` that a dsh installation ships and puts the plugin
 * through it: real `Service` subclasses, a real fiber tree, real injection.
 *
 * The peer is optional by nature — a bare checkout has no dsh next to it — so
 * the suite reports itself skipped when Cordis cannot be imported, and runs
 * wherever a dsh install is present.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { DEFAULTS } from '../lib/index.js';
import { encodeSegment, projectKey } from '../lib/engine.js';

/**
 * Locate the Cordis runtime a dsh installation uses.
 *
 * Searched in the order a real deployment resolves it: alongside this package's
 * own dependencies, then the deployments a dsh install is commonly found in.
 *
 * @returns {Promise<{ Context: any, Service: any }|undefined>} the runtime, or undefined when absent.
 */
async function loadCordis() {
  const require = createRequire(import.meta.url);
  /** @type {string[]} */
  const candidates = [];
  const envHome = process.env.DSH_CODORIS_ROOT;
  if (typeof envHome === 'string' && envHome.length > 0) candidates.push(envHome);
  candidates.push(
    '@deepseek-ai/cordis',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  );
  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith('/') ? candidate : require.resolve(candidate);
      return await import(resolved);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const cordis = await loadCordis();
/** @type {string[]} */
const created = [];

after(async () => {
  await Promise.all(created.map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('real Cordis runtime', { skip: cordis === undefined ? 'no dsh installation found next to this package' : false }, () => {
  /**
   * Create a store with one stored session in the real on-disk shape.
   *
   * @param {string} id - session id.
   * @returns {Promise<{ home: string, dir: string }>} the store and the session directory.
   */
  async function makeStore(id) {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-cordis-'));
    created.push(home);
    const dir = path.join(home, 'sessions', projectKey('/tmp/cordis'), encodeSegment(id));
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
    await writeFile(
      path.join(dir, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp/cordis' })}\n`)),
    );
    await writeFile(
      path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      `${JSON.stringify({ version: 7, record: { identity: {}, rows: { title: { ver: 1, seq: 1, val: 'Real store' } } } })}\n`,
    );
    return { home, dir };
  }

  /**
   * Boot a real Cordis tree with the three services the plugin injects.
   *
   * @param {string} home - harness home the plugin should administer.
   * @param {string[]} [liveIds] - sessions the stand-in store reports as live.
   * @returns {Promise<{ root: any, channel: string|null, commands: any[], admin: any }>} the live tree.
   */
  async function boot(home, liveIds = []) {
    const { Context, Service } = cordis;
    const root = new Context();
    /** @type {any} */
    let channelRoute;
    /** @type {any[]} */
    const commands = [];
    const live = new Set(liveIds);

    class Sessions extends Service {
      constructor(ctx) {
        super(ctx, 'sessions');
      }

      get(sessionId) {
        return live.has(sessionId) ? { id: sessionId } : undefined;
      }

      list() {
        return [...live].map((sessionId) => ({ id: sessionId }));
      }
    }
    class Persistence extends Service {
      constructor(ctx) {
        super(ctx, 'sessionPersistence');
      }

      async list() {
        return [];
      }
    }
    class StorageDomain extends Service {
      constructor(ctx) {
        super(ctx, 'storageDomain');
      }

      get() {
        return undefined;
      }
    }
    class Commands extends Service {
      constructor(ctx) {
        super(ctx, 'commands');
      }

      register(definition) {
        commands.push(definition);
        return () => {};
      }
    }

    await root.plugin(Sessions);
    await root.plugin(Persistence);
    await root.plugin(StorageDomain);
    await root.plugin(Commands);
    // The two host services the plugin's browser channel needs: the trust
    // decision, and the route registry it publishes its prefix into.
    await root.plugin({
      name: 'connection-stand-in',
      apply(ctx) {
        ctx.provide('connection', { requestRejection: () => undefined });
        ctx.provide('webServer', {
          register(route) {
            channelRoute = route;
            return () => {
              channelRoute = undefined;
            };
          },
        });
      },
    });

    // The plugin itself, loaded exactly as a composition row loads it: the
    // plugin object plus the resolved config as the second argument.
    const plugin = (await import('../lib/index.js')).default;
    await root.plugin(plugin, { ...DEFAULTS, dshHome: home });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { root, channelRoute, commands, admin: root.get('sessionAdmin') };
  }

  it('registers its service, channel and command in a real fiber tree', async () => {
    const { home } = await makeStore('session-cordis-0001');
    const { admin, channelRoute, commands } = await boot(home);
    assert.ok(admin !== undefined, 'ctx.sessionAdmin must resolve');
    assert.equal(channelRoute?.kind, 'prefix');
    assert.equal(channelRoute?.path, '/session-admin');
    assert.deepEqual(commands.map((entry) => entry.name), ['delete']);
  });

  it('withdraws the channel route when its fiber is disposed', async () => {
    const { home } = await makeStore('session-cordis-0005');
    // Boot the plugin's fiber directly so it can be disposed in isolation.
    const { Context, Service } = cordis;
    const root = new Context();
    /** @type {any} */
    let channelRoute;
    class Sessions extends Service {
      constructor(ctx) {
        super(ctx, 'sessions');
      }

      get() {
        return undefined;
      }

      list() {
        return [];
      }
    }
    class Persistence extends Service {
      constructor(ctx) {
        super(ctx, 'sessionPersistence');
      }

      async list() {
        return [];
      }
    }
    class StorageDomain extends Service {
      constructor(ctx) {
        super(ctx, 'storageDomain');
      }

      get() {
        return undefined;
      }
    }
    await root.plugin(Sessions);
    await root.plugin(Persistence);
    await root.plugin(StorageDomain);
    await root.plugin({
      name: 'stand-ins',
      apply(ctx) {
        ctx.provide('connection', { requestRejection: () => undefined });
        ctx.provide('webServer', {
          register(route) {
            channelRoute = route;
            return () => {
              channelRoute = undefined;
            };
          },
        });
      },
    });

    const plugin = (await import('../lib/index.js')).default;
    const fiber = await root.plugin(plugin, { ...DEFAULTS, dshHome: home });
    assert.ok(channelRoute !== undefined, 'the route must be registered while the fiber lives');
    // A reloaded profile must not accumulate dead channels, so disposal has to
    // run the route's own disposer.
    await fiber.dispose();
    assert.equal(channelRoute, undefined);
  });

  it('announces the removal on the real event bus, which is how the row leaves the sidebar', async () => {
    const id = 'session-cordis-0006';
    const { home, dir } = await makeStore(id);
    const { root, admin } = await boot(home);
    /** @type {unknown[]} */
    const removals = [];
    root.on('api-session/removed', (sessionId) => removals.push(sessionId));
    await admin.delete(id);
    // The client removes a sidebar row when this event arrives; it is on the
    // forwarded-event allowlist with mode 'emit', so a bare session id is a valid
    // payload for the browser.
    assert.deepEqual(removals, [id]);
    await assert.rejects(() => readFile(path.join(dir, 'session.v3.jsonl.zstd'), 'utf8'), /ENOENT/);
  });

  it('inspects and deletes through real Services', async () => {
    const id = 'session-cordis-0002';
    const { home, dir } = await makeStore(id);
    const { admin } = await boot(home);
    const inspection = await admin.inspect(id);
    assert.equal(inspection.title, 'Real store');
    assert.equal(inspection.live, false);
    const report = await admin.delete(id);
    assert.equal(report.sessionId, id);
    await assert.rejects(() => readFile(path.join(dir, 'session.v3.jsonl.zstd'), 'utf8'), /ENOENT/);
    const summary = await admin.storeSummary();
    assert.equal(summary.sessions, 0);
  });

  it('refuses a live session, queues it, and settles once it is released', async () => {
    const id = 'session-cordis-0003';
    const { home, dir } = await makeStore(id);
    const built = await boot(home, [id]);
    const { admin } = built;
    await assert.rejects(() => admin.delete(id), (error) => error.code === 'SESSION_ADMIN_LIVE_SESSION');
    const queued = await admin.queue(id);
    assert.equal(queued.queued, true);
    assert.equal(admin.listQueued().length, 1);
    // Still live: settling must leave it alone.
    assert.deepEqual(await admin.settleQueued(), { settled: [], failed: [] });
    assert.equal(await readFile(path.join(dir, 'session.v3.jsonl.zstd'), 'utf8').then(() => true), true);
  });

  it('keeps the workspace registry consistent with its ledger', async () => {
    const id = 'session-cordis-0004';
    const { home } = await makeStore(id);
    const layoutPath = path.join(home, 'storages', 'workspace.json');
    await writeFile(layoutPath, `${JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [id] },
      tables: {
        workspaces: {
          'ws-1': { path: '/tmp/cordis', title: 'cordis', sessionIds: [id], createdAt: 'x', updatedAt: 'y' },
        },
      },
    }, null, 2)}\n`);
    const { admin } = await boot(home);
    await admin.delete(id);
    const after = JSON.parse(await readFile(layoutPath, 'utf8'));
    assert.deepEqual(after.global.archivedSessionIds, []);
    assert.deepEqual(after.tables.workspaces['ws-1'].sessionIds, []);
  });
});
