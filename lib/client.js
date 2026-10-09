/**
 * Browser half of `dsh-session-admin`.
 *
 * This is the built client bundle the harness module loader serves: it is a
 * factory-form CommonJS module that registers its factory with
 * `window.__ModuleLoader__`, requires React from the platform seed table, and
 * exports an ordinary Cordis client plugin (`name` / `inject` / `apply`). It is
 * written by hand rather than compiled, so there is no build step between this
 * source and the bundle the browser loads.
 *
 * What it contributes is one thing: a **delete conversation** action in the
 * conversation header, beside the other session actions. The action opens a
 * confirmation panel that states exactly what will be removed, because a
 * deletion that a user cannot verify before committing is not a safe deletion.
 *
 * All authority stays on the host. This half never touches a log, never holds a
 * report beyond the render that shows it, and speaks only JSON over the
 * authenticated `/session-admin` RPC channel.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-admin',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		/* Wire vocabulary of `./constants.js`, inlined verbatim: this file is a
		 * classic script the page loads directly, so it cannot carry an import
		 * statement. A test asserts these values match the module the host uses. */
		/** Cordis plugin name. */
		const name = 'session-admin';
		/** Header-action registration id; a fresh id adds a cell instead of replacing one. */
		const ACTION_ID = 'session-admin-delete';
		/** The channel this plugin owns on the shared API carrier. */
		const RPC_CHANNEL = '/session-admin';
		/**
		 * Endpoint names, relative to the channel.
		 *
		 * The carrier derives the endpoint by stripping the channel prefix and
		 * refuses an envelope whose `method` is not that exact string, so the
		 * request URL is channel + name and the envelope's `method` is the name.
		 */
		const RPC_INSPECT = 'inspect';
		const RPC_DELETE = 'delete';
		/** Required service: the slot registry the header action plugs into. */
		const inject = ['slots'];

		/** Namespace on the plugin's own stylesheet, so product CSS cannot collide with ours. */
		const NS = 'dsh-session-admin';
		/**
		 * The browser root context, captured in `apply`.
		 *
		 * The rendered components need it to reach the session list after a
		 * deletion: clearing the selection and re-pulling the list is what makes
		 * the conversation disappear from the sidebar as well as from disk.
		 */
		let browserCtx;

		const CSS = `
.${NS}-trigger {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.${NS}-trigger:hover, .${NS}-trigger:focus-visible {
  background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-primary);
}
.${NS}-trigger[disabled] { cursor: progress; opacity: .5; }
.${NS}-backdrop {
  position: fixed; inset: 0; z-index: 9000; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(0, 0, 0, .42);
}
.${NS}-panel {
  box-sizing: border-box; width: 100%; max-width: 560px; max-height: 80vh;
  overflow: auto; padding: 20px 22px 18px; border-radius: 16px;
  background: var(--dsw-specific-menu, #222); color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, .45));
  font-size: 13px; line-height: 20px;
}
.${NS}-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.${NS}-subtitle { margin: 0 0 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${NS}-lines { margin: 0 0 14px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-fill-l2); }
.${NS}-line { margin: 0; font-size: 12px; line-height: 19px; }
.${NS}-line + .${NS}-line { margin-top: 2px; }
.${NS}-lineDanger { color: var(--dsw-alias-label-error, #ff6b6b); font-weight: 600; }
.${NS}-lineMuted { color: var(--dsw-alias-label-tertiary); }
.${NS}-error {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
  background: rgba(255, 107, 107, .12); color: var(--dsw-alias-label-error, #ff6b6b);
  font-size: 12px; white-space: pre-wrap;
}
.${NS}-warning {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
  background: rgba(255, 193, 7, .12); font-size: 12px;
}
.${NS}-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.${NS}-button {
  min-height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16));
  background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px;
}
.${NS}-button:hover, .${NS}-button:focus-visible { background: var(--dsw-alias-fill-l2); }
.${NS}-button[disabled] { cursor: progress; opacity: .55; }
.${NS}-buttonDanger {
  border-color: transparent; background: var(--dsw-alias-fill-error, #e5484d); color: #fff;
}
.${NS}-buttonDanger:hover, .${NS}-buttonDanger:focus-visible { filter: brightness(1.08); }
.${NS}-spinner { padding: 18px 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
`;

		/**
		 * Install the stylesheet once per page, and own it for this plugin's lifetime.
		 *
		 * The tag carries `data-plugin` so an unload can remove exactly what this
		 * plugin inserted, and the guard makes a second load idempotent.
		 *
		 * @returns {() => void} disposer removing the tag this call owns.
		 */
		function mountStyles() {
			const existing = document.querySelector(`style[data-plugin=${JSON.stringify(name)}]`);
			if (existing !== null) {
				return () => {
					// A tag already present belongs to another live instance of this
					// plugin; leaving it alone keeps that instance's styles intact.
				};
			}
			const tag = document.createElement('style');
			tag.dataset.plugin = name;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		/**
		 * Post one request to the plugin's own RPC channel.
		 *
		 * Two contracts meet here, and both are `dsh-client-connection`'s: the
		 * request goes to `<channel>/<endpoint>`, and the envelope's `method`
		 * must be the endpoint *without* the channel prefix, because the carrier
		 * strips it before deciding whether it owns the request. The physical
		 * carrier has already applied the host/origin fence and browser-cookie
		 * authentication before the host handler runs, so this half carries no
		 * credential of its own.
		 *
		 * @param {string} endpoint - endpoint name relative to the channel, e.g. `delete`.
		 * @param {Record<string, unknown>} payload - JSON request body.
		 * @param {AbortSignal} [signal] - optional cancellation.
		 * @returns {Promise<unknown>} the business value.
		 */
		async function rpcCall(endpoint, payload, signal) {
			const url = `${RPC_CHANNEL}/${endpoint}`;
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					type: 'client-request',
					rpcId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
					method: endpoint,
					payload,
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(`${url} failed with HTTP ${response.status}`);
			}
			const envelope = await response.json();
			const result = envelope && envelope.result;
			if (!result || result.ok !== true) {
				const failure = result && result.error ? result.error : {};
				const error = new Error(typeof failure.message === 'string' ? failure.message : 'session-admin request failed');
				error.code = typeof failure.code === 'string' ? failure.code : 'SESSION_ADMIN_INTERNAL';
				throw error;
			}
			return result.value;
		}

		/**
		 * Render one inspection/settlement line, marking the irreversible one.
		 *
		 * @param {string} line - the line text.
		 * @param {number} index - position, used only for the React key.
		 * @returns {import('react').ReactElement} the line element.
		 */
		function Line({ line, index }) {
			const danger = /cannot be undone/i.test(line);
			const className = danger
				? `${NS}-line ${NS}-lineDanger`
				: /kept because|Warning/i.test(line)
					? `${NS}-line ${NS}-lineMuted`
					: `${NS}-line`;
			return React.createElement('p', { className, key: index }, line);
		}

		/**
		 * The confirmation panel.
		 *
		 * State machine: `loading` → (`ready` | `error`) → (`busy`) → (`done` | `error`).
		 * Nothing is deleted until the user presses the destructive button, and the
		 * button's label says which button that is.
		 *
		 * @param {{ sessionId: string, onClose: () => void }} props - the session under the cursor and a close callback.
		 * @returns {import('react').ReactElement} the panel.
		 */
		function DeleteDialog({ sessionId, onClose, onDeleted }) {
			const [state, setState] = React.useState({ phase: 'loading' });
			const [busy, setBusy] = React.useState(false);
			const panelRef = React.useRef(null);

			React.useEffect(() => {
				let cancelled = false;
				setState({ phase: 'loading' });
				rpcCall(RPC_INSPECT, { sessionId })
					.then((value) => {
						if (!cancelled) setState({ phase: 'ready', info: value });
					})
					.catch((error) => {
						if (!cancelled) setState({ phase: 'error', message: String(error.message || error) });
					});
				return () => {
					cancelled = true;
				};
			}, [sessionId]);

			React.useEffect(() => {
				panelRef.current?.focus();
				const onKeyDown = (event) => {
					if (event.key === 'Escape' && !busy) onClose();
				};
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [busy, onClose]);

			/**
			 * Delete the conversation.
			 *
			 * `force` is what makes this one step: the host is told the operator
			 * has already seen what will be removed and confirmed it, so the
			 * session goes even if its agent is still holding the log open. On a
			 * POSIX filesystem that is a real deletion — the directory entry is
			 * unlinked and a surviving handle writes to an unreachable inode — so
			 * there is nothing left to wait for.
			 *
			 * @returns {Promise<void>} resolution after the panel settled.
			 */
			const run = async () => {
				setBusy(true);
				try {
					const value = await rpcCall(RPC_DELETE, { sessionId, force: true });
					setState({ phase: 'done', value, queued: false });
					onDeleted?.(sessionId);
				} catch (error) {
					setState({ phase: 'error', message: String(error.message || error), code: error.code });
				} finally {
					setBusy(false);
				}
			};

			const info = state.phase === 'ready' ? state.info : undefined;
			const lines = info && Array.isArray(info.lines) ? info.lines : [];
			const doneLines = state.phase === 'done'
				? state.queued
					? [
							'Saved: this conversation is queued for deletion.',
							'It is deleted the moment it closes, and also on the next dsh start if you restart first.',
						]
					: Array.isArray(state.value.lines)
						? state.value.lines
						: ['Deleted.']
				: [];

			return React.createElement(
				'div',
				{
					className: `${NS}-backdrop`,
					role: 'presentation',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget && !busy) onClose();
					},
				},
				React.createElement(
					'div',
					{
						className: `${NS}-panel`,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': 'Delete conversation permanently',
						tabIndex: -1,
						ref: panelRef,
					},
					React.createElement('h2', { className: `${NS}-title` }, 'Permanently delete this conversation'),
					React.createElement(
						'p',
						{ className: `${NS}-subtitle` },
						'Removes the conversation from this machine. This is not archiving.',
					),
					state.phase === 'loading' ? React.createElement('p', { className: `${NS}-spinner` }, 'Reading the session…') : null,
					state.phase === 'error'
						? React.createElement(
								'p',
								{ className: `${NS}-error` },
								state.code === 'SESSION_ADMIN_LIVE_SESSION'
									? 'This conversation is open in dsh right now, so its log cannot be removed yet.\nClose it first, or switch to another conversation and delete it from there.'
									: state.message,
							)
						: null,
					info && info.archived === true
						? React.createElement('p', { className: `${NS}-warning` }, 'This conversation is currently archived and will disappear from the archive list too.')
						: null,
					info && info.live === true
						? React.createElement(
								'p',
								{ className: `${NS}-warning` },
								'This is the conversation you are reading. Deleting it closes it as well.',
							)
						: null,
					lines.length > 0
						? React.createElement(
								'div',
								{ className: `${NS}-lines` },
								lines.map((line, index) => React.createElement(Line, { key: index, line, index })),
							)
						: null,
					doneLines.length > 0
						? React.createElement(
								'div',
								{ className: `${NS}-lines` },
								doneLines.map((line, index) => React.createElement(Line, { key: index, line, index })),
							)
						: null,
					React.createElement(
						'div',
						{ className: `${NS}-actions` },
						state.phase === 'done'
							? React.createElement(
									'button',
									{ type: 'button', className: `${NS}-button ${NS}-buttonDanger`, onClick: onClose },
									'Close',
								)
							: React.createElement(
									React.Fragment,
									null,
									React.createElement(
										'button',
										{ type: 'button', className: `${NS}-button`, onClick: onClose, disabled: busy },
										'Cancel',
									),
									React.createElement(
										'button',
										{
											type: 'button',
											className: `${NS}-button ${NS}-buttonDanger`,
											onClick: run,
											// Held until the inspection answers: a press
											// before that would reach the host knowing
											// nothing about the session.
											disabled: busy || info === undefined,
										},
										busy ? 'Deleting…' : 'Delete permanently',
									),
								),
					),
				),
			);
		}

		/**
		 * The header action: a trash control that opens the confirmation panel.
		 *
		 * @param {{ sessionId: string }} props - the standard session props the header slot provides.
		 * @returns {import('react').ReactElement|null} the control.
		 */
		function DeleteSessionAction({ sessionId }) {
			const [open, setOpen] = React.useState(false);
			/**
			 * Put the page back in a coherent place after a deletion.
			 *
			 * Deleting the session on screen has to do two things. The selection
			 * is dropped, so the empty state appears instead of a conversation
			 * that no longer exists. And the list is re-pulled — but the host's
			 * list is assembled from an in-memory index and, for a session this
			 * process still holds, from the live store entry itself, so a session
			 * that was deleted while it was open can still be reported. The host
			 * is therefore asked which sessions still exist on disk, and anything
			 * it no longer has is dropped locally. Without that, the sidebar keeps
			 * the row until the next restart, which is the one thing a deletion
			 * must not do.
			 *
			 * @param {string} deletedId - the session that was just removed.
			 * @returns {Promise<void>} resolution after the list settled.
			 */
			const onDeleted = (deletedId) => {
				const sessions = browserCtx?.get?.('sessions');
				if (sessions === undefined || sessions === null) return;
				if (deletedId === sessionId) sessions.clear?.();
				// Deliberately no re-pull here. The host's list is assembled from an
				// in-memory index and, for a session this process still holds, from
				// the live store entry itself — so a refresh would fetch the session
				// that was just deleted and put its row straight back. The removal
				// event above is what takes the row out, and it stays out until the
				// process restarts and the in-memory copy is gone for good.
			};
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					'button',
					{
						type: 'button',
						className: `${NS}-trigger`,
						title: 'Delete this conversation permanently',
						'aria-label': 'Delete this conversation permanently',
						onClick: (event) => {
							event.stopPropagation();
							setOpen(true);
						},
					},
					React.createElement(
						'svg',
						{ width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
						React.createElement('path', {
							fill: 'currentColor',
							d: 'M6.5 1.5h3a.5.5 0 0 1 .5.5v.5h3a.5.5 0 0 1 0 1h-.53l-.72 9.02A1.5 1.5 0 0 1 10.26 14H5.74a1.5 1.5 0 0 1-1.49-1.48L3.53 3.5H3a.5.5 0 0 1 0-1h3V2a.5.5 0 0 1 .5-.5Zm-1.97 2 .71 8.94a.5.5 0 0 0 .5.56h4.52a.5.5 0 0 0 .5-.55L11.47 4H4.53Zm2.47 1.5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V5.5a.5.5 0 0 1 .5-.5Zm2 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V5.5a.5.5 0 0 1 .5-.5Z',
						}),
					),
				),
				open
					? React.createElement(DeleteDialog, { sessionId, onClose: () => setOpen(false), onDeleted })
					: null,
			);
		}

		/**
		 * Client plugin body: own the stylesheet and claim the header action.
		 *
		 * @param {import('@deepseek-ai/cordis').Context} ctx - the browser root context.
		 */
		function apply(ctx) {
			browserCtx = ctx;
			ctx.effect(mountStyles, 'session-admin: stylesheet');
			ctx.effect(
				() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
					{
						name: 'conversation.session.header.actions',
						id: ACTION_ID,
						order: 60,
					},
					DeleteSessionAction,
				)),
				'session-admin: header action',
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.DeleteSessionAction = DeleteSessionAction;
		exports.DeleteDialog = DeleteDialog;
		exports.rpcCall = rpcCall;
		return module.exports;
	},
});
