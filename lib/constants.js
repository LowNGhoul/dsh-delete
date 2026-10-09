/**
 * Wire vocabulary shared by both halves of `dsh-session-admin`.
 *
 * Kept in its own dependency-free module because the browser bundle is loaded
 * as plain CommonJS in the page: importing the host entry point there would pull
 * `node:path` into a browser and fail. These constants are the whole contract
 * both halves need to agree on.
 *
 * @module dsh-session-admin/constants
 */

/** Package name, used as both the Cordis plugin name and the module-loader id. */
export const PACKAGE_NAME = 'dsh-session-admin';

/** Cordis plugin name registered by each half. */
export const PLUGIN_NAME = 'session-admin';

/**
 * RPC channel this plugin owns on the authenticated shared API carrier.
 *
 * Deliberately not `/api`: that channel is reserved by the host connection for
 * its single interceptor, and a second owner would throw.
 */
export const RPC_CHANNEL = '/session-admin';

/** Endpoint that describes what a deletion would remove. */
export const RPC_INSPECT = `${RPC_CHANNEL}/inspect`;

/** Endpoint that performs a deletion, or queues one when asked. */
export const RPC_DELETE = `${RPC_CHANNEL}/delete`;

/** Endpoint that lists queued and unfinished deletions. */
export const RPC_PENDING = `${RPC_CHANNEL}/pending`;

/** Endpoint that reports store totals. */
export const RPC_STORE = `${RPC_CHANNEL}/store`;

/** Header-action registration id; a fresh id adds a cell instead of replacing one. */
export const HEADER_ACTION_ID = 'session-admin-delete';
