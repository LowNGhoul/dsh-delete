#!/usr/bin/env node
/**
 * `dsh-session-admin` — permanent session deletion from the command line.
 *
 * The host plugin covers the interactive case: it knows which sessions a live
 * agent owns and it can refuse the ones it must. The CLI covers the case the
 * plugin cannot — deleting the session you are currently reading, from a
 * process that holds nothing. It reads the same store with the same engine, so
 * both paths remove exactly the same artifacts.
 *
 * Every command accepts the layout flags below, and `--json` makes any command
 * emit its report as JSON for scripting.
 *
 * @module dsh-session-admin/cli
 */

import { parseArgs } from 'node:util';

import {
  deleteSession,
  inspectSession,
  listPendingDeletions,
  summarizeStore,
} from './engine.js';
import { SessionAdminError } from './errors.js';
import { formatBytes } from './report.js';

const USAGE = `dsh-session-admin — permanently delete DeepSeek Harness conversations

Usage:
  dsh-session-admin list [--json]
  dsh-session-admin inspect <session-id> [--json]
  dsh-session-admin delete <session-id> [--yes] [--backup] [--json]
  dsh-session-admin recover [--json]
  dsh-session-admin store [--json]
  dsh-session-admin --help

Layout (defaults follow $DSH_HOME, then ~/.dsh):
  --dsh-home <path>       harness home
  --sessions-root <path>  session log root            (default <home>/sessions)
  --storages-root <path>  storage root                (default <home>/storages)
  --backup-root <path>    trash root                  (default <home>/session-admin/trash)

Safety:
  delete requires --yes. Without it the command prints what it would remove and
  stops, so a typo can never delete anything.
  --backup moves the bytes into the trash root instead of unlinking them. The
  session still disappears from dsh; the trash is a reviewable safety net.

Notes:
  Content-addressed attachments under <home>/attachments are never removed:
  identical bytes are shared by every session that attached them.
`;

/**
 * Parse the command line into a command plus options.
 *
 * @param {string[]} argv - arguments after the executable.
 * @returns {{ command: string, positionals: string[], values: Record<string, unknown> }} the parsed invocation.
 */
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'dsh-home': { type: 'string' },
      'sessions-root': { type: 'string' },
      'storages-root': { type: 'string' },
      'backup-root': { type: 'string' },
      yes: { type: 'boolean', default: false },
      backup: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command = '', ...rest] = positionals;
  return { command, positionals: rest, values };
}

/**
 * Build the engine's layout options from parsed flags.
 *
 * @param {Record<string, unknown>} values - parsed flags.
 * @returns {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string, backupRoot?: string }} layout overrides.
 */
function layoutOptions(values) {
  return {
    dshHome: /** @type {string|undefined} */ (values['dsh-home']),
    sessionsRoot: /** @type {string|undefined} */ (values['sessions-root']),
    storagesRoot: /** @type {string|undefined} */ (values['storages-root']),
    backupRoot: /** @type {string|undefined} */ (values['backup-root']),
  };
}

/**
 * Print one line to stdout.
 *
 * @param {string} line - text to print.
 * @returns {void}
 */
function print(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Enumerate stored sessions by reading the store directly.
 *
 * No dsh process is involved, so this is the command to use when the store is
 * the only thing present — a backup, a copied home, or a machine where the
 * server will not start.
 *
 * @param {Record<string, unknown>} values - parsed flags.
 * @returns {Promise<{ id: string, bytes: number, cwd: string|null, title: string|null }[]>} stored sessions, largest first.
 */
async function listStored(values) {
  const { readdir, stat } = await import('node:fs/promises');
  const path = await import('node:path');
  const { resolveLayout, readProjectionTitle } = await import('./engine.js');
  const layout = resolveLayout(layoutOptions(values));
  /** @type {{ id: string, bytes: number, cwd: string|null, title: string|null }[]} */
  const rows = [];
  let projects = [];
  try {
    projects = await readdir(layout.sessionsRoot, { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(layout.sessionsRoot, project.name);
    let sessions = [];
    try {
      sessions = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const directory = path.join(projectDir, session.name);
      let files = [];
      try {
        files = await readdir(directory);
      } catch {
        continue;
      }
      const generations = files.filter((file) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(file));
      if (generations.length === 0) continue;
      let bytes = 0;
      for (const file of generations) {
        const info = await stat(path.join(directory, file)).catch(() => undefined);
        if (info !== undefined) bytes += info.size;
      }
      const projectionFile = path.join(layout.projectionsDir, `${session.name}.json`);
      const title = await readProjectionTitle(projectionFile).catch(() => undefined);
      rows.push({ id: session.name, bytes, cwd: project.name === '_no-cwd' ? null : project.name, title: title ?? null });
    }
  }
  return rows.sort((left, right) => right.bytes - left.bytes);
}

/**
 * Run one CLI invocation.
 *
 * @param {string[]} argv - arguments after the executable.
 * @returns {Promise<number>} the process exit code.
 */
async function main(argv) {
  const { command, positionals, values } = parse(argv);
  const asJson = values.json === true;

  if (values.help === true || command === '' || command === 'help') {
    print(USAGE);
    return command === '' && values.help !== true ? 1 : 0;
  }

  switch (command) {
    case 'list': {
      const rows = await listStored(values);
      if (asJson) {
        print(JSON.stringify(rows, null, 2));
        return 0;
      }
      for (const row of rows) {
        print(`${row.id}  ${formatBytes(row.bytes).padStart(9)}  ${row.title ?? '(untitled)'}`);
      }
      print(`\n${rows.length} stored session(s).`);
      return 0;
    }
    case 'inspect': {
      const id = positionals[0];
      if (id === undefined) {
        print('inspect needs a session id. See --help.');
        return 1;
      }
      const report = await inspectSession({ id, ...layoutOptions(values), live: false });
      if (asJson) {
        print(JSON.stringify(report, null, 2));
        return 0;
      }
      print(`session    ${report.sessionId}`);
      print(`title      ${report.title ?? '(untitled)'}`);
      print(`project    ${report.cwd ?? '(none)'}`);
      print(`size       ${formatBytes(report.bytesRemoved ?? 0)}`);
      print(`live       ${report.live === true ? 'yes — quoted/logged elsewhere' : 'no'}`);
      for (const file of /** @type {string[]} */ (report.logFiles.map((entry) => entry.file))) print(`log        ${file}`);
      for (const file of /** @type {string[]} */ (report.projectionFiles)) print(`projection ${file}`);
      for (const row of /** @type {any[]} */ (report.workspaceMemberships)) print(`workspace  ${row.title} (${row.path})`);
      if (report.archivedFlagPresent === true) print('archive    this session is in the archive list');
      const attachments = /** @type {string[]} */ (report.attachmentReferences);
      if (attachments.length > 0) print(`attachments ${attachments.length} shared, kept`);
      return 0;
    }
    case 'delete': {
      const id = positionals[0];
      if (id === undefined) {
        print('delete needs a session id. See --help.');
        return 1;
      }
      if (values.yes !== true) {
        const report = await inspectSession({ id, ...layoutOptions(values), live: false });
        print('Refusing to delete without --yes. This is what would be removed:');
        print(`  session    ${report.sessionId}`);
        print(`  title      ${report.title ?? '(untitled)'}`);
        print(`  project    ${report.cwd ?? '(none)'}`);
        print(`  size       ${formatBytes(report.bytesRemoved ?? 0)}`);
        print(`  logs       ${/** @type {unknown[]} */ (report.logFiles).length} file(s)`);
        print(`  projection ${/** @type {unknown[]} */ (report.projectionFiles).length} record(s)`);
        print(`  workspace  ${/** @type {unknown[]} */ (report.workspaceMemberships).length} row(s)`);
        print(`\nRe-run with --yes to delete permanently${values.backup === true ? ' (--backup already on)' : ', or add --backup to move the bytes to the trash root'}.`);
        return 1;
      }
      const report = await deleteSession({
        id,
        ...layoutOptions(values),
        live: false,
        backup: values.backup === true,
      });
      if (asJson) {
        print(JSON.stringify(report, null, 2));
        return 0;
      }
      print(`Deleted ${report.sessionId}${report.title === null ? '' : ` ('${report.title}')`}.`);
      print(`Freed ${formatBytes(report.bytesRemoved ?? 0)} across ${/** @type {unknown[]} */ (report.removedPaths).length} path(s).`);
      const backedUp = /** @type {unknown[]} */ (report.backedUpPaths);
      if (backedUp.length > 0) print(`Moved ${backedUp.length} path(s) to ${values['backup-root'] ?? 'the trash root'}.`);
      return 0;
    }
    case 'recover': {
      const pending = await listPendingDeletions(layoutOptions(values));
      if (asJson) {
        print(JSON.stringify(pending, null, 2));
        return 0;
      }
      if (pending.length === 0) {
        print('No unfinished deletions.');
        return 0;
      }
      for (const entry of pending) {
        print(`${entry.sessionId}  started ${entry.startedAt}  remaining ${entry.remaining.length} path(s)`);
      }
      print('\nRe-run each id with `delete <id> --yes` to finish it.');
      return 0;
    }
    case 'store': {
      const totals = await summarizeStore(layoutOptions(values));
      if (asJson) {
        print(JSON.stringify(totals, null, 2));
        return 0;
      }
      print(`home        ${totals.dshHome}`);
      print(`sessions    ${totals.sessions}`);
      print(`projects    ${totals.projects}`);
      print(`size        ${formatBytes(totals.bytes)}`);
      print(`projections ${totals.projectionRecords}`);
      return 0;
    }
    default:
      print(`Unknown command ${JSON.stringify(command)}. See --help.`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${error instanceof SessionAdminError ? `${error.code}: ` : ''}${message}\n`);
    process.exitCode = 1;
  });
