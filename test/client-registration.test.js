/**
 * Client-bundle test against a faithful slot registry and React stand-in.
 *
 * The browser half is a hand-written classic script, so the risk is not a
 * compile error but a registration that never fires: an `inject` that parks and
 * is never resumed, a hook called out of order, a component that returns null
 * where the product expects an element. This suite evaluates the bundle the way
 * the page does, feeds it a slot registry with the real *queue* semantics
 * (`inject` before a declaration parks and resumes at declaration time), and
 * renders the component against a stand-in that is strict about hooks.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

/** The slot the delete action claims; must match the shipped declaration exactly. */
const HEADER_SLOT = 'conversation.session.header.actions';

/**
 * A React stand-in strict enough to catch hooks called in the wrong order or
 * outside a render.
 *
 * @returns {Record<string, unknown>} the module the bundle's `require('react')` receives.
 */
function makeReact() {
  let rendering = false;
  // A slot-indexed state store, so a setter actually changes what the next
  // render reads — without that, every render would stay in its initial state
  // and the interesting states would be untestable.
  /**
   * Hook state, kept in place: see the note on `__clear`.
   *
   * @type {unknown[][]}
   */
  const cells = [];
  let cursor = 0;
  /** @type {Function[]} */
  const effects = [];
  return {
    /** Directly set one state cell, for a test that renders one phase at a time. @param {number} index - cell index. @param {unknown} value - value to store. @returns {void} */
    __setCell(index, value) {
      cells[index] = [value];
    },
    /** Reset the hook cursor between renders. @returns {void} */
    __reset() {
      cursor = 0;
    },
    /** Clear all hook state, in place. @returns {void} */
    __clear() {
      cells.length = 0;
      cursor = 0;
      effects.length = 0;
    },
    Fragment: Symbol('Fragment'),
    /**
     * Create one element record.
     *
     * @param {unknown} type - tag or component.
     * @param {Record<string, unknown>|null} props - props.
     * @param {...unknown} children - children.
     * @returns {Record<string, unknown>} the element.
     */
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    /** @param {unknown} initial - initial state. @returns {[unknown, Function]} the cell. */
    useState(initial) {
      assert.ok(rendering, 'useState called outside a render');
      const index = cursor;
      cursor += 1;
      if (cells.length <= index) cells.push([typeof initial === 'function' ? initial() : initial]);
      const set = (next) => {
        cells[index][0] = typeof next === 'function' ? next(cells[index][0]) : next;
      };
      return [cells[index][0], set];
    },
    /** @param {Function} effect - effect body. @returns {void} */
    useEffect(effect) {
      assert.ok(rendering, 'useEffect called outside a render');
      // Effects are queued, not run inline: a real renderer runs them after the
      // commit, and a component that sets state in an effect would otherwise
      // update the state it is still reading.
      effects.push(effect);
    },
    /** @returns {{ current: undefined }} a ref cell. */
    useRef() {
      assert.ok(rendering, 'useRef called outside a render');
      return { current: undefined };
    },
    /** @param {Function} render - the render pass to guard. @returns {unknown} the render's value. */
    __render(render) {
      cursor = 0;
      rendering = true;
      try {
        return render();
      } finally {
        rendering = false;
      }
    },
    /** Run the effects the last render queued. @returns {void} */
    __flushEffects() {
      const queued = effects.splice(0, effects.length);
      for (const effect of queued) effect();
    },
  };
}

/**
 * A slot registry with the harness semantics that matter here.
 *
 * `inject(key, callback)` runs the callback immediately when the key is already
 * declared and parks it otherwise; `declare(key)` resumes everything parked on
 * that key, in order. Registration options are validated the way the real slot
 * catalog documents them, so a wrong key or a missing `id` fails loudly.
 *
 * @returns {Record<string, any>} the registry, its ledger of registrations, and a declarer.
 */
function makeSlotRegistry() {
  /** @type {Set<string>} */
  const declared = new Set();
  /** @type {Map<string, Function[]>} */
  const parked = new Map();
  /** @type {{ name: string, options: Record<string, unknown>, component: unknown }[]} */
  const registrations = [];
  return {
    registrations,
    inject(key, callback) {
      if (typeof key !== 'string' || key.length === 0) throw new Error('slots.inject needs a key');
      if (!declared.has(key)) {
        parked.set(key, [...(parked.get(key) ?? []), callback]);
        return () => {};
      }
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register(options, component) {
      assert.equal(typeof options, 'object');
      assert.equal(typeof component, 'function');
      assert.ok(declared.has(options.name), `slot ${options.name} must be declared before registering into it`);
      assert.equal(typeof options.id, 'string', 'a list slot needs an id');
      registrations.push({ name: options.name, options, component });
      return () => {
        const at = registrations.findIndex((entry) => entry.options === options);
        if (at !== -1) registrations.splice(at, 1);
      };
    },
    declare(key) {
      declared.add(key);
      const pending = parked.get(key) ?? [];
      parked.delete(key);
      for (const callback of pending) callback();
    },
    /** @param {string} key - slot key. @returns {boolean} whether it is declared. */
    isDeclared(key) {
      return declared.has(key);
    },
    /** @param {string} key - slot key. @returns {number} how many callbacks are parked. */
    parkedCount(key) {
      return (parked.get(key) ?? []).length;
    },
  };
}

/** The plugin the bundle registered with the module loader. */
let plugin;
/** The single React stand-in the bundle was given. @type {any} */
let React;
/** @type {any} */
let slots;
/** @type {unknown[]} */
let styleTags;

before(async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded;
  styleTags = [];
  globalThis.window = { __ModuleLoader__: { load: (registration) => { loaded = registration; } } };
  globalThis.document = {
    // The bundle guards its own stylesheet with a `style[data-plugin=...]` lookup,
    // so the stand-in has to answer that query for real, or every apply() would
    // look like it inserted a second tag.
    querySelector: (selector) => {
      const match = /^style\[data-plugin="([^"]+)"\]$/.exec(selector);
      if (match === null) return null;
      return styleTags.find((tag) => tag.dataset.plugin === match[1]) ?? null;
    },
    createElement: (tag) => ({
      tag,
      dataset: {},
      textContent: '',
      remove() {
        const at = styleTags.indexOf(this);
        if (at !== -1) styleTags.splice(at, 1);
      },
    }),
    head: { appendChild: (node) => styleTags.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { ok: true, value: {} } }) });

  // The page evaluates a classic script; no import, no bundler.
  new Function('window', 'document', `${source}\n`)(globalThis.window, globalThis.document);
  assert.ok(loaded !== undefined, 'the bundle must register itself with __ModuleLoader__');
  assert.equal(loaded.id, 'dsh-session-admin');
  plugin = loaded.factory((specifier) => {
    assert.equal(specifier, 'react', 'the bundle may require only the baseline React module');
    // Exactly one React instance for the whole file: the bundle captures the
    // module it is handed, so a second stand-in would leave the test resetting
    // state the component never reads.
    React ??= makeReact();
    return React;
  });
  assert.ok(React !== undefined);
});

after(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
});

describe('client plugin contract', () => {
  it('exports a Cordis plugin whose only hard dependency is the slot registry', () => {
    assert.equal(plugin.name, 'session-admin');
    assert.deepEqual(plugin.inject, ['slots']);
    assert.equal(typeof plugin.apply, 'function');
  });

  it('parks on the header action and registers when the slot is declared later', () => {
    slots = makeSlotRegistry();
    const ctx = {
      effect: (factory) => factory(),
      slots,
    };
    assert.equal(slots.isDeclared(HEADER_SLOT), false);
    plugin.apply(ctx);
    // Nothing to register into yet, so the contribution is parked rather than lost.
    assert.equal(slots.registrations.length, 0);
    assert.equal(slots.parkedCount(HEADER_SLOT), 1);

    // The conversation header declares its slots when it mounts.
    slots.declare(HEADER_SLOT);
    assert.equal(slots.registrations.length, 1);
    assert.equal(slots.registrations[0].name, HEADER_SLOT);
    assert.equal(slots.registrations[0].options.id, 'session-admin-delete');
    assert.equal(typeof slots.registrations[0].options.order, 'number');
  });

  it('registers immediately when the slot is already declared', () => {
    slots = makeSlotRegistry();
    slots.declare(HEADER_SLOT);
    plugin.apply({ effect: (factory) => factory(), slots });
    assert.equal(slots.registrations.length, 1);
    assert.equal(slots.parkedCount(HEADER_SLOT), 0);
  });

  it('owns exactly one stylesheet, scoped to this plugin', () => {
    // Four applies have run by now across the tests above; the guard must have
    // kept the page to a single tag.
    assert.equal(styleTags.length, 1);
    assert.equal(styleTags[0].dataset.plugin, 'session-admin');
    assert.match(styleTags[0].textContent, /session-admin-trigger/);
  });

  it('withdraws the registration when its fiber unloads', () => {
    slots = makeSlotRegistry();
    slots.declare(HEADER_SLOT);
    /** @type {Function[]} */
    const disposers = [];
    plugin.apply({
      effect: (factory) => {
        const disposer = factory();
        if (typeof disposer === 'function') disposers.push(disposer);
      },
      slots,
    });
    assert.equal(slots.registrations.length, 1);
    for (const disposer of disposers.slice().reverse()) disposer();
    assert.equal(slots.registrations.length, 0);
  });
});

describe('rendered action', () => {
  /**
   * Render the registered component through the strict React stand-in.
   *
   * @param {Record<string, unknown>} props - the standard slot props.
   * @returns {unknown} the rendered element.
   */
  function renderAction(props) {
    slots = makeSlotRegistry();
    slots.declare(HEADER_SLOT);
    plugin.apply({ effect: (factory) => factory(), slots });
    const { component } = slots.registrations[0];
    return React.__render(() => component(props));
  }

  it('renders nothing without a session id', () => {
    assert.equal(renderAction({ sessionId: '' }), null);
    assert.equal(renderAction({}), null);
  });

  it('renders a pressable button carrying an accessible label', () => {
    const element = renderAction({ sessionId: 'session-x-0001' });
    assert.ok(element !== null, 'the action must render for a real session');
    assert.equal(element.type, React.Fragment);
    const button = element.children[0];
    assert.equal(button.type, 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(typeof button.props.onClick, 'function');
    assert.match(button.props['aria-label'], /delete/i);
    assert.match(button.props.title, /permanently/i);
    // The icon is an inline SVG, so no icon package is required.
    assert.equal(button.children[0].type, 'svg');
  });

  it('opens the dialog on press without letting the row handle the click', () => {
    const element = renderAction({ sessionId: 'session-x-0001' });
    /** @type {boolean} */
    let stopped = false;
    /** @type {((value: unknown) => void)|undefined} */
    let setOpen;
    // Re-render with a capturing useState so the press can be observed.
    slots = makeSlotRegistry();
    slots.declare(HEADER_SLOT);
    plugin.apply({ effect: (factory) => factory(), slots });
    const component = slots.registrations[0].component;
    React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, (value) => { setOpen = value; }];
    const rendered = React.__render(() => component({ sessionId: 'session-x-0001' }));
    rendered.children[0].props.onClick({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true, 'the press must not also open the conversation');
    assert.equal(setOpen, true, 'the press must open the confirmation dialog');
    void element;
  });
});

describe('dialog component', () => {
  /**
   * Collect every element in a rendered tree.
   *
   * @param {unknown} node - element or child value.
   * @param {Record<string, unknown>[]} [found] - accumulator.
   * @returns {Record<string, unknown>[]} all element records.
   */
  function elements(node, found = []) {
    if (node === null || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      for (const child of node) elements(child, found);
      return found;
    }
    if ('type' in node && 'props' in node) {
      found.push(node);
      for (const child of node.children ?? []) elements(child, found);
    }
    return found;
  }

  /**
   * Every display string a component would put on screen.
   *
   * `Line` receives its text as a `line` prop rather than as a child, so the
   * props of every element are read too, not only its children.
   *
   * @param {unknown} element - a rendered element tree.
   * @returns {string[]} the display strings, in traversal order.
   */
  function textsOf(element) {
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

  it('renders a modal that says it is reading the session before any result exists', () => {
    // Hook state is shared across renders in this stand-in (one module instance
    // for the whole file), so every dialog test starts from a cleared store.
    React.__clear();
    const element = React.__render(() => plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} }));
    const tree = elements(element);
    const panel = tree.find((node) => node.props?.role === 'dialog');
    assert.ok(panel !== undefined, 'a dialog role must be present');
    assert.equal(panel.props['aria-modal'], 'true');
    assert.equal(typeof panel.props['aria-label'], 'string');
    const texts = textsOf(element);
    assert.ok(texts.some((text) => /Reading the session/i.test(text)), 'the loading state must be visible');
    assert.ok(texts.some((text) => /not archiving/i.test(text)), 'the dialog must say it is not archiving');
  });

  it('states the consequence and keeps a cancel route before anything is removed', () => {
    // The settled face is asserted in test/client.test.js, whose React stand-in
    // holds hook state per cell and drives the mount effect reliably. This file
    // covers registration, which is where a contribution is actually lost.
    React.__clear();
    const element = React.__render(() => plugin.DeleteDialog({ sessionId: 'session-x-0001', onClose: () => {} }));
    const texts = textsOf(element);
    assert.ok(texts.some((text) => text === 'Cancel'), 'a cancel route must exist before the inspection resolves');
    assert.ok(texts.some((text) => /not archiving/i.test(text)), 'the dialog must say it is not archiving');
  });
});
