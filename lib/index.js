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

import { readdir } from 'node:fs/promises';

import { DEFAULTS, resolveConfig } from './config.js';
import {
  PACKAGE_NAME,
  PLUGIN_NAME,
  RPC_CHANNEL,
  RPC_DELETE,
  RPC_INSPECT,
  RPC_PENDING,
  RPC_PRESENT,
  RPC_REPAIR,
  RPC_STORE,
  rpcUrl,
} from './constants.js';
import {
  LOG_FILE_RE,
  clearQueueRecord,
  deleteSession,
  inspectSession,
  isSessionId,
  listQueueRecords,
  locateArtifacts,
  readProjectionTitle,
  repairWorkspace,
  resolveLayout,
  settleQueuedDeletions,
  summarizeStore,
  writeQueueRecord,
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

export { PACKAGE_NAME, RPC_CHANNEL, RPC_DELETE, RPC_INSPECT, RPC_PENDING, RPC_PRESENT, RPC_REPAIR, RPC_STORE, rpcUrl };

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
      searchIndex: this.searchIndexPath(),
      signal: options.signal,
    });
  }

  /**
   * The on-disk full-text search index, when this deployment has one.
   *
   * The shipped Web profile runs `dsh-session-query-sqlite` at `:memory:`, so
   * there is nothing to disclose and nothing to clean. A deployment that points
   * `path` at a file keeps a second copy of every session's text in a SQLite
   * database this engine does not write; the deletion report names that file so
   * the operator knows a restart or reindex is what clears it, instead of
   * believing the bytes are already gone.
   *
   * @returns {string|null} the index path, or null when there is no on-disk index.
   */
  searchIndexPath() {
    try {
      const config = this.ctx.get('sessionQuery')?.config;
      const candidate = config?.path;
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate === ':memory:') return null;
      return candidate;
    } catch {
      return null;
    }
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
    await this.repairWorkspaceBookkeeping();
    // `force` is only ever set by a caller that has just shown a human what is
    // about to be removed and been told to proceed. It is what makes the common
    // case — delete the conversation in front of me — one press instead of a
    // queue and a restart.
    const force = options.force === true && this.config.allowLiveDeletion !== false;
    const report = await deleteSession({
      id,
      ...this.layoutOptions(),
      live: options.live ?? ((candidate) => this.isLive(candidate)),
      // Re-asked inside the engine, after the plan exists and before the log is
      // touched: a session that resumes in that window is refused rather than
      // deleted underneath its agent.
      isLiveNow: (candidate) => this.isLive(candidate),
      force,
      backup: options.backup ?? this.config.backup === true,
      journal: options.journal ?? this.config.journal !== false,
      signal: options.signal,
    });
    // A forced deletion of a session this process still holds leaves the store
    // correct and the process inconsistent; the client navigates away, and the
    // agent goes with the next start. Saying so is better than an operator
    // discovering it.
    if (force && this.isLive(id)) {
      this.ctx.emit('session/admin-deleted-while-live', { sessionId: id });
    }
    this.queued.delete(id);
    await clearQueueRecord({ layout: this.layout, sessionId: id }).catch(() => {});
    // The browser removes a row because the harness tells it a session went
    // away, and the harness only says that when it disposes the session itself.
    // A deletion here removes the log without going through that lifecycle, so
    // the removal is announced directly: `api-session/removed` is the event the
    // session controller relays to every client, and it is on the forwarded-event
    // allowlist, so the row leaves the sidebar immediately instead of on the
    // next restart.
    this.ctx.emit('api-session/removed', id);
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
    const by = typeof options.by === 'string' ? options.by : 'user';
    // The record is written before the caller is told the deletion is queued. An
    // in-memory queue would be lost by exactly the event this feature has to
    // survive — the restart that was supposed to let the deletion run.
    await writeQueueRecord({ layout: this.layout, sessionId: id, by, reason: options.reason });
    this.queued.set(id, { sessionId: id, requestedAt: new Date().toISOString(), at: Date.now(), by });
    this.ctx.emit('session/admin-queued', { sessionId: id });
    return { queued: true, sessionId: id, live: true };
  }

  /**
   * Drop one queued deletion.
   *
   * Asynchronous because the durable record has to go with the memory of it: an
   * operator who takes a deferral back must not have it reappear on the next
   * start, and a caller that reads the queue immediately afterwards must see the
   * change. The CLI and the RPC surface both do exactly that.
   *
   * @param {string} sessionId - the queued session.
   * @returns {Promise<boolean>} whether an entry was removed.
   */
  async unqueue(sessionId) {
    const id = requireId(sessionId);
    const removed = this.queued.delete(id);
    try {
      await clearQueueRecord({ layout: this.layout, sessionId: id });
    } catch (error) {
      this.ctx.logger?.warn?.(
        `session-admin: could not clear the deferral record for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
   * Load the durable queue into memory.
   *
   * Called once at startup, before anything can be deleted, so a deferral made
   * in an earlier process is not silently forgotten.
   *
   * @returns {Promise<number>} how many records were loaded.
   */
  async loadQueue() {
    const records = await listQueueRecords(this.layout).catch(() => []);
    for (const record of records) {
      if (record.kind !== 'queued') continue;
      const at = Date.parse(record.requestedAt);
      this.queued.set(record.sessionId, {
        sessionId: record.sessionId,
        requestedAt: record.requestedAt,
        at: Number.isFinite(at) ? at : Date.now(),
        by: record.by || 'user',
      });
    }
    return this.queued.size;
  }

  /**
   * Finish every deferred deletion that this process can finish now.
   *
   * At startup nothing this process owns is live, which is exactly why a
   * deferred deletion is completed here: the operator asked for it, the restart
   * was the step that made it possible, and asking them to remember the request
   * would make the feature a lie.
   *
   * @returns {Promise<{ settled: { sessionId: string, bytesRemoved: number }[], cleared: string[], failed: { sessionId: string, code: string, message: string }[] }>} what happened.
   */
  async finishDeferredDeletions() {
    const outcome = await settleQueuedDeletions({
      dshHome: this.layout.dshHome,
      live: (id) => this.isLive(id),
      backup: this.config.backup === true,
    });
    for (const entry of [...this.queued.keys()]) {
      if (!this.isLive(entry)) this.queued.delete(entry);
    }
    for (const entry of outcome.failed) {
      this.ctx.logger?.warn?.(`session-admin: could not finish the deferred deletion of ${entry.sessionId}: ${entry.message}`);
    }
    if (outcome.settled.length > 0) {
      this.ctx.logger?.info?.(`session-admin: finished ${outcome.settled.length} deferred deletion(s) from an earlier run`);
    }
    return outcome;
  }

  /**
   * Report totals for the store this service administers.
   *
   * @returns {Promise<Record<string, unknown>>} store totals plus queue length.
   */
  /**
   * Which sessions still have a log on disk.
   *
   * The list the harness serves is assembled from an in-memory index and, for a
   * session this process still holds, from the live store entry itself. A forced
   * deletion unlinks the log while the process keeps its in-memory copy, so that
   * list can name a conversation that no longer exists. This asks the
   * filesystem — the only authority on what is still there — and is what lets a
   * caller tell the two apart.
   *
   * @returns {Promise<Set<string>>} ids whose session directory holds a log generation.
   */
  async presentSessionIds() {
    /** @type {Set<string>} */
    const present = new Set();
    let projects;
    try {
      projects = await readdir(this.layout.sessionsRoot, { withFileTypes: true });
    } catch {
      // An absent sessions root means an empty store, not a failed listing.
      return present;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectDir = path.join(this.layout.sessionsRoot, project.name);
      let sessions;
      try {
        sessions = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory() || session.isSymbolicLink()) continue;
        try {
          const files = await readdir(path.join(projectDir, session.name));
          if (files.some((name) => LOG_FILE_RE.test(name))) present.add(session.name);
        } catch {
          // An unreadable directory is not a present session.
        }
      }
    }
    return present;
  }

  /**
   * Report the on-disk session listing over the channel.
   *
   * @returns {Promise<{ present: string[] }>} the ids that still exist.
   */
  async listPresentSessions() {
    return { present: [...(await this.presentSessionIds())] };
  }

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
    const records = await listQueueRecords(this.layoutOptions());
    return records.map((record) => ({
      sessionId: record.sessionId,
      kind: record.kind,
      requestedAt: record.requestedAt || record.startedAt,
      by: record.by,
      remaining: record.remaining.length,
    }));
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
          this.queued.delete(entry.sessionId);
          await clearQueueRecord({ layout: this.layout, sessionId: entry.sessionId }).catch(() => {});
          if (error instanceof SessionNotFoundError) continue;
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
   * Layout overrides handed to the engine.
   *
   * All three roots are forwarded, not just the home: a deployment that points
   * the plugin at a non-default `sessionsRoot` or `storagesRoot` must have that
   * honored by inspection *and* by deletion. Forwarding only the home would let
   * a listing count one store while a deletion edited another, which is a
   * false positive at the metadata level.
   *
   * @returns {{ dshHome: string, sessionsRoot: string, storagesRoot: string }} the resolved layout.
   */
  layoutOptions() {
    return {
      dshHome: this.layout.dshHome,
      sessionsRoot: this.layout.sessionsRoot,
      storagesRoot: this.layout.storagesRoot,
    };
  }

  /**
   * Serve one decoded request on this plugin's channel.
   *
   * The endpoint is a bare name, matching what the shared carrier hands a
   * handler after stripping the channel prefix.
   *
   * @param {string} endpoint - endpoint name.
   * @param {unknown} payload - decoded request body.
   * @param {AbortSignal} [signal] - optional cancellation from the caller.
   * @returns {Promise<{ ok: true, value: unknown }|{ ok: false, error: { code: string, message: string, details: object } }>} the response envelope's result.
   */
  async dispatch(endpoint, payload, signal) {
    try {
      switch (endpoint) {
        case RPC_STORE:
          return rpcOk(await this.storeSummary());
        case RPC_PENDING:
          return rpcOk({
            queued: this.listQueued(),
            unfinished: await this.listPending(),
            repaired: (await this.repairWorkspaceBookkeeping()).repaired,
          });
        case RPC_PRESENT:
          return rpcOk(await this.listPresentSessions());
        case RPC_REPAIR:
          return rpcOk({ repaired: (await this.repairWorkspaceBookkeeping()).repaired });
        case RPC_INSPECT: {
          const report = await this.inspect(requireId(field(payload, 'sessionId')), { signal });
          return rpcOk(summarizeInspectionForBrowser(report));
        }
        case RPC_DELETE: {
          const id = requireId(field(payload, 'sessionId'));
          if (field(payload, 'force') === true) {
            // The browser only sends this after its confirmation panel has shown
            // what will be removed.
            const report = await this.delete(id, { force: true, signal });
            return rpcOk({
              queued: false,
              forced: true,
              sessionId: id,
              report: summarizeDeletionForBrowser(report),
              lines: describeDeletion(report),
            });
          }
          if (field(payload, 'queue') === true) {
            const outcome = await this.queue(id, { by: 'browser' });
            return rpcOk({ queued: outcome.queued, sessionId: id, reason: outcome.reason ?? null, report: outcome.report ?? null });
          }
          const report = await this.delete(id, { signal });
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
  }

  /**
   * Re-apply past deletions to the workspace registry file.
   *
   * The running harness holds the workspace unit in memory and rewrites the
   * whole document on its next unrelated mutation, which can restore an id this
   * service already removed from the file. Re-applying the ledger is cheap,
   * idempotent, and turns "a ghost may come back" into "a ghost is corrected on
   * the next run". It is best effort: a failure here never blocks a deletion.
   *
   * @returns {Promise<{ repaired: string[] }>} the ids that were still present.
   */
  async repairWorkspaceBookkeeping() {
    try {
      const outcome = await repairWorkspace(this.layout);
      if (outcome.repaired.length > 0) {
        this.ctx.logger?.info?.(
          `session-admin: re-applied ${outcome.repaired.length} past deletion(s) to the workspace registry`,
        );
      }
      return { repaired: outcome.repaired };
    } catch (error) {
      this.ctx.logger?.warn?.(
        `session-admin: could not re-apply past deletions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { repaired: [] };
    }
  }
}

/* ──────────────────────────────── transport ─────────────────────────────── */

/** Largest request body this channel will read, mirroring the shared API carrier's posture. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read and decode a bounded JSON request body.
 *
 * The channel is private to this plugin and every request has already passed
 * the trust fence, but the body still arrives from a browser: it is size-capped
 * and parsed into an owned plain value before anything reads a field from it.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<Record<string, unknown>|undefined>} the decoded body, or undefined when empty.
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    throw new Error('body is not JSON');
  }
}

/**
 * Derive the endpoint name from a request URL, the way the shared carrier does.
 *
 * @param {string|undefined} url - the raw request URL.
 * @returns {string|undefined} the endpoint name, or undefined when the path names no endpoint here.
 */
function endpointOf(url) {
  let pathname;
  try {
    pathname = new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
  if (endpoint.length === 0 || endpoint.includes('/')) return undefined;
  return /^[A-Za-z0-9_$.-]+$/.test(endpoint) ? endpoint : undefined;
}

/**
 * Write one response envelope.
 *
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function writeEnvelope(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
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
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
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
    // The channel is served by registering an HTTP prefix route and asking the
    // connection service for its trust decision, rather than by calling
    // `connection.rpc.handle()`. That helper cannot be used from outside the
    // connection package: it registers its route with `owner.effect(() =>
    // owner.webServer.register(...))` where `owner` is the connection service's
    // own context, and that context does not declare the `webServer` injection,
    // so the call throws `cannot get property "webServer" without inject` and
    // the channel silently never reaches the route table. This is the same shape
    // the shipped `open-in-app` routes use.
    //
    // `requestRejection` is what keeps the security property intact: the same
    // Host/Origin fence and the same signed browser cookie decide before any
    // request body is read, and this plugin publishes no unauthenticated path.
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      const route = {
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: async (req, res) => {
          const rejection = webCtx.connection.requestRejection(req);
          if (rejection !== undefined) {
            res.writeHead(rejection);
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end(error instanceof Error ? error.message : 'bad request');
            return;
          }
          const endpoint = endpointOf(req.url);
          if (endpoint === undefined) {
            res.writeHead(404);
            res.end();
            return;
          }
          if (req.method !== 'POST' || body?.type !== 'client-request' || typeof body?.rpcId !== 'string' || body.method !== endpoint) {
            writeEnvelope(res, 200, {
              type: 'server-response',
              rpcId: typeof body?.rpcId === 'string' ? body.rpcId : '',
              result: rpcFailure(new InvalidOptionError('malformed session-admin request envelope', {})),
            });
            return;
          }
          const result = await admin.dispatch(endpoint, body.payload, AbortSignal.timeout(120_000));
          writeEnvelope(res, 200, { type: 'server-response', rpcId: body.rpcId, result });
        },
      };
      webCtx.effect(() => webCtx.webServer.register(route), 'session-admin: rpc channel');
    });
  }

  // Correct any workspace bookkeeping a previous run could not finish, then
  // report readiness. Startup is the one moment this is guaranteed to run
  // before the registry can rewrite the file.
  admin.repairWorkspaceBookkeeping().catch(() => {});

  // A deferred deletion is a real request that the restart now makes possible.
  // Loading the records first means the queue the operator sees is the queue on
  // disk, not a memory of this process.
  admin
    .loadQueue()
    .then(() => admin.finishDeferredDeletions())
    .catch((error) => {
      ctx.logger?.warn?.(`session-admin: could not settle deferred deletions: ${error instanceof Error ? error.message : String(error)}`);
    });

  ctx.logger?.info?.(
    `session-admin: ready (home ${path.basename(admin.layout.dshHome)}, backup ${config.backup === true ? 'on' : 'off'})`,
  );
}

export { DEFAULTS, formatBytes, resolveConfig };
export default { name, inject, apply };
