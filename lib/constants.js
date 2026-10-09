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

/**
 * Endpoint names, as the carrier hands them to the handler.
 *
 * The shared API carrier derives the endpoint by stripping the channel prefix
 * (`endpointFromPath('/session-admin', '/session-admin/inspect')` → `'inspect'`)
 * and rejects an envelope whose `method` is not that exact string. These
 * constants are therefore the *relative* names the host switches on; the
 * browser-facing URL is {@link RPC_CHANNEL} plus one of them.
 */
export const RPC_INSPECT = 'inspect';
export const RPC_DELETE = 'delete';
export const RPC_PENDING = 'pending';
export const RPC_STORE = 'store';

/** Absolute URL for one endpoint, as the browser posts it. */
export function rpcUrl(endpoint) {
  return `${RPC_CHANNEL}/${endpoint}`;
}

/** Header-action registration id; a fresh id adds a cell instead of replacing one. */
export const HEADER_ACTION_ID = 'session-admin-delete';

/**
 * Endpoint that re-applies past deletions to the workspace registry.
 *
 * The running harness keeps the workspace unit in memory and rewrites the whole
 * document on its next unrelated mutation, which can restore an id this plugin
 * already removed from the file. This endpoint lets a caller ask for the repair
 * explicitly instead of waiting for the next deletion or restart.
 */
export const RPC_REPAIR = 'repair';

/**
 * Endpoint that reports which sessions still have a log on disk.
 *
 * The client asks for this before rendering the sidebar, because its session
 * list can still carry a conversation this process deleted but has not yet
 * forgotten.
 */
export const RPC_PRESENT = 'present';
