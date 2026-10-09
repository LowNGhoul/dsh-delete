/**
 * Stable failure vocabulary of session administration.
 *
 * Every failure that a caller is expected to branch on carries a stable
 * machine-readable `code`; the message is written for a human who has to fix
 * the situation. The class hierarchy is flat on purpose — a caller may either
 * match on `code` or use `instanceof`, and neither path depends on the other.
 *
 * @module dsh-session-admin/errors
 */

/** Base class for every failure this package raises deliberately. */
export class SessionAdminError extends Error {
  /**
   * @param {string} code - stable machine-readable failure code.
   * @param {string} message - correction-oriented human diagnostic.
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [options] - optional cause and structured details.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionAdminError';
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = options.details ?? {};
  }
}

/** No stored session matches the requested id. */
export class SessionNotFoundError extends SessionAdminError {
  /** @param {string} id - the session id that matched nothing. */
  constructor(id) {
    super('SESSION_ADMIN_NOT_FOUND', `no stored session matches ${JSON.stringify(id)}`, {
      details: { sessionId: id },
    });
    this.name = 'SessionNotFoundError';
  }
}

/** The requested id is not a well-formed session id. */
export class InvalidSessionIdError extends SessionAdminError {
  /**
   * @param {string} id - the rejected value.
   * @param {string} reason - why it was rejected.
   */
  constructor(id, reason) {
    super('SESSION_ADMIN_INVALID_ID', `invalid session id: ${reason}`, {
      details: { sessionId: id },
    });
    this.name = 'InvalidSessionIdError';
  }
}

/** The caller asked for a safe preview but the operation would write something. */
export class LiveSessionError extends SessionAdminError {
  /** @param {string} id - the live session id. */
  constructor(id) {
    super(
      'SESSION_ADMIN_LIVE_SESSION',
      `session ${JSON.stringify(id)} is currently open in this dsh process; its agent still owns the log`,
      { details: { sessionId: id } },
    );
    this.name = 'LiveSessionError';
  }
}

/** The operation finished but the conversation is still on disk. */
export class DeletionIncompleteError extends SessionAdminError {
  /**
   * @param {string} id - the session that survived.
   * @param {string[]} survivors - the paths still present.
   */
  constructor(id, survivors) {
    super(
      'SESSION_ADMIN_DELETION_INCOMPLETE',
      `session ${JSON.stringify(id)} was not fully removed; ${survivors.length} path(s) remain`,
      { details: { sessionId: id, survivors } },
    );
    this.name = 'DeletionIncompleteError';
  }
}

/** Session metadata exists but the conversation log does not. */
export class OrphanMetadataError extends SessionAdminError {
  /**
   * @param {string} id - the session whose log is missing.
   * @param {string[]} artifacts - the metadata documents that were found instead.
   */
  constructor(id, artifacts) {
    super(
      'SESSION_ADMIN_ORPHAN_METADATA',
      `session ${JSON.stringify(id)} has stored metadata but no conversation log, so there is nothing to delete`,
      { details: { sessionId: id, artifacts } },
    );
    this.name = 'OrphanMetadataError';
  }
}

/** The stored log declares a different session than the one that was requested. */
export class SessionIdentityMismatchError extends SessionAdminError {
  /**
   * @param {string} requested - the id the caller asked for.
   * @param {string} stored - the id the log on disk declares.
   * @param {string} file - the log that disagrees.
   */
  constructor(requested, stored, file) {
    super(
      'SESSION_ADMIN_IDENTITY_MISMATCH',
      `the log for ${JSON.stringify(requested)} declares session ${JSON.stringify(stored)}`,
      { details: { sessionId: requested, storedId: stored, file } },
    );
    this.name = 'SessionIdentityMismatchError';
  }
}

/** A caller-supplied option is unusable. */
export class InvalidOptionError extends SessionAdminError {
  /**
   * @param {string} message - what is wrong and what is accepted.
   * @param {Record<string, unknown>} [details] - offending values.
   */
  constructor(message, details) {
    super('SESSION_ADMIN_INVALID_OPTION', message, { details });
    this.name = 'InvalidOptionError';
  }
}

/** The on-disk state does not look like the store this engine knows how to edit. */
export class StorageShapeError extends SessionAdminError {
  /**
   * @param {string} message - what was expected and what was found.
   * @param {Record<string, unknown>} [details] - offending values, without file bodies.
   */
  constructor(message, details) {
    super('SESSION_ADMIN_STORAGE_SHAPE', message, { details });
    this.name = 'StorageShapeError';
  }
}

/** A caller-supplied abort signal fired before the operation completed. */
export class AbortedError extends SessionAdminError {
  /**
   * @param {string} [message] - optional context.
   * @param {unknown} [cause] - the signal's own abort reason, when it carried one.
   */
  constructor(message = 'session administration was aborted by the caller', cause) {
    super('SESSION_ADMIN_ABORTED', message, { cause });
    this.name = 'AbortedError';
  }
}

/**
 * Normalize a cancellation into this package's own error vocabulary.
 *
 * `AbortSignal.throwIfAborted()` raises its own `AbortError` DOMException, which
 * would cross the RPC boundary as an opaque internal failure. Callers here want
 * one stable code for "you cancelled this", so the DOMException is translated.
 *
 * @param {AbortSignal|undefined} signal - the caller's signal, if any.
 * @returns {void}
 * @throws {AbortedError} when the signal has fired.
 */
export function throwIfAborted(signal) {
  if (signal === undefined) return;
  if (signal.aborted) throw new AbortedError(undefined, signal.reason);
}
