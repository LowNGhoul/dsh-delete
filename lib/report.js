/**
 * Presentation helpers shared by the host surface and its browser half.
 *
 * Everything here is a pure function over plain JSON: a deletion report is
 * turned into the lines a human reads, and a byte count into something
 * legible. Keeping it dependency-free lets the browser bundle and the host
 * agree on wording without shipping a UI framework across the wire.
 *
 * @module dsh-session-admin/report
 */

/**
 * Format a byte count for humans.
 *
 * @param {number} bytes - non-negative byte count.
 * @returns {string} a short human-readable size.
 */
export function formatBytes(bytes) {
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
 * Describe a workspace membership in one phrase.
 *
 * @param {{ title?: string, path?: string }} membership - one workspace row.
 * @returns {string} the phrase, falling back to the recorded path.
 */
export function describeMembership(membership) {
  const title = typeof membership.title === 'string' && membership.title.length > 0 ? membership.title : undefined;
  const dir = typeof membership.path === 'string' && membership.path.length > 0 ? membership.path : undefined;
  if (title !== undefined && dir !== undefined) return `${title} (${dir})`;
  return title ?? dir ?? 'an unnamed workspace';
}

/**
 * Render the lines a confirmation surface shows before a deletion.
 *
 * @param {Record<string, any>} inspection - an `inspectSession` report.
 * @returns {string[]} the lines, in reading order.
 */
export function describeInspection(inspection) {
  const lines = [];
  const title = typeof inspection.title === 'string' && inspection.title.length > 0 ? inspection.title : '(untitled)';
  lines.push(`Session: ${inspection.sessionId}`);
  lines.push(`Title: ${title}`);
  if (typeof inspection.cwd === 'string' && inspection.cwd.length > 0) lines.push(`Project: ${inspection.cwd}`);
  lines.push(`Stored size: ${formatBytes(inspection.bytesRemoved ?? 0)}`);
  const logs = Array.isArray(inspection.logFiles) ? inspection.logFiles.length : 0;
  const projections = Array.isArray(inspection.projectionFiles) ? inspection.projectionFiles.length : 0;
  lines.push(`Artifacts: ${logs} session log file(s), ${projections} projection record(s)`);
  const memberships = Array.isArray(inspection.workspaceMemberships) ? inspection.workspaceMemberships : [];
  if (memberships.length > 0) {
    lines.push(`Workspace rows: ${memberships.map((row) => describeMembership(row)).join(', ')}`);
  }
  if (inspection.archivedFlagPresent === true) lines.push('Also clears this session from the archive list.');
  if (typeof inspection.searchIndex === 'string' && inspection.searchIndex.length > 0) {
    lines.push(`Note: this deployment keeps a full-text search index at ${inspection.searchIndex}, which still holds a copy until dsh restarts.`);
  }
  const attachments = Array.isArray(inspection.attachmentReferences) ? inspection.attachmentReferences.length : 0;
  if (attachments > 0) {
    lines.push(`Shares ${attachments} content-addressed attachment(s), which are kept because other sessions may use them.`);
  }
  if (inspection.storedHeadersAgree === false) {
    lines.push('Warning: the file on disk declares a different session id than the one requested.');
  }
  lines.push('This cannot be undone.');
  return lines;
}

/**
 * Render the lines a settled deletion shows.
 *
 * @param {Record<string, any>} report - a `deleteSession` report.
 * @returns {string[]} the lines, in reading order.
 */
export function describeDeletion(report) {
  const title = typeof report.title === 'string' && report.title.length > 0 ? `“${report.title}”` : '(untitled)';
  const lines = [`Permanently deleted ${title} — ${report.sessionId}.`];
  lines.push(`Freed ${formatBytes(report.bytesRemoved ?? 0)} across ${(report.removedPaths ?? []).length} path(s).`);
  const backedUp = Array.isArray(report.backedUpPaths) ? report.backedUpPaths.length : 0;
  if (backedUp > 0) lines.push(`Moved ${backedUp} path(s) into the trash directory instead of unlinking them.`);
  const memberships = Array.isArray(report.workspaceMemberships) ? report.workspaceMemberships : [];
  if (memberships.length > 0) lines.push(`Removed from ${memberships.length} workspace row(s).`);
  if (report.archivedFlagPresent === true) lines.push('Cleared from the archive list.');
  return lines;
}

/**
 * Narrow one deletion report to the fields a browser surface needs.
 *
 * The engine's report is host-shaped: it carries absolute filesystem paths that
 * a page has no use for. This projection keeps the facts a user is shown and
 * drops the rest, so nothing leaks into the browser by accident.
 *
 * @param {Record<string, any>} report - a `deleteSession` report.
 * @returns {{ sessionId: string, title: string|null, bytesRemoved: number, removedCount: number, backedUpCount: number, workspaceCount: number, clearedArchive: boolean, attachmentCount: number }} a browser-safe summary.
 */
export function summarizeDeletionForBrowser(report) {
  return {
    sessionId: String(report.sessionId ?? ''),
    title: typeof report.title === 'string' ? report.title : null,
    bytesRemoved: Number(report.bytesRemoved ?? 0),
    removedCount: Array.isArray(report.removedPaths) ? report.removedPaths.length : 0,
    backedUpCount: Array.isArray(report.backedUpPaths) ? report.backedUpPaths.length : 0,
    workspaceCount: Array.isArray(report.workspaceMemberships) ? report.workspaceMemberships.length : 0,
    clearedArchive: report.archivedFlagPresent === true,
    attachmentCount: Array.isArray(report.attachmentReferences) ? report.attachmentReferences.length : 0,
  };
}

/**
 * Narrow one inspection report to the fields a browser surface needs.
 *
 * @param {Record<string, any>} inspection - an `inspectSession` report.
 * @returns {{ sessionId: string, title: string|null, cwd: string|null, live: boolean, bytesRemoved: number, logCount: number, projectionCount: number, workspaceCount: number, clearedArchive: boolean, attachmentCount: number, lines: string[] }} a browser-safe summary.
 */
export function summarizeInspectionForBrowser(inspection) {
  return {
    sessionId: String(inspection.sessionId ?? ''),
    title: typeof inspection.title === 'string' ? inspection.title : null,
    cwd: typeof inspection.cwd === 'string' ? inspection.cwd : null,
    live: inspection.live === true,
    bytesRemoved: Number(inspection.bytesRemoved ?? 0),
    logCount: Array.isArray(inspection.logFiles) ? inspection.logFiles.length : 0,
    projectionCount: Array.isArray(inspection.projectionFiles) ? inspection.projectionFiles.length : 0,
    workspaceCount: Array.isArray(inspection.workspaceMemberships) ? inspection.workspaceMemberships.length : 0,
    clearedArchive: inspection.archivedFlagPresent === true,
    attachmentCount: Array.isArray(inspection.attachmentReferences) ? inspection.attachmentReferences.length : 0,
    searchIndexNotice: typeof inspection.searchIndex === 'string' && inspection.searchIndex.length > 0,
    lines: describeInspection(inspection),
  };
}
