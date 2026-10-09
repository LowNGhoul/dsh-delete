/**
 * Plugin configuration: defaults, and the normalization applied to a resolved
 * config object.
 *
 * Deliberately *not* a Cordis `Config` schema. A Cordis plugin whose config is
 * declared must export a Standard Schema (schemastery/zod), and a plain
 * descriptor object makes the loader throw during resolution, which would take
 * the whole profile down at boot. This package therefore keeps the same shape
 * the other dsh plugins in the wild use: no declared schema, defaults applied
 * in `apply`, and every value validated where it is used.
 *
 * @module dsh-session-admin/config
 */

/** Every option, its default, and what it does. */
/**
 * Every option that has a default, and what it does.
 *
 * The layout fields (`dshHome`, `sessionsRoot`, `storagesRoot`) are deliberately
 * absent rather than present-as-`undefined`: their real default is "resolve it
 * the way dsh does", and a key whose value is `undefined` is still a key — a
 * caller that spreads these defaults over a real `dshHome` would blank it.
 */
export const DEFAULTS = {
  /** Move bytes into a trash directory instead of unlinking them. */
  backup: false,
  /** Register the human `/delete` command. */
  enableCommand: true,
  /** Name of the registered command, without the leading slash. */
  commandName: 'delete',
  /** Serve the browser RPC channel. */
  enableRpc: true,
  /** Write the append-only deletion ledger and finish-on-close journals. */
  journal: true,
  /** Complete a queued deletion as soon as its session stops being live. */
  finishOnClose: true,
};

/** Command names this plugin will register; anything else falls back to the default. */
const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Normalize one resolved config object.
 *
 * A config value arrives from a YAML patch layer, so it is treated as untrusted
 * input: a wrong type keeps the default rather than propagating into a path or
 * a command name.
 *
 * @param {unknown} raw - the config Cordis resolved, if any.
 * @returns {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string, backup: boolean, enableCommand: boolean, commandName: string, enableRpc: boolean, journal: boolean, finishOnClose: boolean }} the effective config.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /**
   * Read a non-empty string, or fall back.
   *
   * @param {unknown} value - candidate.
   * @param {string|undefined} fallback - value to use when absent.
   * @returns {string|undefined} the accepted value.
   */
  const str = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback);
  /**
   * Read a boolean, or fall back.
   *
   * @param {unknown} value - candidate.
   * @param {boolean} fallback - value to use when absent.
   * @returns {boolean} the accepted value.
   */
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const commandName = str(input.commandName, DEFAULTS.commandName);
  return {
    dshHome: str(input.dshHome, undefined),
    sessionsRoot: str(input.sessionsRoot, undefined),
    storagesRoot: str(input.storagesRoot, undefined),
    backup: bool(input.backup, DEFAULTS.backup),
    enableCommand: bool(input.enableCommand, DEFAULTS.enableCommand),
    commandName: COMMAND_NAME_RE.test(String(commandName)) ? String(commandName) : DEFAULTS.commandName,
    enableRpc: bool(input.enableRpc, DEFAULTS.enableRpc),
    journal: bool(input.journal, DEFAULTS.journal),
    finishOnClose: bool(input.finishOnClose, DEFAULTS.finishOnClose),
  };
}
