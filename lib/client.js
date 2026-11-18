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
		// The conversation header clips its action row (`overflow: clip` plus a
		// mask), so a fixed-position dialog rendered inside the header is clipped
		// to a thin strip. The confirmation must live beside #root, which is what
		// `createPortal` to the body provides.
		const ReactDOM = require('react-dom');

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
		/** Required services: the slot registry and the page locale. */
		const inject = ['slots', 'locale'];

		/** Namespace on the plugin's own stylesheet, so product CSS cannot collide with ours. */
		const NS = 'dsh-session-admin';
		/** Locale namespace this plugin owns. */
		const LOCALE_NS = 'session-admin';

		/* Visible copy. English is the fallback; the page locale service selects
		 * Chinese when the UI is Chinese. The host's report lines are language-
		 * neutral data, so the browser composes the sentences from the structured
		 * summary instead of shipping English lines into a Chinese dialog. */
		const DICTIONARIES = {
			zh: {
				actionLabel: '永久删除此会话',
				title: '永久删除此会话',
				subtitle: '会从这台机器上移除该会话。这不是归档。',
				reading: '正在读取会话…',
				liveError: '这个会话正在 dsh 中打开，日志暂时无法删除。\n请先关闭它，或切换到其他会话后再回来删除。',
				notFoundError: '找不到这个会话，可能已经被删除。',
				storageError: '存储格式无法识别，删除已停止。',
				incompleteError: '删除没有完全完成，仍有文件残留。',
				invalidIdError: '会话 id 无效。',
				archivedWarning: '该会话当前已归档，也会从归档列表中消失。',
				pinnedWarning: '该会话已置顶，也会从置顶列表中移除。',
				scheduledWarning: '与该会话关联的 {count} 个定时提醒也会被删除。',
				liveWarning: '这是你正在阅读的会话，删除后它也会关闭。',
				cancel: '取消',
				confirm: '永久删除',
				deleting: '正在删除…',
				close: '关闭',
				queued1: '已保存：该会话已排队等待删除。',
				queued2: '它会在关闭时删除；如果先重启 dsh，也会在下次启动时删除。',
				deletedFallback: '已删除。',
				session: '会话：{id}',
				titleLine: '标题：{title}',
				untitled: '（未命名）',
				unnamedWorkspace: '（未命名工作区）',
				project: '项目：{path}',
				size: '占用大小：{size}',
				artifacts: '文件：{logs} 个会话日志，{projections} 个投影记录',
				workspaceRows: '工作区记录：{rows}',
				archiveCleared: '同时从归档列表中清除该会话。',
				pinCleared: '同时从置顶列表中清除该会话。',
				scheduled: '定时提醒：与该会话关联的 {count} 个将被删除。',
				searchIndex: '注意：该部署在 {path} 保留全文搜索索引，重启 dsh 前其中仍有一份副本。',
				attachments: '该会话引用了 {count} 个内容寻址附件；这些字节会被保留，因为其他会话可能仍在使用。',
				irreversible: '此操作无法撤销。',
				deleted: '已永久删除“{title}” — {id}。',
				freed: '已释放 {size}，涉及 {count} 个路径。',
				backedUp: '已将 {count} 个路径移入回收目录，而不是直接删除。',
				workspaceRemoved: '已从 {count} 个工作区记录中移除。',
				scheduledRemoved: '已删除与该会话关联的 {count} 个定时提醒。',
			},
			en: {
				actionLabel: 'Delete this conversation permanently',
				title: 'Permanently delete this conversation',
				subtitle: 'Removes the conversation from this machine. This is not archiving.',
				reading: 'Reading the session…',
				liveError: 'This conversation is open in dsh right now, so its log cannot be removed yet.\nClose it first, or switch to another conversation and delete it from there.',
				notFoundError: 'This conversation was not found. It may already be deleted.',
				storageError: 'The stored format is not recognized, so deletion stopped.',
				incompleteError: 'The deletion did not finish; some files remain.',
				invalidIdError: 'That session id is not valid.',
				archivedWarning: 'This conversation is currently archived and will disappear from the archive list too.',
				pinnedWarning: 'This conversation is pinned and will be removed from the pinned list too.',
				scheduledWarning: '{count} scheduled reminder(s) bound to this conversation will be removed.',
				liveWarning: 'This is the conversation you are reading. Deleting it closes it as well.',
				cancel: 'Cancel',
				confirm: 'Delete permanently',
				deleting: 'Deleting…',
				close: 'Close',
				queued1: 'Saved: this conversation is queued for deletion.',
				queued2: 'It is deleted the moment it closes, and also on the next dsh start if you restart first.',
				deletedFallback: 'Deleted.',
				session: 'Session: {id}',
				titleLine: 'Title: {title}',
				untitled: '(untitled)',
				unnamedWorkspace: 'an unnamed workspace',
				project: 'Project: {path}',
				size: 'Stored size: {size}',
				artifacts: 'Artifacts: {logs} session log file(s), {projections} projection record(s)',
				workspaceRows: 'Workspace rows: {rows}',
				archiveCleared: 'Also clears this session from the archive list.',
				pinCleared: 'Also clears this session from the pinned list.',
				scheduled: 'Scheduled reminders: {count} bound to this session will be removed.',
				searchIndex: 'Note: this deployment keeps a full-text search index at {path}, which still holds a copy until dsh restarts.',
				attachments: 'Shares {count} content-addressed attachment(s), which are kept because other sessions may use them.',
				irreversible: 'This cannot be undone.',
				deleted: 'Permanently deleted “{title}” — {id}.',
				freed: 'Freed {size} across {count} path(s).',
				backedUp: 'Moved {count} path(s) into the trash directory instead of unlinking them.',
				workspaceRemoved: 'Removed from {count} workspace row(s).',
				scheduledRemoved: 'Removed {count} scheduled reminder(s) bound to the session.',
			},
		};

		/**
		 * Substitute `{name}` placeholders in one template.
		 *
		 * @param {string} template - dictionary text.
		 * @param {Record<string, unknown>} [params] - replacement values.
		 * @returns {string} the rendered text.
		 */
		function interpolate(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		/**
		 * Default copy used when a component is rendered outside the slot system
		 * (tests and one-off previews). The live page passes the locale-bound
		 * `t` through the slot's `locale` option.
		 *
		 * @param {string} key - dictionary key.
		 * @param {Record<string, unknown>} [params] - replacement values.
		 * @returns {string} English text.
		 */
		function defaultTranslate(key, params) {
			return interpolate(DICTIONARIES.en[key] ?? key, params);
		}

		/**
		 * Format a byte count for humans.
		 *
		 * @param {number} bytes - non-negative byte count.
		 * @returns {string} a short human-readable size.
		 */
		function formatBytes(bytes) {
			const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
			if (value < 1024) return `${value} B`;
			const units = ['KiB', 'MiB', 'GiB', 'TiB'];
			let scaled = value / 1024;
			let unit = 0;
			while (scaled >= 1024 && unit < units.length - 1) {
				scaled /= 1024;
				unit += 1;
			}
			return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
		}

		/**
		 * Describe one workspace membership in a phrase.
		 *
		 * @param {Record<string, unknown>} row - a browser summary workspace row.
		 * @param {Function} t - locale-bound translate function.
		 * @returns {string} title and path, or a localized fallback.
		 */
		function workspaceLabel(row, t) {
			const title = typeof row?.title === 'string' && row.title.length > 0 ? row.title : undefined;
			const dir = typeof row?.path === 'string' && row.path.length > 0 ? row.path : undefined;
			if (title !== undefined && dir !== undefined) return `${title} (${dir})`;
			return title ?? dir ?? t('unnamedWorkspace');
		}

		/**
		 * Whether a browser inspection summary carries the structured facts the
		 * localized line builder needs.
		 *
		 * @param {Record<string, any>} info - inspection summary.
		 * @returns {boolean} true when counts are present.
		 */
		function hasInspectionFacts(info) {
			return info !== null && typeof info === 'object'
				&& (typeof info.logCount === 'number' || typeof info.projectionCount === 'number' || typeof info.workspaceCount === 'number');
		}

		/**
		 * Build the pre-deletion lines in the active language.
		 *
		 * @param {Record<string, any>} info - browser inspection summary.
		 * @param {Function} t - locale-bound translate function.
		 * @returns {string[]} the lines, in reading order.
		 */
		function inspectionLines(info, t) {
			if (!hasInspectionFacts(info)) {
				return Array.isArray(info?.lines) ? info.lines : [];
			}
			const lines = [];
			const title = typeof info.title === 'string' && info.title.length > 0 ? info.title : t('untitled');
			lines.push(t('session', { id: info.sessionId }));
			lines.push(t('titleLine', { title }));
			if (typeof info.cwd === 'string' && info.cwd.length > 0) lines.push(t('project', { path: info.cwd }));
			lines.push(t('size', { size: formatBytes(info.bytesRemoved) }));
			lines.push(t('artifacts', { logs: info.logCount ?? 0, projections: info.projectionCount ?? 0 }));
			const workspaces = Array.isArray(info.workspaces) ? info.workspaces : [];
			if (workspaces.length > 0) {
				lines.push(t('workspaceRows', { rows: workspaces.map((row) => workspaceLabel(row, t)).join(', ') }));
			}
			if (info.clearedArchive === true) lines.push(t('archiveCleared'));
			if (info.clearedPin === true) lines.push(t('pinCleared'));
			if (Number(info.scheduledTaskCount ?? 0) > 0) {
				lines.push(t('scheduled', { count: info.scheduledTaskCount }));
			}
			if (typeof info.searchIndex === 'string' && info.searchIndex.length > 0) {
				lines.push(t('searchIndex', { path: info.searchIndex }));
			}
			if (Number(info.attachmentCount ?? 0) > 0) {
				lines.push(t('attachments', { count: info.attachmentCount }));
			}
			lines.push(t('irreversible'));
			return lines;
		}

		/**
		 * Build the settled-deletion lines in the active language.
		 *
		 * @param {Record<string, any>} value - browser deletion summary.
		 * @param {Function} t - locale-bound translate function.
		 * @returns {string[]} the lines, in reading order.
		 */
		function deletionLines(value, t) {
			if (typeof value?.removedCount !== 'number') {
				return Array.isArray(value?.lines) ? value.lines : [t('deletedFallback')];
			}
			const lines = [t('deleted', {
				title: typeof value.title === 'string' && value.title.length > 0 ? value.title : t('untitled'),
				id: value.sessionId,
			})];
			lines.push(t('freed', { size: formatBytes(value.bytesRemoved), count: value.removedCount }));
			if (Number(value.backedUpCount ?? 0) > 0) lines.push(t('backedUp', { count: value.backedUpCount }));
			if (Number(value.workspaceCount ?? 0) > 0) lines.push(t('workspaceRemoved', { count: value.workspaceCount }));
			if (value.clearedArchive === true) lines.push(t('archiveCleared'));
			if (value.clearedPin === true) lines.push(t('pinCleared'));
			if (Number(value.scheduledTasksRemoved ?? 0) > 0) {
				lines.push(t('scheduledRemoved', { count: value.scheduledTasksRemoved }));
			}
			return lines;
		}

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
  /* The dialog takes focus programmatically so Escape works; the browser's
     default focus ring on the whole panel is not a useful affordance. */
  outline: none;
  /* An opaque surface: --dsw-specific-menu is a translucent menu fill meant to
     sit over backdrop-filter, so using it here let the transcript show through
     the dialog and made the confirmation unreadable. */
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-menu, #222)); color: var(--dsw-alias-label-primary);
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
		 * Localize a stable host error code, keeping an unknown message as-is.
		 *
		 * @param {string} code - `SESSION_ADMIN_*` code from the host envelope.
		 * @param {string} message - host-supplied message.
		 * @param {Function} t - locale-bound translate function.
		 * @returns {string} the text the error paragraph shows.
		 */
		function errorText(code, message, t) {
			switch (code) {
				case 'SESSION_ADMIN_LIVE_SESSION': return t('liveError');
				case 'SESSION_ADMIN_NOT_FOUND': return t('notFoundError');
				case 'SESSION_ADMIN_STORAGE_SHAPE': return t('storageError');
				case 'SESSION_ADMIN_DELETION_INCOMPLETE': return t('incompleteError');
				case 'SESSION_ADMIN_INVALID_ID': return t('invalidIdError');
				default: return message;
			}
		}

		/**
		 * Render one inspection/settlement line, marking the irreversible one.
		 *
		 * @param {string} line - the line text.
		 * @param {number} index - position, used only for the React key.
		 * @returns {import('react').ReactElement} the line element.
		 */
		function Line({ line, index }) {
			const danger = /cannot be undone|无法撤销|不可撤销/i.test(line);
			const className = danger
				? `${NS}-line ${NS}-lineDanger`
				: /kept because|may still be used|Warning|保留|可能仍在使用/i.test(line)
					? `${NS}-line ${NS}-lineMuted`
					: `${NS}-line`;
			return React.createElement('p', { className, key: index }, line);
		}

		/**
		 * The confirmation panel.
		 *
		 * State machine: `loading` → (`ready` | `error`) → (`busy`) → (`done` | `error`).
		 * Nothing is deleted until the user presses the destructive button, and the
		 * button's label says which button that is. The sidebar row is not touched
		 * here: the host announces the removal and the client drops the row on that
		 * announcement, which is also what keeps the workspace grouping in step.
		 *
		 * @param {{ sessionId: string, onClose: () => void, t?: Function }} props - the session under the cursor, a close callback, and locale copy.
		 * @returns {import('react').ReactElement} the panel.
		 */
		function DeleteDialog({ sessionId, onClose, t = defaultTranslate }) {
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
				} catch (error) {
					setState({ phase: 'error', message: String(error.message || error), code: error.code });
				} finally {
					setBusy(false);
				}
			};

			const info = state.phase === 'ready' ? state.info : undefined;
			const lines = info === undefined ? [] : inspectionLines(info, t);
			const doneLines = state.phase === 'done'
				? state.queued
					? [t('queued1'), t('queued2')]
					: deletionLines(state.value.report ?? state.value, t)
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
						'aria-label': t('actionLabel'),
						tabIndex: -1,
						ref: panelRef,
					},
					React.createElement('h2', { className: `${NS}-title` }, t('title')),
					React.createElement(
						'p',
						{ className: `${NS}-subtitle` },
						t('subtitle'),
					),
					state.phase === 'loading' ? React.createElement('p', { className: `${NS}-spinner` }, t('reading')) : null,
					state.phase === 'error'
						? React.createElement(
								'p',
								{ className: `${NS}-error` },
								errorText(state.code, state.message, t),
							)
						: null,
					info && info.clearedArchive === true
						? React.createElement('p', { className: `${NS}-warning` }, t('archivedWarning'))
						: null,
					info && info.clearedPin === true
						? React.createElement('p', { className: `${NS}-warning` }, t('pinnedWarning'))
						: null,
					info && Number(info.scheduledTaskCount) > 0
						? React.createElement(
								'p',
								{ className: `${NS}-warning` },
								t('scheduledWarning', { count: info.scheduledTaskCount }),
							)
						: null,
					info && info.live === true
						? React.createElement(
								'p',
								{ className: `${NS}-warning` },
								t('liveWarning'),
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
									t('close'),
								)
							: React.createElement(
									React.Fragment,
									null,
									React.createElement(
										'button',
										{ type: 'button', className: `${NS}-button`, onClick: onClose, disabled: busy },
										t('cancel'),
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
										busy ? t('deleting') : t('confirm'),
									),
								),
					),
				),
			);
		}

		/**
		 * The header action: a trash control that opens the confirmation panel.
		 *
		 * @param {{ sessionId: string, t?: Function }} props - the standard session props the header slot provides, plus locale copy.
		 * @returns {import('react').ReactElement|null} the control.
		 */
		function DeleteSessionAction({ sessionId, t = defaultTranslate }) {
			const [open, setOpen] = React.useState(false);
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					'button',
					{
						type: 'button',
						className: `${NS}-trigger`,
						title: t('actionLabel'),
						'aria-label': t('actionLabel'),
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
					? ReactDOM.createPortal(
							React.createElement(DeleteDialog, { sessionId, onClose: () => setOpen(false), t }),
							document.body,
						)
					: null,
			);
		}

		/**
		 * Client plugin body: own the stylesheet and claim the header action.
		 *
		 * @param {import('@deepseek-ai/cordis').Context} ctx - the browser root context.
		 */
		function apply(ctx) {
			ctx.effect(mountStyles, 'session-admin: stylesheet');
			// The real client context always has the locale service (it is declared
			// in `inject`); the guard keeps the hand-built test contexts usable.
			if (ctx.locale !== undefined) {
				ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTIONARIES), 'session-admin: dictionaries');
			}
			ctx.effect(
				() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
					{
						name: 'conversation.session.header.actions',
						id: ACTION_ID,
						order: 60,
						locale: LOCALE_NS,
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
		exports.DICTIONARIES = DICTIONARIES;
		exports.rpcCall = rpcCall;
		return module.exports;
	},
});
