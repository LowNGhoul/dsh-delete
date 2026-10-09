/**
 * Engine tests: fixture-tree behavior, the guarantees a deletion makes, and the
 * refusals that keep a deletion from touching something it was not asked about.
 *
 * Every test builds its own store under a temporary directory. Nothing here
 * reads or writes a real `$DSH_HOME`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  assertSessionId,
  deleteSession,
  encodeSegment,
  inspectSession,
  isSessionId,
  listPendingDeletions,
  projectKey,
  readProjectionTitle,
  readSessionHeader,
  resolveLayout,
  summarizeStore,
} from '../lib/engine.js';
import {
  InvalidSessionIdError,
  LiveSessionError,
  SessionNotFoundError,
  StorageShapeError,
} from '../lib/errors.js';
import { formatBytes, describeInspection } from '../lib/report.js';

/**
 * Build a minimal but faithful store: one project directory holding synthesized
 * logs in the real wire shape, one projection checkpoint, and one workspace unit.
 */
class Fixture {
  /** @param {string} root - temporary directory that will hold the home. */
  constructor(root) {
    this.root = root;
    this.home = path.join(root, '.dsh');
    this.layout = resolveLayout({ dshHome: this.home });
  }

  /** Create the directory skeleton. */
  async init() {
    await mkdir(path.dirname(this.layout.workspaceFile), { recursive: true });
    await mkdir(this.layout.projectionsDir, { recursive: true });
    await mkdir(this.layout.sessionsRoot, { recursive: true });
  }

  /**
   * Write one stored session.
   *
   * @param {{ id: string, cwd?: string, title?: string|null, frames?: number, archived?: boolean, workspaceId?: string, raw?: boolean, bytes?: number }} spec - session specification.
   * @returns {Promise<{ id: string, dir: string, log: string, projection: string }>} created paths.
   */
  async addSession(spec) {
    const cwd = spec.cwd ?? '/tmp/example-project';
    const projectDir = path.join(this.layout.sessionsRoot, projectKey(cwd));
    const dir = path.join(projectDir, encodeSegment(spec.id));
    await mkdir(dir, { recursive: true });
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id: spec.id,
      createdAt: 1_700_000_000_000,
      cwd,
      isSeeded: false,
    });
    const filler = spec.bytes === undefined ? [] : ['x'.repeat(spec.bytes)];
    const rows = [header, ...filler];
    let body;
    if (spec.raw === true) {
      body = Buffer.from(`${rows.join('\n')}\n`, 'utf8');
    } else {
      const frames = [zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))];
      for (const row of filler) frames.push(zstdCompressSync(Buffer.from(`${row}\n`, 'utf8')));
      body = Buffer.concat(frames);
    }
    const log = path.join(dir, spec.raw === true ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd');
    await writeFile(log, body);

    const projection = path.join(this.layout.projectionsDir, `${spec.id}.json`);
    await writeFile(
      projection,
      `${JSON.stringify({
        version: 7,
        record: {
          identity: { formatVersion: 3, createdAt: 1_700_000_000_000, cwd, isSeeded: false, inheritedEventCount: 0 },
          rows: { title: { ver: 1, seq: 1, val: spec.title ?? null } },
        },
      }, null, 2)}\n`,
    );

    const workspaceId = spec.workspaceId ?? 'ws-1';
    await this.writeWorkspace({
      workspaces: {
        [workspaceId]: {
          path: cwd,
          title: path.basename(cwd),
          sessionIds: await this.workspaceSessionIds(workspaceId, spec.id),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      archived: spec.archived === true ? await this.archivedIds(spec.id) : await this.archivedIds(),
    });

    return { id: spec.id, dir, log, projection };
  }

  /**
   * Read the current workspace unit, if any, and append one session id.
   *
   * @param {string} workspaceId - workspace whose row is being extended.
   * @param {string} sessionId - session to add.
   * @returns {Promise<string[]>} the current membership list plus the new id.
   */
  async workspaceSessionIds(workspaceId, sessionId) {
    const document = await this.readWorkspace();
    const existing = document?.tables?.workspaces?.[workspaceId]?.sessionIds;
    return [...(Array.isArray(existing) ? existing : []), sessionId];
  }

  /**
   * Read the current archive list, optionally appending one id.
   *
   * @param {string} [sessionId] - id to append.
   * @returns {Promise<string[]>} the archive list.
   */
  async archivedIds(sessionId) {
    const document = await this.readWorkspace();
    const existing = document?.global?.archivedSessionIds;
    return [...(Array.isArray(existing) ? existing : []), ...(sessionId === undefined ? [] : [sessionId])];
  }

  /**
   * Read and parse the workspace unit.
   *
   * @returns {Promise<any|undefined>} the parsed document.
   */
  async readWorkspace() {
    try {
      return JSON.parse(await readFile(this.layout.workspaceFile, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Write the workspace unit in its on-disk shape.
   *
   * @param {{ workspaces: Record<string, unknown>, archived: string[] }} state - unit contents.
   * @returns {Promise<void>} resolution after the write.
   */
  async writeWorkspace(state) {
    const document = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(state.workspaces), archivedSessionIds: state.archived },
      tables: { workspaces: state.workspaces },
    };
    await writeFile(this.layout.workspaceFile, `${JSON.stringify(document, null, 2)}\n`);
  }

  /**
   * Whether a path exists.
   *
   * @param {string} target - absolute path.
   * @returns {Promise<boolean>} true when it exists.
   */
  async exists(target) {
    try {
      await readdir(path.dirname(target));
    } catch {
      return false;
    }
    try {
      await readFile(target);
      return true;
    } catch {
      try {
        return (await readdir(target)).length >= 0;
      } catch {
        return false;
      }
    }
  }
}

/** @type {string} */
let root;
/** @type {Fixture} */
let fixture;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dsh-session-admin-test-'));
  fixture = new Fixture(root);
  await fixture.init();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('path encoding', () => {
  it('matches the persistence backend’s session-directory encoding', () => {
    // These exact strings are what the shipped JSONL backend produces; the
    // engine locates a session by recomputing them, so a drift here would make
    // deletions silently find nothing.
    assert.equal(encodeSegment('session-3026d694-435c-4755-9083-7281499a142d'), 'session-3026d694-435c-4755-9083-7281499a142d');
    assert.equal(encodeSegment('.'), '~002E');
    assert.equal(encodeSegment('..'), '~002E~002E');
    assert.equal(encodeSegment('a/b'), 'a~002Fb');
    assert.equal(encodeSegment('a~b'), 'a~007Eb');
    assert.equal(encodeSegment('北'), '~5317');
  });

  it('matches the persistence backend’s project-directory encoding', () => {
    assert.equal(projectKey('/Users/x/project'), '--Users-x-project--');
    assert.equal(projectKey('/Users/lownghoul/Desktop/北京培训'), '--Users-lownghoul-Desktop-~5317~4EAC~57F9~8BAD--');
    assert.equal(projectKey('/a//b'), '--a-b--');
  });
});

describe('session id validation', () => {
  it('accepts real ids and rejects anything that could name a foreign path', () => {
    assert.equal(isSessionId('session-8f2e84bc-3b0d-46d2-bada-f190ff7e9006'), true);
    for (const bad of ['', '../etc/passwd', 'a/b', 'a\\b', '..', '.', 'x'.repeat(129), 'a b', null, 42, 'a\u0000b']) {
      assert.equal(isSessionId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
      assert.throws(() => assertSessionId(bad), InvalidSessionIdError);
    }
  });
});

describe('inspection', () => {
  it('reports every artifact without touching anything', async () => {
    const created = await fixture.addSession({
      id: 'session-inspect-0001',
      title: 'Inspect me',
      cwd: '/tmp/example-project',
      archived: true,
      bytes: 4096,
    });
    const report = await inspectSession({ id: created.id, dshHome: fixture.home, live: false });
    assert.equal(report.title, 'Inspect me');
    assert.equal(report.cwd, '/tmp/example-project');
    assert.equal(report.logFiles.length, 1);
    assert.equal(report.projectionFiles.length, 1);
    assert.equal(report.workspaceMemberships.length, 1);
    assert.equal(report.archivedFlagPresent, true);
    assert.equal(report.storedHeadersAgree, true);
    assert.ok(report.bytesRemoved > 0);
    // inspection is pure
    assert.equal(await fixture.exists(created.log), true);
    const lines = describeInspection(report);
    assert.ok(lines.some((line) => /cannot be undone/i.test(line)));
  });

  it('throws a not-found error for an unknown id', async () => {
    await assert.rejects(
      () => inspectSession({ id: 'session-absent-0001', dshHome: fixture.home, live: false }),
      SessionNotFoundError,
    );
  });

  it('refuses a workspace file that is not a workspace unit', async () => {
    const other = new Fixture(await mkdtemp(path.join(tmpdir(), 'dsh-sa-shape-')));
    await other.init();
    await other.addSession({ id: 'session-shape-0001' });
    await writeFile(other.layout.workspaceFile, '{"unit":{"name":"something-else"},"tables":{},"global":{}}\n');
    await assert.rejects(
      () => inspectSession({ id: 'session-shape-0001', dshHome: other.home, live: false }),
      StorageShapeError,
    );
  });
});

describe('deletion', () => {
  it('removes the log, the projection record, the workspace row and the archive flag', async () => {
    const created = await fixture.addSession({
      id: 'session-delete-0001',
      title: 'Delete me',
      cwd: '/tmp/project-a',
      archived: true,
    });
    const report = await deleteSession({ id: created.id, dshHome: fixture.home, live: false });
    assert.equal(report.sessionId, created.id);
    assert.equal(report.title, 'Delete me');
    assert.equal(await fixture.exists(created.log), false);
    assert.equal(await fixture.exists(created.projection), false);
    const workspace = await fixture.readWorkspace();
    const memberships = Object.values(workspace.tables.workspaces).flatMap((row) => row.sessionIds);
    assert.equal(memberships.includes(created.id), false);
    assert.equal(workspace.global.archivedSessionIds.includes(created.id), false);
    await assert.rejects(
      () => deleteSession({ id: created.id, dshHome: fixture.home, live: false }),
      SessionNotFoundError,
    );
  });

  it('is dry-run safe: nothing changes and the same session is still deletable', async () => {
    const created = await fixture.addSession({ id: 'session-dryrun-0001', title: 'Dry run' });
    const before = await summarizeStore({ dshHome: fixture.home });
    const preview = await deleteSession({ id: created.id, dshHome: fixture.home, live: false, dryRun: true });
    assert.deepEqual(preview.removedPaths, []);
    assert.deepEqual(await summarizeStore({ dshHome: fixture.home }), before);
    assert.equal(await fixture.exists(created.log), true);
    const real = await deleteSession({ id: created.id, dshHome: fixture.home, live: false });
    assert.ok(real.removedPaths.length > 0);
  });

  it('refuses a live session', async () => {
    const created = await fixture.addSession({ id: 'session-live-0001' });
    await assert.rejects(
      () => deleteSession({ id: created.id, dshHome: fixture.home, live: true }),
      LiveSessionError,
    );
    assert.equal(await fixture.exists(created.log), true);
    await assert.rejects(
      () => deleteSession({ id: created.id, dshHome: fixture.home, live: (id) => id === created.id }),
      LiveSessionError,
    );
    assert.equal(await fixture.exists(created.log), true);
  });

  it('moves bytes to the trash when a backup is requested, leaving nothing behind', async () => {
    const created = await fixture.addSession({ id: 'session-backup-0001', title: 'Back me up' });
    const report = await deleteSession({ id: created.id, dshHome: fixture.home, live: false, backup: true });
    assert.equal(await fixture.exists(created.log), false);
    assert.ok(report.backedUpPaths.length >= 2);
    for (const trashPath of report.backedUpPaths) {
      assert.equal(await fixture.exists(trashPath), true);
      assert.ok(trashPath.startsWith(path.join(fixture.home, 'session-admin', 'trash')));
    }
  });

  it('leaves a sibling session in the same project untouched', async () => {
    const survivor = await fixture.addSession({ id: 'session-survivor-0001', cwd: '/tmp/project-b', title: 'Survivor' });
    const doomed = await fixture.addSession({ id: 'session-doomed-0001', cwd: '/tmp/project-b', title: 'Doomed' });
    await deleteSession({ id: doomed.id, dshHome: fixture.home, live: false });
    assert.equal(await fixture.exists(survivor.log), true);
    assert.equal(await fixture.exists(survivor.projection), true);
    const report = await inspectSession({ id: survivor.id, dshHome: fixture.home, live: false });
    assert.equal(report.title, 'Survivor');
  });

  it('removes the project directory once its last session is gone', async () => {
    const only = await fixture.addSession({ id: 'session-lastone-0001', cwd: '/tmp/project-only-child' });
    const projectDir = path.dirname(only.dir);
    await deleteSession({ id: only.id, dshHome: fixture.home, live: false });
    await assert.rejects(() => readdir(projectDir), /ENOENT/);
  });

  it('deletes a raw (uncompressed) log generation too', async () => {
    const created = await fixture.addSession({
      id: 'session-rawlog-0001',
      cwd: '/tmp/project-raw',
      raw: true,
      bytes: 1024,
    });
    const header = await readSessionHeader(created.log);
    assert.equal(header.id, 'session-rawlog-0001');
    await deleteSession({ id: created.id, dshHome: fixture.home, live: false });
    assert.equal(await fixture.exists(created.log), false);
  });

  it('writes a ledger row and leaves no journal behind', async () => {
    const created = await fixture.addSession({ id: 'session-ledger-0001', title: 'Ledger' });
    await deleteSession({ id: created.id, dshHome: fixture.home, live: false });
    const ledger = await readFile(path.join(fixture.home, 'session-admin', 'deletions.jsonl'), 'utf8');
    const rows = ledger.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.sessionId === 'session-ledger-0001' && row.title === 'Ledger'));
    assert.deepEqual(await listPendingDeletions({ dshHome: fixture.home }), []);
  });
});

describe('hostile layouts', () => {
  it('does not delete a directory that merely shares the session id but holds no log', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-hostile-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    // A directory named like a session, but with no canonical log generation.
    const impostor = path.join(layout.sessionsRoot, '--tmp-project--', encodeSegment('session-impostor-0001'));
    await mkdir(impostor, { recursive: true });
    await writeFile(path.join(impostor, 'important.txt'), 'do not delete me\n');
    await assert.rejects(
      () => deleteSession({ id: 'session-impostor-0001', dshHome: home, live: false }),
      SessionNotFoundError,
    );
    assert.equal(await readFile(path.join(impostor, 'important.txt'), 'utf8'), 'do not delete me\n');
  });

  it('ignores a symlinked session directory instead of following it', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-symlink-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-sa-outside-'));
    await writeFile(path.join(outside, 'session.v3.jsonl'), '{"type":"session","version":3}\n');
    const projectDir = path.join(layout.sessionsRoot, '--tmp-link--');
    await mkdir(projectDir, { recursive: true });
    await symlink(outside, path.join(projectDir, encodeSegment('session-linked-0001')), 'dir');
    await assert.rejects(
      () => deleteSession({ id: 'session-linked-0001', dshHome: home, live: false }),
      SessionNotFoundError,
    );
    assert.equal(await readFile(path.join(outside, 'session.v3.jsonl'), 'utf8').then(() => true), true);
  });

  it('survives a missing store entirely', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-empty-'));
    const totals = await summarizeStore({ dshHome: home });
    assert.deepEqual({ sessions: totals.sessions, projects: totals.projects }, { sessions: 0, projects: 0 });
    assert.deepEqual(await listPendingDeletions({ dshHome: home }), []);
    await assert.rejects(
      () => deleteSession({ id: 'session-missing-0001', dshHome: home, live: false }),
      SessionNotFoundError,
    );
  });
});

describe('reporting', () => {
  it('formats sizes legibly', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(2_500_000), '2.4 MiB');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });

  it('reads a projection title and tolerates a missing one', async () => {
    const created = await fixture.addSession({ id: 'session-title-0001', title: 'Cached title' });
    assert.equal(await readProjectionTitle(created.projection), 'Cached title');
    assert.equal(await readProjectionTitle(path.join(fixture.layout.projectionsDir, 'nope.json')), undefined);
  });
});

describe('hardening', () => {
  it('refuses a workspace document carrying a prototype-polluting key', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-proto-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    const projectDir = path.join(layout.sessionsRoot, projectKey('/tmp/proto'));
    const dir = path.join(projectDir, encodeSegment('session-proto-0001'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"session-proto-0001","cwd":"/tmp/proto"}\n');
    await writeFile(
      layout.workspaceFile,
      '{"unit":{"name":"workspace","version":2},"global":{"archivedSessionIds":[]},"tables":{"workspaces":{}},"__proto__":{"polluted":true}}\n',
    );
    await assert.rejects(
      () => deleteSession({ id: 'session-proto-0001', dshHome: home, live: false }),
      (error) => error.code === 'SESSION_ADMIN_STORAGE_SHAPE',
    );
    assert.equal(/** @type {any} */ ({}).polluted, undefined, 'the process prototype must stay clean');
    // The session is untouched because the plan could not be trusted.
    assert.equal(await readFile(path.join(dir, 'session.v3.jsonl'), 'utf8').then(() => true), true);
  });

  it('preserves the mode of the storage file it rewrites', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-mode-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    const projectDir = path.join(layout.sessionsRoot, projectKey('/tmp/mode'));
    const dir = path.join(projectDir, encodeSegment('session-mode-0001'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"session-mode-0001","cwd":"/tmp/mode"}\n');
    await writeFile(
      layout.workspaceFile,
      `${JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { archivedSessionIds: ['session-mode-0001'] },
        tables: { workspaces: { 'ws-1': { path: '/tmp/mode', title: 'mode', sessionIds: ['session-mode-0001'], createdAt: 'x', updatedAt: 'y' } } },
      })}\n`,
      { mode: 0o600 },
    );
    const { chmod, stat: statFile } = await import('node:fs/promises');
    await chmod(layout.workspaceFile, 0o600);
    await deleteSession({ id: 'session-mode-0001', dshHome: home, live: false });
    const after = await statFile(layout.workspaceFile);
    assert.equal(after.mode & 0o777, 0o600, 'a private storage file must stay private');
  });
});

describe('search index disclosure', () => {
  it('names an on-disk search index so the operator is not misled', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-index-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    const projectDir = path.join(layout.sessionsRoot, projectKey('/tmp/index'));
    const dir = path.join(projectDir, encodeSegment('session-index-0001'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"session-index-0001","cwd":"/tmp/index"}\n');

    const withoutIndex = await inspectSession({ id: 'session-index-0001', dshHome: home, live: false });
    assert.equal(withoutIndex.searchIndex, null);
    assert.equal(describeInspection(withoutIndex).some((line) => /search index/.test(line)), false);

    const withIndex = await inspectSession({
      id: 'session-index-0001',
      dshHome: home,
      live: false,
      searchIndex: '/var/lib/dsh/session-query.sqlite',
    });
    assert.equal(withIndex.searchIndex, '/var/lib/dsh/session-query.sqlite');
    assert.ok(describeInspection(withIndex).some((line) => line.includes('/var/lib/dsh/session-query.sqlite')));
  });
});

describe('resume race', () => {
  it('refuses when the session becomes live between planning and removal', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-sa-race-'));
    const layout = resolveLayout({ dshHome: home });
    await mkdir(layout.projectionsDir, { recursive: true });
    const projectDir = path.join(layout.sessionsRoot, projectKey('/tmp/race'));
    const dir = path.join(projectDir, encodeSegment('session-race-0001'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"session-race-0001","cwd":"/tmp/race"}\n');
    await writeFile(
      path.join(layout.projectionsDir, 'session-race-0001.json'),
      '{"version":7,"record":{"identity":{},"rows":{"title":{"ver":1,"seq":1,"val":"Race"}}}}\n',
    );
    // Cold when planned, live by the time the log would be removed.
    let asked = 0;
    await assert.rejects(
      () => deleteSession({
        id: 'session-race-0001',
        dshHome: home,
        live: false,
        isLiveNow: () => {
          asked += 1;
          return true;
        },
      }),
      LiveSessionError,
    );
    assert.ok(asked >= 1, 'the engine must re-ask before writing anything');
    // Nothing was written at all: the log, the projection record and the
    // workspace membership all survive, so the user can simply try again.
    assert.equal(await readFile(path.join(dir, 'session.v3.jsonl'), 'utf8').then(() => true), true);
    assert.equal(await readFile(path.join(layout.projectionsDir, 'session-race-0001.json'), 'utf8').then(() => true), true);
    const surviving = await inspectSession({ id: 'session-race-0001', dshHome: home, live: false });
    assert.equal(surviving.title, 'Race');
  });
});
