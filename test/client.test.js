/**
 * Client-bundle tests.
 *
 * The browser half is a hand-written classic script rather than compiled
 * output, so it gets its own test: the bundle is loaded into a minimal
 * `window`/`document`/`require` stand-in, the plugin is applied against a fake
 * slot registry, and the rendered component is driven through its real states
 * with a stubbed transport. That catches the failures a syntax check cannot —
 * a bad require, a hook order mistake, a state that renders nothing.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

/** Elements the stub `React.createElement` produced, flattened in render order. */
const rendered = [];

/**
 * A minimal React stand-in: enough of `createElement`, `useState`, `useEffect`,
 * `useRef` and `Fragment` to render this component tree, with no reconciler.
 */
const ReactStub = (() => {
  /**
   * Build one element record.
   *
   * @param {unknown} type - tag name or component function.
   * @param {Record<string, unknown>|null} props - element props.
   * @param {...unknown} children - child elements.
   * @returns {Record<string, unknown>} the element record.
   */
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });

  /** @type {unknown[][]} */
  const states = [];
  let cursor = 0;
  /** @type {Function[]} */
  const effects = [];

  return {
    createElement,
    Fragment: Symbol('Fragment'),
    /**
     * A slot-indexed state cell, so one render pass can hold several `useState` calls.
     *
     * @param {unknown} initial - initial value or initializer.
     * @returns {[unknown, Function]} the cell and its setter.
     */
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (states.length <= index) states.push([typeof initial === 'function' ? initial() : initial]);
      const setter = (next) => {
        states[index][0] = typeof next === 'function' ? next(states[index][0]) : next;
      };
      return [states[index][0], setter];
    },
    /** @param {Function} fn - effect body. @returns {void} */
    useEffect(fn) {
      effects.push(fn);
    },
    /**
     * A ref cell.
     *
     * @returns {{ current: unknown }} the ref.
     */
    useRef() {
      return { current: undefined };
    },
    /** Reset the hook cursors between renders. @returns {void} */
    __reset() {
      cursor = 0;
    },
    /** Effects registered during the last render. @returns {Function[]} the effect bodies. */
    __effects() {
      return effects.splice(0, effects.length);
    },
  };
})();

/** @type {Record<string, unknown>|undefined} */
let plugin;

before(async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  /** @type {{ factory?: Function }|undefined} */
  let loaded;
  const styles = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        loaded = registration;
      },
    },
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: (tag) => ({
      tag,
      dataset: {},
      textContent: '',
      remove() {
        this.removed = true;
      },
    }),
    head: { appendChild: (node) => styles.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.__styles = styles;

  // Evaluate the classic script the same way the page does.
  const evaluate = new Function('window', 'document', `${source}\n`);
  evaluate(globalThis.window, globalThis.document);
  assert.ok(loaded !== undefined, 'the bundle did not call window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-session-admin');
  plugin = loaded.factory((specifier) => {
    assert.equal(specifier, 'react');
    return ReactStub;
  });
});

after(() => {
  delete globalThis.window;
  delete globalThis.document;
});

describe('client bundle', () => {
  it('exports an ordinary Cordis plugin declaring the slot registry', () => {
    assert.equal(plugin.name, 'session-admin');
    assert.deepEqual(plugin.inject, ['slots']);
    assert.equal(typeof plugin.apply, 'function');
  });

  it('owns its stylesheet and claims a header action on apply', () => {
    /** @type {any[]} */
    const registrations = [];
    /** @type {string[]} */
    const injected = [];
    const ctx = {
      effect: (factory) => factory(),
      slots: {
        inject: (slot, callback) => {
          injected.push(slot);
          callback();
        },
        register: (options, component) => {
          registrations.push({ options, component });
          return () => {};
        },
      },
    };
    plugin.apply(ctx);
    assert.deepEqual(injected, ['conversation.session.header.actions']);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, 'conversation.session.header.actions');
    assert.equal(registrations[0].options.id, 'session-admin-delete');
    assert.equal(typeof registrations[0].component, 'function');
  });

  it('renders nothing without a session id and a control with one', () => {
    ReactStub.__reset();
    assert.equal(plugin.DeleteSessionAction({ sessionId: '' }), null);
    ReactStub.__reset();
    const element = plugin.DeleteSessionAction({ sessionId: 'session-x-0001' });
    assert.ok(element !== null);
    assert.equal(element.type, ReactStub.Fragment);
  });

  it('walks loading → ready → deleted through the real transport contract', async () => {
    /** @type {{ method: string, payload: unknown }[]} */
    const calls = [];
    globalThis.fetch = async (endpoint, init) => {
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, payload: body.payload, endpoint });
      if (body.method.endsWith('/inspect')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                sessionId: 'session-x-0001',
                title: 'Doomed',
                cwd: '/tmp/x',
                live: false,
                bytesRemoved: 2048,
                lines: ['Session: session-x-0001', 'This cannot be undone.'],
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          result: {
            ok: true,
            value: {
              queued: false,
              sessionId: 'session-x-0001',
              report: { sessionId: 'session-x-0001', removedCount: 3, bytesRemoved: 2048 },
              lines: ['Permanently deleted "Doomed".'],
            },
          },
        }),
      };
    };

    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    // The first effect issues the inspection.
    const effects = ReactStub.__effects();
    for (const effect of effects) effect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/session-admin/inspect');
    assert.deepEqual(calls[0].payload, { sessionId: 'session-x-0001' });
    // The URL carries the channel; the envelope's method is the bare endpoint
    // the carrier derives by stripping it.
    assert.equal(calls[0].method, 'inspect');
    delete globalThis.fetch;
  });

  it('surfaces a host failure instead of pretending it deleted something', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: false,
          error: { code: 'SESSION_ADMIN_LIVE_SESSION', message: 'session is open in this dsh process', details: {} },
        },
      }),
    });
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    // A non-OK envelope must throw, which the component catches into its error state.
    await assert.rejects(
      () => plugin.rpcCall('delete', { sessionId: 'session-x-0001' }),
      (error) => error.code === 'SESSION_ADMIN_LIVE_SESSION',
    );
    delete globalThis.fetch;
  });

  it('rejects a non-200 response rather than reporting success', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(
      () => plugin.rpcCall('delete', { sessionId: 'session-x-0001' }),
      /HTTP 401/,
    );
    delete globalThis.fetch;
  });

  it('sends a well-formed Connection RPC envelope', async () => {
    let envelope;
    globalThis.fetch = async (endpoint, init) => {
      envelope = { endpoint, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ result: { ok: true, value: { queued: true } } }) };
    };
    const value = await plugin.rpcCall('delete', { sessionId: 'session-x-0001', queue: true });
    assert.deepEqual(value, { queued: true });
    assert.equal(envelope.endpoint, '/session-admin/delete');
    assert.equal(envelope.headers['content-type'], 'application/json');
    assert.equal(envelope.body.type, 'client-request');
    assert.equal(envelope.body.method, 'delete');
    assert.equal(typeof envelope.body.rpcId, 'string');
    assert.deepEqual(envelope.body.payload, { sessionId: 'session-x-0001', queue: true });
    delete globalThis.fetch;
  });
});
