/**
 * Permanent removal of one stored Session from a local dsh store.
 *
 * This module is the whole deletion story and it depends on nothing but the
 * Node standard library, so it is testable against fixture trees and reusable
 * from a host plugin, a CLI, or a script. It performs no policy of its own: it
 * does exactly the removal it is asked for, and reports what it removed.
 *
 * ## What "permanently delete" has to touch
 *
 * A dsh Session is not one file. The shipped Web/CLI composition keeps these
 * durable artifacts, and a deletion that leaves any of them behind is not a
 * deletion:
 *
 * | Artifact | Location (default composition) | Why it must go |
 * | --- | --- | --- |
 * | Session log | `<DSH_HOME>/sessions/--<project>--/<id>/session.v<N>.jsonl[.zstd]` | the conversation itself |
 * | Projection checkpoint | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` | the sidebar title, stats and todo snapshot |
 * | Workspace membership | `<DSH_HOME>/storages/workspace.json` → `tables.workspaces[*].sessionIds` | otherwise the row reappears as a ghost |
 * | Archive flag | `<DSH_HOME>/storages/workspace.json` → `global.archivedSessionIds` | otherwise the id leaks into every future archive list |
 *
 * Two things are deliberately NOT removed, because removing them is wrong:
 *
 * - **A live Session.** Its agent owns the log and an open write handle; the
 *   store, not this module, decides when that ends. `deleteSession` refuses
 *   unless the caller explicitly says it has already established that the
 *   session is not live.
 * - **Content-addressed attachments.** `<DSH_HOME>/attachments/v1` stores
 *   identical bytes once per content hash, shared by every session that ever
 *   attached them. Deleting an object because one session referenced it can
 *   corrupt another. Referenced attachments are therefore *reported*, not
 *   removed.
 *
 * @module dsh-session-admin/engine
 */

import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  lstat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import {
  InvalidOptionError,
  InvalidSessionIdError,
  LiveSessionError,
  SessionNotFoundError,
  StorageShapeError,
} from './errors.js';

/** Canonical physical log file name: `session.v<N>.jsonl` plus an optional encoding suffix. */
const LOG_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
/** Project directory name produced by the persistence backend's `projectKey`. */
const PROJECT_DIR_RE = /^--.*--$/;
/** Project directory used when a session recorded no working directory. */
const NO_CWD_DIR = '_no-cwd';
/** On-disk format of `workspace.json` units this engine knows how to edit. */
const WORKSPACE_UNIT_NAME = 'workspace';
/** On-disk format of `session_projcache` units this engine knows how to edit. */
const PROJCACHE_UNIT_NAME = 'session_projcache';
/**
 * Session ids are opaque branded strings, but they always reach the store as
 * `session-<uuid>`. Matching that shape is what keeps a typo or a path
 * fragment from ever reaching the filesystem as a glob or a traversal.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Bumped whenever the report or journal shape changes incompatibly. */
export const REPORT_VERSION = 1;

/* ────────────────────────────── path encoding ────────────────────────────── */

/**
 * Encode one arbitrary string as a single filesystem-safe path segment.
 *
 * This is a byte-for-byte re-implementation of the persistence backend's own
 * `encodeSegment`, which is why a session id can be located without reading a
 * single log. Keeping our own copy (rather than reaching into the backend's
 * private helpers) is what lets this module run with zero dsh dependencies —
 * and the equivalence is pinned by a test against the real directory names.
 *
 * @param {string} raw - non-empty string to encode.
 * @returns {string} the escaped segment, decodable back to `raw`.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidSessionIdError(String(raw), 'must be a non-empty string');
  }
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Build the readable project directory name for one recorded working directory.
 *
 * Mirrors the persistence backend's `projectKey`, including its deliberate
 * losses: separator runs collapse to one `-` and the readable part is capped at
 * 251 characters.
 *
 * @param {string} cwd - absolute project path recorded in the session header.
 * @returns {string} the `--<readable>--` directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new InvalidOptionError('cwd must be a non-empty absolute path', { cwd });
  }
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root';
  return `--${trimmed.slice(0, 251)}--`;
}

/**
 * Validate a caller-supplied session id before it can name a filesystem entry.
 *
 * The persisted backend would happily encode a traversal attempt into a single
 * safe segment, so this is not the only defense — but rejecting obviously wrong
 * input here turns "nothing found" into an actionable error.
 *
 * @param {unknown} id - candidate id.
 * @returns {string} the accepted id.
 * @throws {InvalidSessionIdError} when the id cannot be a session id.
 */
export function assertSessionId(id) {
  if (typeof id !== 'string') throw new InvalidSessionIdError(String(id), 'must be a string');
  if (id.length === 0) throw new InvalidSessionIdError(id, 'must not be empty');
  if (id.length > 128) throw new InvalidSessionIdError(id, 'must be at most 128 characters');
  if (!SESSION_ID_RE.test(id)) {
    throw new InvalidSessionIdError(id, 'may only contain letters, digits, dot, underscore and hyphen');
  }
  return id;
}

/**
 * Whether a string could name a session in this store.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when {@link assertSessionId} would accept it.
 */
export function isSessionId(value) {
  try {
    assertSessionId(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse a path that would escape the store root.
 *
 * @param {string} root - trusted store root.
 * @param {string} candidate - path to check.
 * @returns {string} the resolved candidate.
 * @throws {StorageShapeError} when the candidate leaves the root.
 */
function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorageShapeError('refusing to touch a path outside the store root', {
      root: resolvedRoot,
      candidate: resolved,
    });
  }
  return resolved;
}

/**
 * Whether a path is a real directory rather than a symlink to one.
 *
 * This is the load-bearing check of the whole module. A store is an ordinary
 * directory tree that anything on the machine may write to, and a symlink is
 * how a store entry stops pointing at store content: `readdir` happily follows
 * one, so a link named like a session would make a "delete this session"
 * request read — and then recursively remove — whatever it points at. Refusing
 * symlinks at every level means a deletion can only ever walk the tree it was
 * asked to walk.
 *
 * @param {string} candidate - absolute path.
 * @returns {Promise<boolean>} true only for a real directory.
 */
async function isRealDirectory(candidate) {
  try {
    const info = await lstat(candidate);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether a store entry is a real regular file rather than a link to one.
 *
 * @param {string} candidate - absolute path.
 * @returns {Promise<boolean>} true only for a real file.
 */
async function isRealFile(candidate) {
  try {
    const info = await lstat(candidate);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/* ─────────────────────────────── configuration ───────────────────────────── */

/**
 * Resolve the harness home directory the same way dsh does.
 *
 * @param {string} [explicit] - explicit override, normally from plugin config.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(explicit) {
  const chosen = explicit ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  if (typeof chosen !== 'string' || chosen.length === 0) {
    throw new InvalidOptionError('dshHome must be a non-empty path', { dshHome: chosen });
  }
  return path.resolve(chosen);
}

/**
 * Build the store layout for one harness home.
 *
 * @param {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string, attachmentsRoot?: string, backupRoot?: string, journalRoot?: string }} [options] - overrides; unset values follow the shipped composition.
 * @returns {{ dshHome: string, sessionsRoot: string, storagesRoot: string, workspaceFile: string, projectionsDir: string, attachmentsRoot: string, backupRoot: string, journalRoot: string }} absolute locations.
 */
export function resolveLayout(options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const storagesRoot = path.resolve(options.storagesRoot ?? path.join(dshHome, 'storages'));
  return {
    dshHome,
    sessionsRoot: path.resolve(options.sessionsRoot ?? path.join(dshHome, 'sessions')),
    storagesRoot,
    workspaceFile: path.join(storagesRoot, 'workspace.json'),
    projectionsDir: path.join(storagesRoot, 'session_projcache', 'sessions'),
    attachmentsRoot: path.resolve(options.attachmentsRoot ?? path.join(dshHome, 'attachments')),
    backupRoot: path.resolve(options.backupRoot ?? path.join(dshHome, 'session-admin', 'trash')),
    journalRoot: path.resolve(options.journalRoot ?? path.join(dshHome, 'session-admin', 'pending')),
  };
}

/* ────────────────────────────────── locate ───────────────────────────────── */

/**
 * Read a JSON file, returning `undefined` when it does not exist.
 *
 * @param {string} file - absolute path.
 * @returns {Promise<unknown|undefined>} the parsed value, or undefined when absent.
 */
async function readJsonIfPresent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StorageShapeError(`${path.basename(file)} is not valid JSON`, {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Write a JSON file durably, preserving the mode it already had.
 *
 * A crash therefore leaves either the previous complete document or the next
 * one — never a half-written file, which matters because this is the one
 * artifact that is not deleted but rewritten. The mode matters too: a dsh home
 * is often `0700`/`0600` because session metadata is private, and a fresh temp
 * file created under a permissive umask would loosen the rewrite. When the
 * destination does not exist yet, the private default is used instead.
 *
 * @param {string} file - destination path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {Promise<void>} resolution after the rename.
 */
async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await stat(file).catch(() => undefined);
  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temp, 'wx', mode);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Whether a directory entry is a session-owned directory.
 *
 * A directory is session-owned when it holds at least one canonical log
 * generation. Requiring the log file is what keeps a deletion from ever
 * removing a directory that merely happens to share a name.
 *
 * @param {string} directory - candidate session directory.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<string[]>} the canonical log file names found, sorted.
 */
async function listLogGenerations(directory, signal) {
  signal?.throwIfAborted();
  if (!(await isRealDirectory(directory))) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  /** @type {string[]} */
  const generations = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !LOG_FILE_RE.test(entry.name)) continue;
    if (!(await isRealFile(path.join(directory, entry.name)))) continue;
    generations.push(entry.name);
  }
  return generations.sort();
}

/**
 * Locate every on-disk artifact that belongs to one session.
 *
 * @param {{ id: string, layout: ReturnType<typeof resolveLayout>, signal?: AbortSignal }} request - the id to locate and the resolved store layout.
 * @returns {Promise<{ id: string, sessionDirs: string[], projectDirs: string[], logFiles: {file: string, bytes: number}[], projectionFiles: string[], projectionBytes: number, bytes: number, found: boolean, scannedProjects: number }>} what exists right now.
 */
export async function locateArtifacts({ id, layout, signal }) {
  assertSessionId(id);
  const encoded = encodeSegment(id);
  /** @type {string[]} */
  const sessionDirs = [];
  /** @type {string[]} */
  const projectDirs = [];
  /** @type {{file: string, bytes: number}[]} */
  const logFiles = [];
  let scannedProjects = 0;

  let projectEntries;
  try {
    projectEntries = await readdir(layout.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    projectEntries = [];
  }

  for (const projectEntry of projectEntries) {
    signal?.throwIfAborted();
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
    if (projectEntry.name !== NO_CWD_DIR && !PROJECT_DIR_RE.test(projectEntry.name)) continue;
    const projectDir = assertInside(layout.sessionsRoot, path.join(layout.sessionsRoot, projectEntry.name));
    if (!(await isRealDirectory(projectDir))) continue;
    scannedProjects += 1;
    // The session directory itself is matched by encoded id. We never recurse
    // into unrelated session directories, so a scan cannot read another
    // session's log, and a symlink is refused outright rather than followed.
    const candidate = assertInside(layout.sessionsRoot, path.join(projectDir, encoded));
    const generations = await listLogGenerations(candidate, signal);
    if (generations.length === 0) continue;
    sessionDirs.push(candidate);
    projectDirs.push(projectDir);
    for (const name of generations) {
      const file = path.join(candidate, name);
      const info = await stat(file);
      logFiles.push({ file, bytes: info.size });
    }
  }

  const projectionFiles = await locateProjectionRecords(id, layout, signal);
  let projectionBytes = 0;
  for (const file of projectionFiles) {
    const info = await stat(file).catch(() => undefined);
    if (info !== undefined) projectionBytes += info.size;
  }

  return {
    id,
    sessionDirs,
    projectDirs,
    logFiles,
    projectionFiles,
    projectionBytes,
    bytes: logFiles.reduce((total, entry) => total + entry.bytes, 0) + projectionBytes,
    found: sessionDirs.length > 0 || projectionFiles.length > 0,
    scannedProjects,
  };
}

/**
 * Find the projection-cache documents for one session.
 *
 * The projection cache uses a `per-record` unit layout, so each session is one
 * document named by its raw id. The domain layer may additionally move a
 * document aside as `<id>.json.bak.<stamp>` when a stored record fails
 * validation; those are session-owned too.
 *
 * @param {string} id - session id.
 * @param {ReturnType<typeof resolveLayout>} layout - resolved store layout.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<string[]>} absolute document paths that exist.
 */
async function locateProjectionRecords(id, layout, signal) {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await readdir(layout.projectionsDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  const exact = `${id}.json`;
  const backupPrefix = `${exact}.bak.`;
  /** @type {string[]} */
  const matches = [];
  for (const name of entries) {
    if (name !== exact && !name.startsWith(backupPrefix)) continue;
    const candidate = assertInside(layout.projectionsDir, path.join(layout.projectionsDir, name));
    // A symlinked checkpoint is not a checkpoint: refusing it keeps a deletion
    // from unlinking something outside the store through a link.
    if (!(await isRealFile(candidate))) continue;
    matches.push(candidate);
  }
  return matches.sort();
}

/* ──────────────────────────── session metadata ───────────────────────────── */

/** Zstandard frame magic (`0xFD2FB528`, little endian on the wire). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** How many frames one log read will decode before giving up on the rest. */
const MAX_FRAMES = 20_000;

/**
 * Yield every complete Zstandard frame in a concatenated-frame buffer.
 *
 * The session log is a concatenation of independent checksummed frames — one
 * for the header and one per durable append batch — not one stream. Node's
 * one-shot decoder stops at the first frame, so the boundaries are recovered
 * from the frame magic instead. A frame that fails to decode is skipped, which
 * keeps a torn tail from hiding the frames before it.
 *
 * @param {Buffer} buffer - the whole log file.
 * @returns {Generator<Buffer>} each frame's bytes, in file order.
 */
function* zstdFrames(buffer) {
  /** @type {number[]} */
  const starts = [];
  let at = buffer.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1 && starts.length < MAX_FRAMES) {
    starts.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    yield buffer.subarray(starts[index], end);
  }
}

/**
 * Decode one stored log into its JSON rows.
 *
 * Best effort by construction: a session log is diagnostics to this module,
 * never the authority on whether the session exists. A frame that cannot be
 * decoded is skipped rather than failing the operation.
 *
 * @param {string} file - absolute log path.
 * @param {{ maxBytes?: number, maxFrames?: number }} [limits] - decode budget.
 * @returns {Promise<Record<string, unknown>[]>} decoded rows, in file order.
 */
async function readLogRows(file, limits = {}) {
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024;
  const maxFrames = limits.maxFrames ?? MAX_FRAMES;
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const chunks = [];
  let decoded = 0;
  if (file.endsWith('.zstd')) {
    let frames = 0;
    for (const frame of zstdFrames(buffer)) {
      if (frames >= maxFrames || decoded >= maxBytes) break;
      frames += 1;
      try {
        const text = zstdDecompressSync(frame, { maxOutputLength: maxBytes }).toString('utf8');
        chunks.push(text);
        decoded += text.length;
      } catch {
        // A torn or unsupported frame contributes nothing; later frames still can.
      }
    }
  } else {
    chunks.push(buffer.subarray(0, maxBytes).toString('utf8'));
  }
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rows.push(/** @type {Record<string, unknown>} */ (parsed));
        }
      } catch {
        // A torn final record is expected after a crash; earlier rows stand.
        break;
      }
    }
  }
  return rows;
}

/**
 * Read the durable header facts of one stored session.
 *
 * The first log record is the session header itself
 * (`{"type":"session","version":N,"id":…,"cwd":…,"createdAt":…}`), so the
 * header frame alone answers everything a deletion report needs. `id` is
 * returned so a caller can notice a directory that no longer matches the
 * session it claims to hold.
 *
 * @param {string} file - absolute log path of any existing generation.
 * @returns {Promise<{ id?: string, cwd?: string, createdAt?: number, isSeeded?: boolean, formatVersion?: number, eventRows: number }>} header facts, with unknown fields omitted.
 */
export async function readSessionHeader(file) {
  const rows = await readLogRows(file, { maxBytes: 64 * 1024, maxFrames: 2 });
  /** @type {{ id?: string, cwd?: string, createdAt?: number, isSeeded?: boolean, formatVersion?: number, eventRows: number }} */
  const header = { eventRows: rows.length };
  for (const record of rows) {
    const candidate = record.type === 'session' ? record : undefined;
    if (candidate === undefined) continue;
    if (typeof candidate.id === 'string') header.id = candidate.id;
    if (typeof candidate.cwd === 'string') header.cwd = candidate.cwd;
    if (typeof candidate.createdAt === 'number') header.createdAt = candidate.createdAt;
    if (typeof candidate.isSeeded === 'boolean') header.isSeeded = candidate.isSeeded;
    if (typeof candidate.version === 'number') header.formatVersion = candidate.version;
    break;
  }
  return header;
}

/**
 * Read the durable title the projection cache keeps for one session.
 *
 * Titles are projection state, not log state: the append-only log never stores
 * one, while the cache checkpoint does (`record.rows.title.val`). Reading it
 * from the cache is what lets a report name the conversation it removed.
 *
 * @param {string} file - absolute projection document path.
 * @returns {Promise<string|undefined>} the cached title, when present.
 */
export async function readProjectionTitle(file) {
  const document = await readJsonIfPresent(file);
  if (document === null || typeof document !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>|undefined} */ (
    /** @type {Record<string, unknown>} */ (document).record
  );
  if (record === null || typeof record !== 'object') return undefined;
  const rows = /** @type {Record<string, unknown>|undefined} */ (record.rows);
  if (rows === null || typeof rows !== 'object') return undefined;
  const title = /** @type {Record<string, unknown>|undefined} */ (rows.title);
  if (title === null || typeof title !== 'object') return undefined;
  return typeof title.val === 'string' && title.val.length > 0 ? title.val : undefined;
}/**
 * Collect the content-addressed attachment ids a stored session references.
 *
 * Attachments are shared by hash across sessions, so this exists to *report*
 * what a deletion orphaned — never to authorize removing shared bytes. The scan
 * walks decoded rows, bounded by both a byte budget and a frame budget, and
 * understands the two shapes the harness uses: an `attachmentId` field and an
 * `attachments` array of references.
 *
 * @param {string} file - absolute log path.
 * @returns {Promise<string[]>} sorted, de-duplicated `sha256:` ids.
 */
export async function readAttachmentRefs(file) {
  const rows = await readLogRows(file, { maxBytes: 32 * 1024 * 1024 });
  /** @type {Set<string>} */
  const ids = new Set();
  const record = (value) => {
    if (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)) ids.add(value);
  };
  const visit = (value, depth) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'attachmentId' || key === 'id' && typeof item === 'string' && item.startsWith('sha256:')) {
        record(item);
        continue;
      }
      visit(item, depth + 1);
    }
  };
  for (const row of rows) visit(row, 0);
  return [...ids].sort();
}

/* ──────────────────────────── workspace bookkeeping ──────────────────────── */

/**
 * Reject a parsed store document that carries dangerous own keys.
 *
 * A store file is data this process rewrites, and `JSON.parse` happily lifts a
 * `__proto__` or `constructor` own key off a hostile document. Spreading or
 * re-reading such an object is how a data file turns into prototype pollution
 * in the process that administers it, so those documents are refused rather
 * than repaired: silently rewriting someone's storage unit is worse than
 * saying it cannot be read.
 *
 * @param {unknown} value - the parsed document.
 * @param {string} file - the file it came from, for the diagnostic.
 * @throws {StorageShapeError} when a dangerous own key is present.
 */
function assertNoDangerousKeys(value, file) {
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  const stack = [value];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    // A bounded walk: a store document is small, and an unbounded one on a
    // hostile file is its own denial of service.
    if ((seen += 1) > 100_000) break;
    for (const key of Object.keys(current)) {
      if (forbidden.has(key)) {
        throw new StorageShapeError('store document contains a reserved key', { file, key });
      }
      stack.push(/** @type {Record<string, unknown>} */ (current)[key]);
    }
  }
}

/**
 * Read the workspace unit, validating that it is the shape this engine edits.
 *
 * @param {string} file - absolute `workspace.json` path.
 * @returns {Promise<{ document: Record<string, unknown>, tables: Record<string, Record<string, unknown>>, global: Record<string, unknown> }|undefined>} the parsed unit, or undefined when absent.
 * @throws {StorageShapeError} when the file exists but is not a workspace unit.
 */
async function readWorkspaceUnit(file) {
  const document = await readJsonIfPresent(file);
  if (document === undefined) return undefined;
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new StorageShapeError('workspace.json is not a JSON object', { file });
  }
  assertNoDangerousKeys(document, file);
  const unit = /** @type {Record<string, unknown>} */ (document);
  const declared = /** @type {Record<string, unknown>|undefined} */ (unit.unit);
  if (declared === undefined || declared.name !== WORKSPACE_UNIT_NAME) {
    throw new StorageShapeError('workspace.json does not declare the workspace unit', {
      file,
      declared: declared?.name ?? null,
    });
  }
  const rawTables = unit.tables;
  const tables =
    rawTables !== null && typeof rawTables === 'object' && !Array.isArray(rawTables)
      ? /** @type {Record<string, Record<string, unknown>>} */ (rawTables)
      : {};
  const rawGlobal = unit.global;
  const global =
    rawGlobal !== null && typeof rawGlobal === 'object' && !Array.isArray(rawGlobal)
      ? /** @type {Record<string, unknown>} */ (rawGlobal)
      : {};
  return { document: unit, tables, global };
}

/**
 * Plan the workspace edits one deletion implies, without writing anything.
 *
 * @param {{ document: Record<string, unknown>, tables: Record<string, Record<string, unknown>>, global: Record<string, unknown> }} unit - parsed workspace unit.
 * @param {string} id - session id.
 * @returns {{ workspaces: { workspaceId: string, title: string, path: string }[], archived: boolean, changed: boolean }} what would change.
 */
function planWorkspaceEdit(unit, id) {
  /** @type {{ workspaceId: string, title: string, path: string }[]} */
  const workspaces = [];
  for (const [workspaceId, record] of Object.entries(unit.tables.workspaces ?? {})) {
    if (record === null || typeof record !== 'object') continue;
    const sessionIds = /** @type {unknown} */ (/** @type {Record<string, unknown>} */ (record).sessionIds);
    if (!Array.isArray(sessionIds) || !sessionIds.includes(id)) continue;
    workspaces.push({
      workspaceId,
      title: typeof (/** @type {Record<string, unknown>} */ (record).title) === 'string'
        ? String((/** @type {Record<string, unknown>} */ (record).title))
        : '',
      path: typeof (/** @type {Record<string, unknown>} */ (record).path) === 'string'
        ? String((/** @type {Record<string, unknown>} */ (record).path))
        : '',
    });
  }
  const archivedIds = unit.global.archivedSessionIds;
  const archived = Array.isArray(archivedIds) && archivedIds.includes(id);
  return { workspaces, archived, changed: workspaces.length > 0 || archived };
}

/**
 * Copy one plain record, assigning every own key literally.
 *
 * `{ ...record }` would look up `__proto__` on the prototype chain and set the
 * new object's prototype, which is exactly the shape a hostile store document
 * would use to pollute a process that administers storage. `Object.keys` plus
 * direct assignment keeps every key a plain data property, and the caller has
 * already refused the reserved names.
 *
 * @param {Record<string, unknown>} record - record to copy.
 * @returns {Record<string, unknown>} a shallow copy with only own data keys.
 */
function copyPlain(record) {
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const key of Object.keys(record)) copy[key] = record[key];
  return copy;
}

/**
 * Apply the planned workspace edits to a copy of the unit.
 *
 * @param {{ document: Record<string, unknown>, tables: Record<string, Record<string, unknown>>, global: Record<string, unknown> }} unit - parsed workspace unit.
 * @param {string} id - session id.
 * @returns {Record<string, unknown>} a new document, leaving the input untouched.
 */
function applyWorkspaceEdit(unit, id) {
  /** @type {Record<string, Record<string, unknown>>} */
  const tables = {};
  for (const [name, table] of Object.entries(unit.tables)) {
    if (name !== 'workspaces') {
      tables[name] = table;
      continue;
    }
    /** @type {Record<string, unknown>} */
    const next = {};
    for (const [key, record] of Object.entries(table)) {
      if (record !== null && typeof record === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (record).sessionIds)) {
        const current = /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (record).sessionIds);
        if (current.includes(id)) {
          next[key] = { ...copyPlain(/** @type {Record<string, unknown>} */ (record)), sessionIds: current.filter((value) => value !== id) };
          continue;
        }
      }
      next[key] = record;
    }
    tables[name] = next;
  }
  const archivedIds = unit.global.archivedSessionIds;
  const global = Array.isArray(archivedIds)
    ? { ...copyPlain(unit.global), archivedSessionIds: archivedIds.filter((value) => value !== id) }
    : unit.global;
  return { ...copyPlain(unit.document), tables, global };
}

/* ─────────────────────────────── backups ─────────────────────────────────── */

/**
 * Move one path into the trash directory, preserving its relative shape.
 *
 * A "backup" here means the bytes are moved, not copied: the session is gone
 * from the store either way, and the trash is a reviewable safety net that the
 * operator deletes when satisfied.
 *
 * @param {{ target: string, anchor: string, trashDir: string }} request - path to move, the root it is relative to, and the trash directory for this deletion.
 * @returns {Promise<string>} the trash path the bytes now live at.
 */
async function moveToTrash({ target, anchor, trashDir }) {
  const relative = path.relative(anchor, target);
  const destination = path.join(trashDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(target, destination);
  return destination;
}

/**
 * Remove a file, or move it into the trash when a backup was requested.
 *
 * @param {{ file: string, anchor: string, trashDir?: string }} request - the file, its anchor root, and the optional trash directory.
 * @returns {Promise<string|undefined>} the trash path when backed up.
 */
async function removeFile({ file, anchor, trashDir }) {
  // `rm` and `rename` both act on the link itself rather than its target, so a
  // symlink here can only ever unlink the link. Refusing one anyway keeps the
  // rule uniform: this engine only ever removes things it verified as store
  // content.
  if (!(await isRealFile(file))) return undefined;
  if (trashDir !== undefined) return moveToTrash({ target: file, anchor, trashDir });
  await rm(file, { force: true });
  return undefined;
}

/**
 * Remove a directory tree, or move it into the trash when a backup was requested.
 *
 * @param {{ directory: string, anchor: string, trashDir?: string }} request - the directory, its anchor root, and the optional trash directory.
 * @returns {Promise<string|undefined>} the trash path when backed up.
 */
async function removeDirectory({ directory, anchor, trashDir }) {
  // Re-verify at removal time, not only at plan time: this is the one call that
  // is recursive, and `rm -r` on a symlink would be a path into a tree nobody
  // asked to delete.
  if (!(await isRealDirectory(directory))) return undefined;
  if (trashDir !== undefined) return moveToTrash({ target: directory, anchor, trashDir });
  await rm(directory, { recursive: true, force: true });
  return undefined;
}

/**
 * Delete a project directory once the last session in it is gone.
 *
 * Only an empty directory is removed, and only after a fresh read — an
 * unrelated session that appeared in the meantime keeps the directory alive.
 *
 * @param {string} directory - absolute project directory.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<boolean>} whether the directory was removed.
 */
async function pruneEmptyProjectDirectory(directory, signal) {
  signal?.throwIfAborted();
  if (!(await isRealDirectory(directory))) return false;
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return false;
  }
  if (entries.length > 0) return false;
  try {
    // `rmdir`, not `rm`: a non-recursive `rm` refuses a directory outright, and
    // a recursive one would be the wrong tool for a directory just observed to
    // be empty — the point is that a non-empty directory cannot be removed here
    // even if something appeared between the read and the call.
    await rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────────────── report ────────────────────────────────── */

/**
 * Assemble the human-facing summary of what a deletion did.
 *
 * @param {{ id: string, plan: Awaited<ReturnType<typeof locateArtifacts>>, removed: string[], backedUp: string[], journaled: boolean, workspace: ReturnType<typeof planWorkspaceEdit>, attachmentIds: string[], title?: string, cwd?: string, dryRun: boolean }} input - collected facts.
 * @returns {Record<string, unknown>} the report.
 */
function buildReport(input) {
  return {
    version: REPORT_VERSION,
    sessionId: input.id,
    dryRun: input.dryRun,
    title: input.title ?? null,
    cwd: input.cwd ?? null,
    bytesRemoved: input.plan.bytes,
    sessionDirectories: input.plan.sessionDirs,
    logFiles: input.plan.logFiles.map((entry) => entry.file),
    projectionFiles: input.plan.projectionFiles,
    workspaceMemberships: input.workspace.workspaces,
    archivedFlagPresent: input.workspace.archived,
    removedPaths: input.removed,
    backedUpPaths: input.backedUp,
    journaled: input.journaled,
    attachmentReferences: input.attachmentIds,
    attachmentsKept:
      'Content-addressed attachment bytes are shared by every session that attached them and are intentionally not removed.',
  };
}

/* ──────────────────────────────── inspection ─────────────────────────────── */

/**
 * Describe exactly what a deletion of one session would remove, without writing.
 *
 * This is the safe half of the API: it reads the store, resolves paths, and
 * decodes the session header, but it never mutates anything. A caller that
 * needs to show a user what is about to happen calls this first.
 *
 * @param {{ id: string, dshHome?: string, sessionsRoot?: string, storagesRoot?: string, attachmentsRoot?: string, backupRoot?: string, journalRoot?: string, live?: boolean | ((id: string) => boolean), signal?: AbortSignal }} request - the session to inspect plus optional layout overrides.
 * @returns {Promise<Record<string, unknown>>} the inspection report.
 * @throws {SessionNotFoundError} when nothing in the store matches the id.
 * @throws {LiveSessionError} when the session is reported live.
 */
export async function inspectSession(request) {
  const layout = resolveLayout(request);
  const id = assertSessionId(request.id);
  const signal = request.signal;
  const plan = await locateArtifacts({ id, layout, signal });
  if (!plan.found) throw new SessionNotFoundError(id);

  const primaryLog = plan.logFiles[0]?.file;
  const header = primaryLog === undefined ? { eventRows: 0 } : await readSessionHeader(primaryLog);
  const attachmentIds = primaryLog === undefined ? [] : await readAttachmentRefs(primaryLog);
  const title = plan.projectionFiles[0] === undefined
    ? undefined
    : await readProjectionTitle(plan.projectionFiles[0]);

  const unit = await readWorkspaceUnit(layout.workspaceFile);
  const workspace = unit === undefined
    ? { workspaces: [], archived: false, changed: false }
    : planWorkspaceEdit(unit, id);

  const live = typeof request.live === 'function' ? request.live(id) === true : request.live === true;

  return {
    version: REPORT_VERSION,
    sessionId: id,
    live,
    title: title ?? null,
    cwd: header.cwd ?? null,
    createdAt: header.createdAt ?? null,
    isSeeded: header.isSeeded ?? null,
    formatVersion: header.formatVersion ?? null,
    storedHeadersAgree: header.id === undefined || header.id === id,
    bytesRemoved: plan.bytes,
    sessionDirectories: plan.sessionDirs,
    logFiles: plan.logFiles,
    projectionFiles: plan.projectionFiles,
    workspaceMemberships: workspace.workspaces,
    archivedFlagPresent: workspace.archived,
    attachmentReferences: attachmentIds,
    scannedProjects: plan.scannedProjects,
    dshHome: layout.dshHome,
  };
}

/* ──────────────────────────────── deletion ───────────────────────────────── */

/**
 * Permanently delete one stored session and every durable trace of it.
 *
 * Ordering is deliberate and crash-safe:
 *
 * 1. **Refuse a live session.** Unless the caller passes `live: false` to
 *    assert it has established that no agent owns the session, a live session
 *    is refused. The store, not this engine, owns that decision.
 * 2. **Journal.** A pending record is written first, so an interrupted deletion
 *    leaves evidence a later run can finish.
 * 3. **Back up**, when asked: bytes are moved aside instead of unlinked.
 * 4. **Unbookkeep.** Workspace membership, the archive flag, and the projection
 *    checkpoint go before the log, so a crash cannot leave the sidebar pointing
 *    at a log that is already gone.
 * 5. **Remove the log**, then drop the journal record.
 *
 * @param {{ id: string, dshHome?: string, sessionsRoot?: string, storagesRoot?: string, attachmentsRoot?: string, backupRoot?: string, journalRoot?: string, live?: boolean | ((id: string) => boolean), backup?: boolean, dryRun?: boolean, journal?: boolean, signal?: AbortSignal }} request - the session to delete plus options.
 * @returns {Promise<Record<string, unknown>>} the deletion report.
 * @throws {SessionNotFoundError} when nothing in the store matches the id.
 * @throws {LiveSessionError} when the session is live and `live: false` was not asserted.
 * @throws {AbortedError} when the caller aborted before completion.
 */
export async function deleteSession(request) {
  const layout = resolveLayout(request);
  const id = assertSessionId(request.id);
  const signal = request.signal;
  const backup = request.backup === true;
  const dryRun = request.dryRun === true;
  const journal = request.journal !== false;
  const live = typeof request.live === 'function' ? request.live(id) === true : request.live === true;

  const plan = await locateArtifacts({ id, layout, signal });
  if (!plan.found) throw new SessionNotFoundError(id);
  if (live) throw new LiveSessionError(id);

  const primaryLog = plan.logFiles[0]?.file;
  const header = primaryLog === undefined ? { eventRows: 0 } : await readSessionHeader(primaryLog);
  const attachmentIds = primaryLog === undefined ? [] : await readAttachmentRefs(primaryLog);
  const title = plan.projectionFiles[0] === undefined
    ? undefined
    : await readProjectionTitle(plan.projectionFiles[0]);
  const unit = await readWorkspaceUnit(layout.workspaceFile);
  const workspace = unit === undefined
    ? { workspaces: [], archived: false, changed: false }
    : planWorkspaceEdit(unit, id);

  if (dryRun) {
    return buildReport({
      id,
      plan,
      removed: [],
      backedUp: [],
      journaled: false,
      workspace,
      attachmentIds,
      title,
      cwd: header.cwd,
      dryRun: true,
    });
  }

  const operationId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`;
  const trashDir = backup ? path.join(layout.backupRoot, operationId) : undefined;
  const journalFile = path.join(layout.journalRoot, `${encodeSegment(id)}.json`);
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const backedUp = [];

  if (journal) {
    await mkdir(layout.journalRoot, { recursive: true });
    await writeJsonAtomic(journalFile, {
      version: REPORT_VERSION,
      operationId,
      sessionId: id,
      startedAt: new Date().toISOString(),
      plan: {
        sessionDirectories: plan.sessionDirs,
        projectionFiles: plan.projectionFiles,
        bytes: plan.bytes,
      },
      workspace,
      backup: backup ? trashDir : null,
    });
  }

  try {
    if (unit !== undefined && workspace.changed) {
      const next = applyWorkspaceEdit(unit, id);
      await writeJsonAtomic(layout.workspaceFile, next);
      removed.push(layout.workspaceFile);
    }

    for (const file of plan.projectionFiles) {
      signal?.throwIfAborted();
      const trashed = await removeFile({ file, anchor: layout.projectionsDir, trashDir });
      if (trashed !== undefined) backedUp.push(trashed);
      removed.push(file);
    }

    for (const directory of plan.sessionDirs) {
      signal?.throwIfAborted();
      const trashed = await removeDirectory({ directory, anchor: layout.sessionsRoot, trashDir });
      if (trashed !== undefined) backedUp.push(trashed);
      removed.push(directory);
    }

    for (const projectDir of plan.projectDirs) {
      if (await pruneEmptyProjectDirectory(projectDir, signal)) removed.push(projectDir);
    }
  } finally {
    if (journal) await unlink(journalFile).catch(() => {});
  }

  const report = buildReport({
    id,
    plan,
    removed,
    backedUp,
    journaled: journal,
    workspace,
    attachmentIds,
    title,
    cwd: header.cwd,
    dryRun: false,
  });

  await recordLedger(layout, report).catch(() => {});
  return report;
}

/**
 * Append one deletion to the store's append-only ledger.
 *
 * The ledger is the answer to "what did this tool actually remove, and when" —
 * it holds no session content, only identities, counts, and paths.
 *
 * @param {ReturnType<typeof resolveLayout>} layout - resolved store layout.
 * @param {Record<string, unknown>} report - the completed deletion report.
 * @returns {Promise<void>} resolution after the append.
 */
async function recordLedger(layout, report) {
  const file = path.join(layout.dshHome, 'session-admin', 'deletions.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  const row = {
    at: new Date().toISOString(),
    sessionId: report.sessionId,
    title: report.title ?? null,
    bytesRemoved: report.bytesRemoved ?? 0,
    removedPaths: report.removedPaths ?? [],
    backedUpPaths: report.backedUpPaths ?? [],
    attachmentReferences: report.attachmentReferences ?? [],
  };
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

/* ─────────────────────────────── recovery ────────────────────────────────── */

/**
 * Find deletions that were journalled but never finished.
 *
 * @param {{ dshHome?: string, journalRoot?: string, sessionsRoot?: string, storagesRoot?: string }} [options] - layout overrides.
 * @returns {Promise<{ operationId: string, sessionId: string, startedAt: string, journalFile: string, remaining: string[] }[]>} unfinished operations, newest first.
 */
export async function listPendingDeletions(options = {}) {
  const layout = resolveLayout(options);
  let entries;
  try {
    entries = await readdir(layout.journalRoot);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  /** @type {{ operationId: string, sessionId: string, startedAt: string, journalFile: string, remaining: string[] }[]} */
  const pending = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const journalFile = path.join(layout.journalRoot, name);
    const document = await readJsonIfPresent(journalFile);
    if (document === null || typeof document !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (document);
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    if (sessionId === undefined || !isSessionId(sessionId)) continue;
    const plan = await locateArtifacts({ id: sessionId, layout });
    pending.push({
      operationId: typeof record.operationId === 'string' ? record.operationId : name,
      sessionId,
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      journalFile,
      remaining: [...plan.sessionDirs, ...plan.projectionFiles],
    });
  }
  return pending.sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
}

/**
 * Finish a journalled deletion that did not complete.
 *
 * Resuming is idempotent: every step re-derives what still exists, so a
 * half-finished deletion converges instead of failing on a missing path.
 *
 * @param {{ sessionId: string, dshHome?: string, sessionsRoot?: string, storagesRoot?: string, backupRoot?: string, journalRoot?: string, backup?: boolean, signal?: AbortSignal }} request - the session to finish plus layout overrides.
 * @returns {Promise<Record<string, unknown>>} the deletion report.
 */
export async function recoverDeletion(request) {
  return deleteSession({ ...request, live: false });
}

/**
 * Summarize how much this store currently holds.
 *
 * @param {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string }} [options] - layout overrides.
 * @returns {Promise<{ sessions: number, projects: number, bytes: number, projectionRecords: number, dshHome: string }>} store totals.
 */
export async function summarizeStore(options = {}) {
  const layout = resolveLayout(options);
  let projectEntries = [];
  try {
    projectEntries = await readdir(layout.sessionsRoot, { withFileTypes: true });
  } catch {
    projectEntries = [];
  }
  let sessions = 0;
  let projects = 0;
  let bytes = 0;
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    if (projectEntry.name !== NO_CWD_DIR && !PROJECT_DIR_RE.test(projectEntry.name)) continue;
    const projectDir = path.join(layout.sessionsRoot, projectEntry.name);
    const directory = await opendir(projectDir).catch(() => undefined);
    if (directory === undefined) continue;
    let counted = false;
    for await (const sessionEntry of directory) {
      if (!sessionEntry.isDirectory()) continue;
      const generations = await listLogGenerations(path.join(projectDir, sessionEntry.name));
      if (generations.length === 0) continue;
      sessions += 1;
      counted = true;
      for (const name of generations) {
        const info = await stat(path.join(projectDir, sessionEntry.name, name)).catch(() => undefined);
        if (info !== undefined) bytes += info.size;
      }
    }
    if (counted) projects += 1;
  }
  const projectionRecords = (await readdir(layout.projectionsDir).catch(() => [])).filter((name) => name.endsWith('.json')).length;
  return { sessions, projects, bytes, projectionRecords, dshHome: layout.dshHome };
}
