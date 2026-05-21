'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SESSION_SCHEMA = 'xmux.session.v1';
const SESSION_SCHEMA_VERSION = 1;
const SESSION_ROLES = new Set(['codex', 'claude']);

function safeComponent(value, field) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') throw new Error(`${field} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  return text;
}

function safeRole(role) {
  const text = String(role || '').trim();
  if (!SESSION_ROLES.has(text)) throw new Error(`session role must be one of: ${[...SESSION_ROLES].join(', ')}`);
  return text;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function unifiedSessionsDir(root) {
  return path.join(root, 'sessions');
}

function legacySessionsDir(role, root) {
  return path.join(root, safeRole(role), 'sessions');
}

function legacySessionPath(role, name, root) {
  return path.join(legacySessionsDir(role, root), `${safeComponent(name, 'session')}.json`);
}

function unifiedSessionId(role, name) {
  return `${safeRole(role)}--${safeComponent(name, 'session')}`;
}

function unifiedSessionPath(role, name, root) {
  return path.join(unifiedSessionsDir(root), `${unifiedSessionId(role, name)}.json`);
}

function sessionStatus(session = {}) {
  if (session.active === false) return 'terminated';
  if (['active', 'draining', 'terminated'].includes(session.status)) return session.status;
  return 'active';
}

function sessionTerminatedAt(session = {}, status = sessionStatus(session)) {
  if (status !== 'terminated') return null;
  return session.terminated_at
    || session.exited_at
    || session.pane_killed_at
    || session.pane_exited_at
    || session.updated_at
    || null;
}

function sessionTransport(session = {}) {
  const transport = {
    backend: session.transport_backend || 'pane',
  };
  if (session.pane) transport.pane = session.pane;
  if (session.socket_path) transport.socket_path = session.socket_path;
  if (session.pane_launch_id) transport.launch_id = session.pane_launch_id;
  if (session.pane_ready_at) transport.ready_at = session.pane_ready_at;
  return transport;
}

function unifiedSessionFromLegacy(role, session = {}) {
  const cleanRole = safeRole(role);
  const cleanName = safeComponent(session.name, 'session');
  const status = sessionStatus(session);
  const updatedAt = session.updated_at || new Date().toISOString();
  const doc = {
    ...session,
    schema: SESSION_SCHEMA,
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: unifiedSessionId(cleanRole, cleanName),
    role: cleanRole,
    name: cleanName,
    status,
    transport: sessionTransport(session),
    created_at: session.created_at || updatedAt,
    updated_at: updatedAt,
    terminated_at: sessionTerminatedAt(session, status),
  };
  if (cleanRole === 'claude' && session.claude_session_id) {
    doc.provider_session_id = session.claude_session_id;
  }
  return doc;
}

function writeUnifiedSession(role, session, root) {
  const doc = unifiedSessionFromLegacy(role, session);
  writeJson(unifiedSessionPath(role, doc.name, root), doc);
  return doc;
}

function legacySchemaForRole(role) {
  return safeRole(role) === 'codex' ? 'xmux.codex.session.v1' : 'xmux.claude.session.v1';
}

function legacySessionMirror(session) {
  const doc = { ...session, schema: legacySchemaForRole(session.role || session.schema_role || 'codex') };
  delete doc.schema_version;
  delete doc.session_id;
  delete doc.role;
  delete doc.status;
  delete doc.transport;
  delete doc.terminated_at;
  delete doc.provider_session_id;
  delete doc.schema_role;
  return doc;
}

function writeLegacySessionMirror(role, session, root) {
  const cleanRole = safeRole(role);
  const cleanName = safeComponent(session && session.name, 'session');
  const filePath = legacySessionPath(cleanRole, cleanName, root);
  if (!fs.existsSync(filePath)) return null;
  writeJson(filePath, legacySessionMirror({ ...session, schema_role: cleanRole }));
  return filePath;
}

function readUnifiedSession(role, name, root) {
  return readJson(unifiedSessionPath(role, name, root), null);
}

function listUnifiedSessions(root) {
  const dir = unifiedSessionsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name), null))
    .filter((item) => item && item.schema === SESSION_SCHEMA)
    .sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));
}

function epochMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldReplaceUnifiedSession(existing, legacy) {
  if (!existing || existing.schema !== SESSION_SCHEMA) return true;
  const existingMs = epochMs(existing.updated_at || existing.created_at);
  const legacyMs = epochMs(legacy.updated_at || legacy.created_at);
  return legacyMs > existingMs;
}

function legacySessionResidue(root) {
  const items = [];
  for (const role of SESSION_ROLES) {
    const dir = legacySessionsDir(role, root);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    if (files.length) items.push({ role, path: dir, files });
  }
  return items;
}

function migrateLegacySessions(root, opts = {}) {
  const dryRun = Boolean(opts.dry_run || opts.dryRun);
  const removeLegacy = Boolean(opts.remove_legacy || opts.removeLegacy);
  const migrated = [];
  const skipped = [];
  const removed = [];
  const warnings = [];

  for (const role of SESSION_ROLES) {
    const dir = legacySessionsDir(role, root);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const cleanupCandidates = [];
    const cleanupCandidateSet = new Set();
    for (const fileName of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const from = path.join(dir, fileName);
      const legacy = readJson(from, null);
      if (!legacy || !legacy.name) {
        warnings.push(`legacy ${role} session is unreadable: ${from}`);
        continue;
      }
      let doc;
      try {
        doc = unifiedSessionFromLegacy(role, legacy);
      } catch (error) {
        warnings.push(`legacy ${role} session cannot be migrated from ${from}: ${error.message || String(error)}`);
        continue;
      }
      const to = unifiedSessionPath(role, doc.name, root);
      const existing = readJson(to, null);
      if (!shouldReplaceUnifiedSession(existing, legacy)) {
        skipped.push({ role, name: doc.name, from, to, reason: 'unified_session_is_newer_or_same_age' });
        if (removeLegacy) {
          cleanupCandidates.push(from);
          cleanupCandidateSet.add(from);
        }
        continue;
      }
      if (!dryRun) writeJson(to, doc);
      migrated.push({ role, name: doc.name, from, to });
      if (removeLegacy) {
        cleanupCandidates.push(from);
        cleanupCandidateSet.add(from);
      }
    }
    if (removeLegacy) {
      for (const from of cleanupCandidates) {
        if (!dryRun) fs.rmSync(from, { force: true });
        removed.push(from);
      }
      const entries = fs.readdirSync(dir);
      const canRemoveDir = dryRun
        ? entries.every((entry) => cleanupCandidateSet.has(path.join(dir, entry)))
        : entries.length === 0;
      if (canRemoveDir) {
        if (!dryRun) fs.rmdirSync(dir);
        removed.push(dir);
      }
    }
  }

  return { migrated, skipped, removed, warnings };
}

module.exports = {
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  legacySessionPath,
  legacySessionsDir,
  legacySessionResidue,
  migrateLegacySessions,
  unifiedSessionsDir,
  unifiedSessionId,
  unifiedSessionPath,
  unifiedSessionFromLegacy,
  writeUnifiedSession,
  writeLegacySessionMirror,
  readUnifiedSession,
  listUnifiedSessions,
};
