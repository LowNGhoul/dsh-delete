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

  /**
   * Hook state.
   *
   * The arrays are `const` and cleared in place. Replacing them would leave the
   * `useState` closure writing into a detached array, so the next render would
   * read nothing and a test would fail for a reason that has nothing to do with
   * the bundle.
   *
   * @type {unknown[][]}
   */
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
    /** Clear hook state between tests, in place. @returns {void} */
    __clear() {
      states.length = 0;
      cursor = 0;
      effects.length = 0;
    },
    /** Effects registered during the last render. @returns {Function[]} the effect bodies. */
    __effects() {
      return effects.splice(0, effects.length);
    },
  };
})();

/**
 * Find one button by the text it renders.
 *
 * @param {unknown} element - a rendered element tree.
 * @param {RegExp} pattern - the label to match.
 * @returns {{ props: Record<string, unknown> }|null} the button's props, or null.
 */
function findButton(element, pattern) {
  /** @type {{ props: Record<string, unknown> }|null} */
  let found = null;
  const walk = (node) => {
    if (found !== null || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!('type' in node) || !('props' in node)) return;
    if (node.type === 'button' && pattern.test(collectText(node).join(' '))) found = { props: node.props };
    for (const child of node.children ?? []) walk(child);
  };
  walk(element);
  return found;
}

/**
 * Every display string in a rendered element tree.
 *
 * Reads a component's own `line` prop as well as its children, because the
 * dialog hands each consequence line to a small `Line` component.
 *
 * @param {unknown} element - a rendered element tree.
 * @returns {string[]} the display strings.
 */
function collectText(element) {
  /** @type {string[]} */
  const found = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!('type' in node) || !('props' in node)) return;
    if (typeof node.props.line === 'string') found.push(node.props.line);
    if (typeof node.props.children === 'string') found.push(node.props.children);
    for (const child of node.children ?? []) walk(child);
  };
  walk(element);
  return found;
}

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
    if (specifier === 'react') return ReactStub;
    if (specifier === 'react-dom') {
      return {
        createPortal: (element, container) => ({ type: 'portal', props: { element, container }, children: [] }),
      };
    }
    assert.fail(`unexpected runtime import: ${specifier}`);
  });
});

after(() => {
  delete globalThis.window;
  delete globalThis.document;
});

describe('client bundle', () => {
  it('exports an ordinary Cordis plugin declaring the slot registry and locale', () => {
    assert.equal(plugin.name, 'session-admin');
    assert.deepEqual(plugin.inject, ['slots', 'locale']);
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

  it('renders the action and dialog copy in Chinese when the locale selects it', async () => {
    /** Translate through the bundle's own Chinese dictionary. @param {string} key - dictionary key. @param {Record<string, unknown>} [params] - placeholders. @returns {string} Chinese text. */
    const t = (key, params = {}) => (plugin.DICTIONARIES.zh[key] ?? key)
      .replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    ReactStub.__clear();
    ReactStub.__reset();
    const action = plugin.DeleteSessionAction({ sessionId: 'session-x-0001', t });
    assert.equal(action.children[0].props.title, '永久删除此会话');
    assert.equal(action.children[0].props['aria-label'], '永久删除此会话');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: {
            sessionId: 'session-x-0001',
            title: '中文会话',
            cwd: '/tmp/中文项目',
            live: false,
            bytesRemoved: 2048,
            logCount: 1,
            projectionCount: 1,
            workspaceCount: 1,
            workspaces: [{ title: '中文工作区', path: '/tmp/中文项目' }],
            clearedArchive: false,
            clearedPin: false,
            scheduledTaskCount: 0,
            attachmentCount: 0,
            searchIndex: null,
            lines: [],
          },
        },
      }),
    });
    ReactStub.__clear();
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {}, t });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    ReactStub.__reset();
    const element = plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {}, t });
    const texts = collectText(element);
    assert.ok(texts.includes('永久删除此会话'));
    assert.ok(texts.includes('正在读取会话…') || texts.some((text) => /会话：session-x-0001/.test(text)));
    assert.ok(texts.some((text) => text.includes('会话：session-x-0001')));
    assert.ok(texts.some((text) => text.includes('标题：中文会话')));
    assert.ok(texts.some((text) => text.includes('占用大小：2.0 KiB')));
    assert.ok(texts.some((text) => text.includes('工作区记录：中文工作区 (/tmp/中文项目)')));
    assert.ok(texts.includes('此操作无法撤销。'));
    assert.ok(texts.includes('取消'));
    assert.ok(texts.includes('永久删除'));
    delete globalThis.fetch;
  });

  it('renders the settled-deletion lines in Chinese from the structured report', async () => {
    /** Translate through the bundle's own Chinese dictionary. @param {string} key - dictionary key. @param {Record<string, unknown>} [params] - placeholders. @returns {string} Chinese text. */
    const t = (key, params = {}) => (plugin.DICTIONARIES.zh[key] ?? key)
      .replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    let phase = 'inspect';
    globalThis.fetch = async () => {
      if (phase === 'inspect') {
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                sessionId: 'session-x-0001',
                title: '中文会话',
                cwd: '/tmp/中文项目',
                live: false,
                bytesRemoved: 2048,
                logCount: 1,
                projectionCount: 1,
                workspaceCount: 1,
                workspaces: [{ title: '中文工作区', path: '/tmp/中文项目' }],
                clearedArchive: false,
                clearedPin: false,
                scheduledTaskCount: 0,
                attachmentCount: 0,
                searchIndex: null,
                lines: [],
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
              forced: true,
              sessionId: 'session-x-0001',
              report: {
                sessionId: 'session-x-0001',
                title: '中文会话',
                bytesRemoved: 2048,
                removedCount: 4,
                backedUpCount: 0,
                workspaceCount: 1,
                clearedArchive: false,
                clearedPin: false,
                scheduledTasksRemoved: 0,
                attachmentCount: 0,
              },
              lines: ['Permanently deleted from the host'],
            },
          },
        }),
      };
    };
    ReactStub.__clear();
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {}, t });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    ReactStub.__reset();
    const confirm = findButton(plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {}, t }), /永久删除/);
    assert.ok(confirm !== null);
    phase = 'delete';
    await confirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    ReactStub.__reset();
    const settled = plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {}, t });
    const texts = collectText(settled);
    assert.ok(texts.some((text) => text.includes('已永久删除“中文会话” — session-x-0001。')));
    assert.ok(texts.some((text) => text.includes('已释放 2.0 KiB，涉及 4 个路径。')));
    assert.ok(texts.some((text) => text.includes('已从 1 个工作区记录中移除。')));
    assert.ok(texts.includes('关闭'));
    delete globalThis.fetch;
  });

  it('offers the irreversible action with its consequence once the inspection resolved', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: {
            sessionId: 'session-x-0001',
            title: 'Doomed',
            live: false,
            lines: ['Session: session-x-0001', 'This cannot be undone.'],
          },
        },
      }),
    });
    // Render, let the mount effect settle, then render the state it produced.
    // Each render pass starts a fresh hook cursor: the stand-in has no reconciler
    // to do it, so a test that renders twice must say where each pass begins.
    ReactStub.__clear();
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    ReactStub.__reset();
    const element = plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    const texts = collectText(element);
    assert.ok(texts.includes('Cancel'), 'a cancel control must exist');
    assert.ok(texts.some((text) => /delete permanently/i.test(text)), 'the confirm control must state what it does');
    assert.ok(texts.some((text) => /cannot be undone/i.test(text)), 'the consequence must be shown, not implied');
    delete globalThis.fetch;
  });

  it('states that a live session will be closed, and still offers one press', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: { sessionId: 'session-x-0001', title: 'Open', live: true, lines: ['Session: session-x-0001', 'This cannot be undone.'] },
        },
      }),
    });
    ReactStub.__clear();
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    ReactStub.__reset();
    const element = plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    const texts = collectText(element);
    // Being open is disclosed as a consequence, not turned into a slower path:
    // the deletion still happens on this press.
    assert.ok(texts.some((text) => /you are reading/i.test(text)), 'the open session must be named as such');
    assert.ok(texts.some((text) => /delete permanently/i.test(text)), 'one press must still be enough');
    delete globalThis.fetch;
  });

  it('deletes with force, so the host does not defer it back', async () => {
    /** @type {unknown} */
    let payload;
    globalThis.fetch = async (endpoint, init) => {
      payload = JSON.parse(init.body).payload;
      return {
        ok: true,
        json: async () => ({
          result: { ok: true, value: { queued: false, forced: true, sessionId: 'session-x-0001', lines: ['Permanently deleted.'] } },
        }),
      };
    };
    await plugin.rpcCall('delete', { sessionId: 'session-x-0001', force: true });
    assert.deepEqual(payload, { sessionId: 'session-x-0001', force: true });
    delete globalThis.fetch;
  });

  it('walks loading → confirm → deleted, issuing the delete it names', async () => {
    /** @type {{ method: string, payload: unknown, endpoint: string }[]} */
    const calls = [];
    globalThis.fetch = async (endpoint, init) => {
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, payload: body.payload, endpoint });
      if (body.method === 'inspect') {
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
              forced: true,
              sessionId: 'session-x-0001',
              report: { sessionId: 'session-x-0001', removedCount: 3, bytesRemoved: 2048 },
              lines: ['Permanently deleted "Doomed".'],
            },
          },
        }),
      };
    };

    // Phase 1: mounting issues the inspection.
    ReactStub.__clear();
    ReactStub.__reset();
    plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    for (const effect of ReactStub.__effects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((entry) => entry.endpoint), ['/session-admin/inspect']);
    assert.deepEqual(calls[0].payload, { sessionId: 'session-x-0001' });
    // The URL carries the channel; the envelope's method is the bare endpoint
    // the carrier derives by stripping it.
    assert.equal(calls[0].method, 'inspect');

    // Phase 2: the operator presses the destructive control. Nothing else in
    // this file proves the button is wired to a request, which is the one thing
    // the name of this test promises.
    ReactStub.__reset();
    const settled = plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} });
    const confirm = findButton(settled, /delete permanently/i);
    assert.ok(confirm !== null, 'the confirm control must be rendered once the inspection answered');
    assert.equal(confirm.props.disabled, false, 'it must be pressable once the inspection answered');
    await confirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.map((entry) => entry.endpoint), ['/session-admin/inspect', '/session-admin/delete']);
    assert.deepEqual(calls[1].payload, { sessionId: 'session-x-0001', force: true }, 'the press must ask for the deletion itself');
    assert.equal(calls[1].method, 'delete');
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
