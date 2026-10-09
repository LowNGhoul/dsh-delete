/**
 * Host half of `dsh-session-admin`: the durable deletion capability.
 *
 * The host owns three things the browser must not:
 *
 * - **Authority.** `ctx.sessionAdmin` is the only component allowed to remove a
 *   stored session, and it is the component that knows which sessions a live
 *   agent still owns.
 * - **Fan-out.** Removing a log is not enough: the workspace registry, the
 *   projection cache, and the archive set all hold per-session state that has
 *   to go in the same operation. That is what {@link ../engine.js} does.
 * - **Transport.** The browser reaches this service over the authenticated
 *   `/session-admin` RPC channel that `dsh-client-connection` already guards
 *   with its Host/Origin fence and browser cookie, so no second authentication
 *   story is invented here.
 *
 * Nothing in this module reads a session body, keeps a session value, or holds
 * a Service reference across an await beyond the call that needs it.
 *
 * @module dsh-session-admin
 */

import path from 'node:path';

import {
  PACKAGE_NAME,
  PLUGIN_NAME,
  RPC_CHANNEL,
  RPC_DELETE,
  RPC_INSPECT,
  RPC_PENDING,
  RPC_STORE,
} from './constants.js';
import {
  deleteSession,
  inspectSession,
  isSessionId,
  listPendingDeletions,
  locateArtifacts,
  readProjectionTitle,
  resolveLayout,
  summarizeStore,
} from './engine.js';
import { InvalidOptionError, SessionAdminError, SessionNotFoundError } from './errors.js';
import {
  describeDeletion,
  formatBytes,
  summarizeDeletionForBrowser,
  summarizeInspectionForBrowser,
} from './report.js';

/** Cordis plugin name. */
export const name = PLUGIN_NAME;

/**
 * Hard dependencies. Each one is a peer this plugin cannot degrade without:
 * without `sessions` there is no live/cold boundary to respect, without
 * `sessionPersistence` there is no store to delete from, and without
 * `storageDomain` the projection and workspace state cannot be reached at all.
 */
export const inject = ['sessions', 'sessionPersistence', 'storageDomain'];

/** Longest id a request may carry, so a body cannot become a path probe. */
const MAX_ID_BYTES = 128;

export { PACKAGE_NAME, RPC_CHANNEL, RPC_DELETE, RPC_INSPECT, RPC_PENDING, RPC_STORE };

/**
 * Plugin configuration.
 *
 * Every value here is a policy the deployment may disagree with, which is why
 * the schema states it rather than hardcoding it.
 */
export const Config = {
  /** Explicit harness home; unset follows `$DSH_HOME` then `~/.dsh`. */
  dshHome: { type: 'string' },
  /** Explicit sessions root; unset follows `<dshHome>/sessions`. */
  sessionsRoot: { type: 'string' },
  /** Explicit storages root; unset follows `<dshHome>/storages`. */
  storagesRoot: { type: 'string' },
  /** Move bytes into a trash directory instead of unlinking them. */
  backup: { type: 'boolean', default: false },
  /** Register the human `/delete` command. */
  enableCommand: { type: 'boolean', default: true },
  /** Name of the registered command, without the leading slash. */
  commandName: { type: 'string', default: 'delete' },
  /** Serve the browser RPC channel. */
  enableRpc: { type: 'boolean', default: true },
  /** Write the append-only deletion ledger and finish-on-close journals. */
  journal: { type: 'boolean', default: true },
  /**
   * Complete a queued deletion as soon as its session stops being live. A
   * session marked while open is removed when the agent releases it, which is
   * the only moment the store can hand it over safely.
   */
  finishOnClose: { type: 'boolean', default: true },
};

/* ──────────────────────────────── helpers ────────────────────────────────── */

/**
 * Build a `ConnectionRpcResult` success envelope.
 *
 * @param {unknown} value - JSON-serializable business value.
 * @returns {{ ok: true, value: unknown }} the envelope.
 */
function rpcOk(value) {
  return { ok: true, value };
}

/**
 * Build a `ConnectionRpcResult` failure envelope from any thrown value.
 *
 * A failure that this package raised deliberately keeps its stable code; any
 * other failure becomes `internal` so an unexpected error cannot be mistaken
 * for a policy decision.
 *
 * @param {unknown} error - the rejected value.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the envelope.
 */
function rpcFailure(error) {
  if (error instanceof SessionAdminError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details ?? {} } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'SESSION_ADMIN_INTERNAL', message, details: {} } };
}

/**
 * Read one field from an untrusted payload without trusting its shape.
 *
 * @param {unknown} payload - decoded request body.
 * @param {string} field - field name.
 * @returns {unknown} the field value, or undefined.
 */
function field(payload, field_) {
  if (payload === null || typeof payload !== 'object') return undefined;
  return /** @type {Record<string, unknown>} */ (payload)[field_];
}

/**
 * Accept only a well-formed session id from a wire payload.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} the accepted id.
 * @throws {InvalidOptionError} when the value cannot be a session id.
 */
function requireId(value) {
  if (typeof value !== 'string') throw new InvalidOptionError('sessionId must be a string', { received: typeof value });
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES) {
    throw new InvalidOptionError(`sessionId must be 1..${MAX_ID_BYTES} bytes`, { bytes: Buffer.byteLength(value, 'utf8') });
  }
  if (!isSessionId(value)) throw new InvalidOptionError('sessionId contains characters a session id cannot contain', {});
  return value;
}

/* ──────────────────────────────── service ────────────────────────────────── */

/**
 * The host's session-administration capability.
 *
 * The class deliberately exposes the store as *operations*, not as data: a
 * caller may ask what a deletion would remove, ask for the deletion, or ask
 * what was queued. It never receives a session object, an event, or a handle.
 */
export class SessionAdmin {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
   * @param {Record<string, any>} config - validated plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.layout = resolveLayout({
      dshHome: config.dshHome,
      sessionsRoot: config.sessionsRoot,
      storagesRoot: config.storagesRoot,
    });
    /** @type {Map<string, { sessionId: string, requestedAt: string, at: number, by: string }>} */
    this.queued = new Map();
    /** @type {boolean} */
    this.settling = false;
  }

  /**
   * Whether a live agent currently owns this session.
   *
   * This is the one fact the engine cannot know: a live session's log has an
   * open write handle and its agent may append at any moment, so deleting it
   * out from under the process would lose whatever it writes next.
   *
   * @param {string} sessionId - session to test.
   * @returns {boolean} true when this process still holds the session.
   */
  isLive(sessionId) {
    try {
      if (this.ctx.get('agents')?.get(sessionId) !== undefined) return true;
    } catch {
      // A registry that cannot answer is not evidence of liveness.
    }
    try {
      return this.ctx.get('sessions')?.get(sessionId) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Every session id this process currently holds live.
   *
   * Read through `ctx.get` rather than an injected property: the service is
   * built once for the plugin's own fiber, where the injected keys are not
   * available as properties, and the registries are optional peers — a
   * composition without them still deletes cold sessions.
   *
   * @returns {string[]} live session ids.
   */
  liveSessionIds() {
    try {
      return (this.ctx.get('sessions')?.list() ?? []).map((session) => session.id);
    } catch {
      return [];
    }
  }

  /**
   * Enumerate the sessions a deletion can currently reach.
   *
   * Reads only headers and cache titles: never a log body, never a live
   * session object.
   *
   * @param {{ limit?: number, search?: string }} [options] - paging and filtering.
   * @returns {Promise<{ sessions: { id: string, title: string|null, cwd: string|null, createdAt: number|null, bytes: number, live: boolean, logs: number, projections: number }[], total: number, live: string[] }>} the listing.
   */
  async listSessions(options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 500) : 200;
    const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return { sessions: [], total: 0, live: [] };
    const snapshots = await persistence.list();
    const live = new Set(this.liveSessionIds());
    /** @type {{ id: string, title: string|null, cwd: string|null, createdAt: number|null, bytes: number, live: boolean, logs: number, projections: number }[]} */
    const rows = [];
    for (const snapshot of snapshots) {
      const id = String(snapshot.header?.id ?? snapshot.id ?? '');
      if (id.length === 0 || !isSessionId(id)) continue;
      if (search.length > 0 && !id.toLowerCase().includes(search)) continue;
      const cwd = typeof snapshot.header?.cwd === 'string' ? snapshot.header.cwd : null;
      if (search.length > 0 && !(cwd ?? '').toLowerCase().includes(search)) continue;
      rows.push({
        id,
        title: null,
        cwd,
        createdAt: typeof snapshot.header?.createdAt === 'number' ? snapshot.header.createdAt : null,
        bytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : 0,
        live: live.has(id),
        logs: 0,
        projections: 0,
      });
    }
    rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
    const page = rows.slice(0, limit);
    // Titles live in the projection cache; only the page pays for them.
    await Promise.all(page.map(async (row) => {
      const located = await locateArtifacts({ id: row.id, layout: this.layout }).catch(() => undefined);
      if (located === undefined) return;
      row.logs = located.logFiles.length;
      row.projections = located.projectionFiles.length;
      row.bytes = located.bytes;
      if (located.projectionFiles[0] !== undefined) {
        row.title = (await readProjectionTitle(located.projectionFiles[0])) ?? null;
      }
    }));
    return { sessions: page, total: rows.length, live: [...live] };
  }

  /**
   * Describe what deleting one session would remove.
   *
   * @param {string} sessionId - the session to inspect.
   * @param {{ signal?: AbortSignal }} [options] - optional cancellation.
   * @returns {Promise<Record<string, unknown>>} the inspection report.
   */
  async inspect(sessionId, options = {}) {
    return inspectSession({
      id: requireId(sessionId),
      ...this.layoutOptions(),
      live: (id) => this.isLive(id),
      signal: options.signal,
    });
  }

  /**
   * Permanently delete one session.
   *
   * A live session is refused rather than deleted: its agent owns the log. The
   * caller may instead queue it with {@link queue}, which completes the moment
   * the store releases it.
   *
   * @param {string} sessionId - the session to delete.
   * @param {{ backup?: boolean, journal?: boolean, signal?: AbortSignal, live?: boolean }} [options] - per-call overrides.
   * @returns {Promise<Record<string, unknown>>} the deletion report.
   * @throws {SessionNotFoundError} when no stored session matches.
   * @throws {import('./errors.js').LiveSessionError} when the session is live.
   */
  async delete(sessionId, options = {}) {
    const id = requireId(sessionId);
    const report = await deleteSession({
      id,
      ...this.layoutOptions(),
      live: options.live ?? ((candidate) => this.isLive(candidate)),
      backup: options.backup ?? this.config.backup === true,
      journal: options.journal ?? this.config.journal !== false,
      signal: options.signal,
    });
    this.queued.delete(id);
    this.ctx.emit('session/admin-deleted', {
      sessionId: id,
      title: typeof report.title === 'string' ? report.title : null,
      bytesRemoved: Number(report.bytesRemoved ?? 0),
      removedCount: Array.isArray(report.removedPaths) ? report.removedPaths.length : 0,
    });
    return report;
  }

  /**
   * Queue a live session for deletion when it closes.
   *
   * Queuing is the honest answer for "delete the conversation I am reading":
   * the log cannot be removed while an agent owns it, and silently deferring is
   * worse than saying so. The queue is durable only for the life of the
   * process, and the queue is re-checked whenever any session is disposed.
   *
   * @param {string} sessionId - the session to queue.
   * @param {{ by?: string }} [options] - who asked, for the audit line.
   * @returns {Promise<{ queued: boolean, sessionId: string, live: boolean, reason?: string }>} queue outcome.
   */
  async queue(sessionId, options = {}) {
    const id = requireId(sessionId);
    const inspection = await this.inspect(id);
    if (inspection.live !== true) {
      // It stopped being live between the click and this call: delete it now
      // rather than reporting a queue entry the user would have to revisit.
      const report = await this.delete(id, { live: false });
      return { queued: false, sessionId: id, live: false, reason: 'deleted', report: summarizeDeletionForBrowser(report) };
    }
    this.queued.set(id, {
      sessionId: id,
      requestedAt: new Date().toISOString(),
      at: Date.now(),
      by: typeof options.by === 'string' ? options.by : 'user',
    });
    this.ctx.emit('session/admin-queued', { sessionId: id });
    return { queued: true, sessionId: id, live: true };
  }

  /**
   * Drop one queued deletion.
   *
   * @param {string} sessionId - the queued session.
   * @returns {boolean} whether an entry was removed.
   */
  unqueue(sessionId) {
    const id = requireId(sessionId);
    const removed = this.queued.delete(id);
    if (removed) this.ctx.emit('session/admin-unqueued', { sessionId: id });
    return removed;
  }

  /**
   * Read the queue.
   *
   * @returns {{ sessionId: string, requestedAt: string, at: number, by: string, live: boolean }[]} queued deletions, oldest first.
   */
  listQueued() {
    return [...this.queued.values()]
      .map((entry) => ({ ...entry, live: this.isLive(entry.sessionId) }))
      .sort((left, right) => left.at - right.at);
  }

  /**
   * Report totals for the store this service administers.
   *
   * @returns {Promise<Record<string, unknown>>} store totals plus queue length.
   */
  async storeSummary() {
    const totals = await summarizeStore(this.layoutOptions());
    return {
      ...totals,
      live: this.liveSessionIds().length,
      queued: this.queued.size,
      backup: this.config.backup === true,
    };
  }

  /**
   * Find deletions that were journalled but never finished.
   *
   * @returns {Promise<Record<string, unknown>[]>} unfinished operations.
   */
  async listPending() {
    return listPendingDeletions(this.layoutOptions());
  }

  /**
   * Complete every queued deletion whose session is no longer live.
   *
   * Called on each `session/disposed` and once when the plugin unloads, so a
   * session marked while open is removed as soon as the store lets go of it. A
   * failure is contained per session: one unremovable session must not strand
   * the rest of the queue.
   *
   * @returns {Promise<{ settled: { sessionId: string, bytesRemoved: number }[], failed: { sessionId: string, code: string, message: string }[] }>} what settled.
   */
  async settleQueued() {
    /** @type {{ sessionId: string, bytesRemoved: number }[]} */
    const settled = [];
    /** @type {{ sessionId: string, code: string, message: string }[]} */
    const failed = [];
    if (this.settling) return { settled, failed };
    this.settling = true;
    try {
      for (const entry of [...this.queued.values()]) {
        if (this.isLive(entry.sessionId)) continue;
        try {
          const report = await this.delete(entry.sessionId, { live: false });
          settled.push({ sessionId: entry.sessionId, bytesRemoved: Number(report.bytesRemoved ?? 0) });
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            this.queued.delete(entry.sessionId);
            continue;
          }
          this.queued.delete(entry.sessionId);
          failed.push({
            sessionId: entry.sessionId,
            code: error instanceof SessionAdminError ? error.code : 'SESSION_ADMIN_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          });
          this.ctx.logger?.warn?.(
            `session-admin: could not finish queued deletion of ${entry.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      this.settling = false;
    }
    return { settled, failed };
  }

  /**
   * Resolve one queue or listing entry to a human line.
   *
   * @param {string} sessionId - the session.
   * @returns {string} one line naming the session.
   */
  describeSession(sessionId) {
    const entry = this.queued.get(sessionId);
    return entry === undefined ? sessionId : `${sessionId} (queued ${entry.requestedAt})`;
  }

  /**
   * Layout overrides handed to the engine, never the resolved layout object.
   *
   * @returns {{ dshHome: string }} the harness home the engine should use.
   */
  layoutOptions() {
    return { dshHome: this.layout.dshHome };
  }
}

/* ──────────────────────────────── plugin ─────────────────────────────────── */

/**
 * Resolve the session a command invocation is acting on.
 *
 * @param {unknown} agent - the receiving agent.
 * @returns {string|undefined} its session id, when the agent exposes one.
 */
function agentSessionId(agent) {
  const session = /** @type {{ session?: { id?: unknown } }|undefined} */ (agent)?.session;
  return typeof session?.id === 'string' ? session.id : undefined;
}

/**
 * Render a settled deletion as command output.
 *
 * @param {Record<string, unknown>} report - the deletion report.
 * @returns {string} the text the command surface shows.
 */
function commandText(report) {
  return describeDeletion(report).join('\n');
}

/**
 * Host plugin body: build the service, then wire the transports that expose it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {Record<string, any>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const admin = new SessionAdmin(ctx, config);
  ctx.effect(() => ctx.provide('sessionAdmin', admin), 'session-admin: service');

  if (config.finishOnClose !== false) {
    ctx.on('session/disposed', () => {
      admin.settleQueued().catch(() => {});
    });
    ctx.effect(() => () => {
      admin.settleQueued().catch(() => {});
    }, 'session-admin: drain the queue on unload');
  }

  if (config.enableCommand !== false) {
    const commandName = typeof config.commandName === 'string' && /^[a-z][a-z0-9-]*$/.test(config.commandName)
      ? config.commandName
      : 'delete';
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: commandName,
        description: 'Permanently delete a stored session (its log, its projection record, and its workspace rows)',
        input: { hint: '[session-id]' },
        handler: async ({ agent, rawInput }) => {
          const requested = rawInput.trim();
          const id = requested.length > 0 ? requested : agentSessionId(agent);
          if (id === undefined || id.length === 0) {
            return { kind: 'error', text: 'No session id given and this session has no id to fall back to. Usage: /delete <session-id>' };
          }
          try {
            const report = await admin.delete(id);
            return { kind: 'success', text: commandText(report) };
          } catch (error) {
            if (error instanceof SessionAdminError && error.code === 'SESSION_ADMIN_LIVE_SESSION') {
              const queued = await admin.queue(id, { by: 'command' }).catch(() => undefined);
              if (queued?.queued === true) {
                return {
                  kind: 'success',
                  text: `Session ${id} is open right now, so it cannot be removed yet. It is queued and will be deleted as soon as it closes.\nUse /${commandName} again after switching to another session, or restart dsh and run: dsh-session-admin delete ${id}`,
                };
              }
            }
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
          }
        },
      });
    });
  }

  if (config.enableRpc !== false) {
    ctx.inject(['connection'], (connectionCtx) => {
      const dispose = connectionCtx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {
        try {
          switch (endpoint) {
            case RPC_STORE:
              return rpcOk(await admin.storeSummary());
            case RPC_PENDING:
              return rpcOk({ queued: admin.listQueued(), unfinished: await admin.listPending() });
            case RPC_INSPECT: {
              const report = await admin.inspect(requireId(field(payload, 'sessionId')), { signal });
              return rpcOk(summarizeInspectionForBrowser(report));
            }
            case RPC_DELETE: {
              const id = requireId(field(payload, 'sessionId'));
              if (field(payload, 'queue') === true) {
                const outcome = await admin.queue(id, { by: 'browser' });
                return rpcOk({ queued: outcome.queued, sessionId: id, reason: outcome.reason ?? null, report: outcome.report ?? null });
              }
              const report = await admin.delete(id, { signal });
              return rpcOk({
                queued: false,
                sessionId: id,
                report: summarizeDeletionForBrowser(report),
                lines: describeDeletion(report),
              });
            }
            default:
              return rpcFailure(new InvalidOptionError(`unknown session-admin endpoint ${JSON.stringify(endpoint)}`, { endpoint }));
          }
        } catch (error) {
          return rpcFailure(error);
        }
      });
      connectionCtx.effect(() => () => dispose(), 'session-admin: rpc channel');
    });
  }

  ctx.logger?.info?.(
    `session-admin: ready (home ${path.basename(admin.layout.dshHome)}, backup ${config.backup === true ? 'on' : 'off'})`,
  );
}

export { formatBytes };
export default { name, inject, Config, apply };
