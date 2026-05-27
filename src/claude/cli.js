'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main: claudeSetupMain } = require('./setup');
const {
  listUnifiedSessions,
  readUnifiedSession,
  unifiedSessionPath,
  writeLegacySessionMirror,
  writeUnifiedSession,
} = require('../xmux/session-state');
const {
  appendExecutorEvent,
  appendRouteEvent,
  findExecutorEvent,
} = require('../xmux/workflow-state');
const {
  markerEntry,
  parsePhaseMarker,
  phaseEntry,
  phaseMarker,
} = require('../xmux/phase-registry');

const SCHEMA_SESSION = 'xmux.claude.session.v1';
const SCHEMA_REQUEST = 'xmux.claude.request.v2';
const DEFAULT_SESSION = 'default';
const COMMAND_NAME = 'xmux-codex';
const CODEX_REQUEST_NAME = 'xmux-codex-request';
const CODEX_RESPONSE_NAME = 'xmux-codex-response';
const CLAUDE_REQUEST_NAME = 'xmux-claude-request';
const CLAUDE_RESPONSE_NAME = 'xmux-claude-response';
const CODEX_REQUEST_MARKER = `[${CODEX_REQUEST_NAME}]`;
const CODEX_RESPONSE_MARKER = `[${CODEX_RESPONSE_NAME}]`;
const CLAUDE_REQUEST_MARKER = `[${CLAUDE_REQUEST_NAME}]`;
const CLAUDE_RESPONSE_MARKER = `[${CLAUDE_RESPONSE_NAME}]`;
const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
const XMUX_HOMEBREW_FORMULAS = ['xmux', 'xmux-beta'];
const SESSION_EXIT_CLEANUP_SETTLE_MS = 100;
const SESSION_EXIT_MARKER_FIELDS = [
  'exited_at',
  'exit_code',
  'exit_signal',
  'socket_removed_at',
  'pane_killed_at',
  'pane_exited_at',
];
const SESSION_VOLATILE_FIELDS = [
  'active_request',
  'active_outbound_request',
  'pending_response',
];

function nowTs() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z/, '$1Z');
}

function expandUser(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function projectRoot(start = process.cwd()) {
  let current = path.resolve(expandUser(start));
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(expandUser(start));
    current = parent;
  }
}

function stateRoot() {
  if (process.env.XMUX_STATE_DIR) return path.resolve(expandUser(process.env.XMUX_STATE_DIR));
  if (process.env.XMUX_PROJECT_DIR) return path.join(path.resolve(expandUser(process.env.XMUX_PROJECT_DIR)), '.codex', 'xmux');
  return path.join(projectRoot(), '.codex', 'xmux');
}

function stateRootForProject(projectDirValue) {
  return path.join(path.resolve(expandUser(projectDirValue)), '.codex', 'xmux');
}

function hookProjectRoot(input = {}) {
  if (process.env.XMUX_PROJECT_DIR) return path.resolve(expandUser(process.env.XMUX_PROJECT_DIR));
  const cwd = input.cwd || input.currentWorkingDirectory || process.cwd();
  return projectRoot(cwd);
}

function hookStateRoot(input = {}, opts = {}) {
  const root = process.env.XMUX_STATE_DIR
    ? path.resolve(expandUser(process.env.XMUX_STATE_DIR))
    : stateRootForProject(hookProjectRoot(input));
  if (opts.requireExisting && !fs.existsSync(root)) return null;
  return root;
}

function xmuxRuntimeShellPath(root) {
  return path.join(path.resolve(expandUser(root)), 'runtime', 'shell', 'xmux.zsh');
}

function hasXmuxRuntime(root) {
  const resolved = path.resolve(expandUser(root));
  return fs.existsSync(xmuxRuntimeShellPath(resolved)) || fs.existsSync(path.join(resolved, 'xmux.zsh'));
}

function stableHomebrewInstallRoot(value) {
  return path.resolve(expandUser(value));
}

function installRoot() {
  const raw = process.env.XMUX_INSTALL_DIR
    ? path.resolve(expandUser(process.env.XMUX_INSTALL_DIR))
    : path.resolve(__dirname, '..', '..');
  return stableHomebrewInstallRoot(raw);
}

function claudeRoot(root = stateRoot()) {
  return path.join(root, 'claude');
}

function codexRoot(root = stateRoot()) {
  return path.join(root, 'codex');
}

function sessionsDir(root = stateRoot()) {
  return path.join(root, 'sessions');
}

function requestsDir(root = stateRoot()) {
  return path.join(claudeRoot(root), 'requests');
}

function responsesDir(root = stateRoot()) {
  return path.join(claudeRoot(root), 'responses');
}

function socketPath(name, root = stateRoot()) {
  const safeName = safeComponent(name, 'session');
  const digest = sha256(path.resolve(root)).slice(0, 12);
  const dir = process.env.XMUX_CLAUDE_SOCKET_DIR
    ? path.resolve(expandUser(process.env.XMUX_CLAUDE_SOCKET_DIR))
    : '/tmp';
  return path.join(dir, `xmux-claude-${digest}-${safeName}.sock`);
}

function eventsPath(root = stateRoot()) {
  return path.join(claudeRoot(root), 'events.jsonl');
}

function safeComponent(value, field) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') throw new Error(`${field} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  return text;
}

function requestId() {
  return `req-${crypto.randomBytes(12).toString('hex')}`;
}

function nonce() {
  return crypto.randomBytes(24).toString('hex');
}

function launchId() {
  return `launch-${crypto.randomBytes(12).toString('hex')}`;
}

function responseNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalPrompt(text) {
  return String(text || '').trimEnd();
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function bodySizeLimit() {
  return Number(process.env.XMUX_BODY_MAX_BYTES || 1048576);
}

function debugPreserveBody() {
  return process.env.XMUX_DEBUG_PRESERVE_BODY === '1';
}

function sanitizeTitle(value, fallback = 'XMux message') {
  let text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '');
  if (!text) text = fallback;
  if (text.length > 80) text = `${text.slice(0, 77).trimEnd()}...`;
  return text;
}

function titleFromText(text, fallback = 'XMux request') {
  const firstLine = canonicalPrompt(text).split(/\r?\n/).find((line) => line.trim()) || '';
  return sanitizeTitle(firstLine, fallback);
}

function responseTitleFromText(text) {
  const body = canonicalPrompt(text);
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) || '';
  if (firstLine) return sanitizeTitle(firstLine, 'Claude response');
  return 'Claude response';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeTextAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, String(text), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendEvent(event, data = {}, root = stateRoot()) {
  ensureDir(path.dirname(eventsPath(root)));
  const record = { ts: nowTs(), event, data };
  fs.appendFileSync(eventsPath(root), `${JSON.stringify(record)}\n`, 'utf8');
}

function sessionPath(name, root = stateRoot()) {
  return unifiedSessionPath('claude', name, root);
}

function requestPath(id, root = stateRoot()) {
  return path.join(requestsDir(root), `${safeComponent(id, 'request_id')}.json`);
}

function promptPath(id, root = stateRoot()) {
  return path.join(requestsDir(root), `${safeComponent(id, 'request_id')}.prompt.md`);
}

function responsePath(id, root = stateRoot()) {
  return path.join(responsesDir(root), `${safeComponent(id, 'request_id')}.md`);
}

function readSession(name, root = stateRoot()) {
  return readUnifiedSession('claude', name, root);
}

function writeSession(session, root = stateRoot()) {
  const written = writeUnifiedSession('claude', session, root);
  writeLegacySessionMirror('claude', written, root);
  return written;
}

function clearSessionExitMarkers(session) {
  if (!session) return session;
  for (const field of SESSION_EXIT_MARKER_FIELDS) delete session[field];
  return session;
}

function clearSessionVolatileState(session) {
  if (!session) return session;
  for (const field of SESSION_VOLATILE_FIELDS) delete session[field];
  return session;
}

function listSessions(root = stateRoot()) {
  ensureDir(sessionsDir(root));
  return listUnifiedSessions(root)
    .filter((item) => item.role === 'claude')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function ensureSession(name = DEFAULT_SESSION, options = {}, root = stateRoot()) {
  const cleanName = safeComponent(name || DEFAULT_SESSION, 'session');
  const existing = readSession(cleanName, root);
  const ts = nowTs();
  const next = existing || {
    schema: SCHEMA_SESSION,
    name: cleanName,
    created_at: ts,
    active: true,
  };
  next.updated_at = ts;
  next.active = options.active !== undefined ? Boolean(options.active) : next.active !== false;
  next.transport_backend = options.transportBackend || next.transport_backend || 'pane';
  if (options.splitRequested !== undefined) next.split_requested = Boolean(options.splitRequested);
  writeSession(next, root);
  return next;
}

function findSessionByClaudeId(claudeSessionId, root = stateRoot()) {
  if (!claudeSessionId) return null;
  return listSessions(root).find((session) => session.claude_session_id === claudeSessionId) || null;
}

function uniqueActiveSession(root = stateRoot()) {
  const active = listSessions(root).filter((session) => session.active !== false);
  return active.length === 1 ? active[0] : null;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (['json', 'wait', 'split', 'stdin', 'raw', 'dry-run', 'quiet', 'clear'].includes(key)) {
      out[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`--${key} requires a value`);
    out[key] = argv[++i];
  }
  return out;
}

function readStdinRequired() {
  if (process.stdin.isTTY) throw new Error('--stdin was requested but stdin is a TTY');
  return fs.readFileSync(0, 'utf8');
}

function readPrompt(opts, root = stateRoot()) {
  if (opts.stdin) return readStdinRequired();
  if (opts.prompt !== undefined) return String(opts.prompt);
  throw new Error('provide --prompt or --stdin');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function epochMs(ts) {
  const parsed = Date.parse(String(ts || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readyTimeoutMs(opts = {}) {
  return Number(opts['ready-timeout'] || process.env.XMUX_CLAUDE_READY_TIMEOUT_MS || 15000);
}

function fallbackStartupDelayMs(opts = {}) {
  return Number(
    opts['fallback-startup-delay']
    || opts['startup-delay']
    || process.env.XMUX_CLAUDE_FALLBACK_STARTUP_DELAY_MS
    || process.env.XMUX_CLAUDE_STARTUP_DELAY_MS
    || 0
  );
}

function postFallbackReadyTimeoutMs(opts = {}) {
  return Number(
    opts['post-fallback-ready-timeout']
    || process.env.XMUX_CLAUDE_POST_FALLBACK_READY_TIMEOUT_MS
    || 1000
  );
}

function projectDir() {
  if (process.env.XMUX_PROJECT_DIR) return path.resolve(expandUser(process.env.XMUX_PROJECT_DIR));
  return projectRoot();
}

function xmuxBinPath() {
  const candidate = path.join(installRoot(), 'bin', 'xmux');
  return fs.existsSync(candidate) ? candidate : 'xmux';
}

function xmuxCommandBinForInstallDir(xmuxInstallDir) {
  const installDir = path.resolve(expandUser(xmuxInstallDir));
  const parts = installDir.split(path.sep).filter(Boolean);
  const prefix = installDir.startsWith(path.sep) ? `${path.sep}${parts[0]}${path.sep}${parts[1]}` : '';
  if (!HOMEBREW_PREFIXES.includes(prefix)) return path.join(installDir, 'bin');
  const rest = parts.slice(2);
  if (
    rest.length === 3
    && rest[0] === 'opt'
    && XMUX_HOMEBREW_FORMULAS.includes(rest[1])
    && rest[2] === 'libexec'
  ) {
    return path.join(prefix, 'bin');
  }
  if (
    rest.length === 4
    && rest[0] === 'Cellar'
    && XMUX_HOMEBREW_FORMULAS.includes(rest[1])
    && rest[3] === 'libexec'
  ) {
    return path.join(prefix, 'Cellar', rest[1], rest[2], 'bin');
  }
  return path.join(installDir, 'bin');
}

function pathWithXmuxCommandBin(basePath = process.env.PATH || '') {
  const commandBin = xmuxCommandBinForInstallDir(installRoot());
  const parts = String(basePath || '')
    .split(path.delimiter)
    .filter((part) => part && path.resolve(expandUser(part)) !== path.resolve(commandBin));
  return [commandBin, ...parts].join(path.delimiter);
}

function runTmux(args, options = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw new Error(`tmux ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`tmux ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function runTmuxQuiet(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function currentTmuxPane() {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  return runTmux(['display-message', '-p', '#{pane_id}']);
}

function tmuxProbeFailureReason(result) {
  const error = result && result.error ? String(result.error.message || result.error) : '';
  const code = result && result.error && result.error.code ? String(result.error.code) : '';
  const stderr = String(result && result.stderr ? result.stderr : '').trim();
  const text = `${code}\n${error}\n${stderr}`;
  if (/can't find pane|pane .*not found|no such pane|can't find window|can't find session/i.test(text)) return 'pane_not_found';
  if (code === 'ENOENT' || /command not found|tmux: not found/i.test(text)) return 'tmux_not_found';
  if (/operation not permitted|permission denied|access denied/i.test(text)) return 'tmux_access_denied';
  if (/error connecting to|no server running|failed to connect|connection refused/i.test(text)) return 'tmux_unavailable';
  return 'tmux_probe_failed';
}

function tmuxPaneProbe(pane) {
  if (!pane) return { alive: false, reason: 'pane_missing' };
  const result = spawnSync('tmux', ['display-message', '-pt', pane, '#{pane_dead}'], { encoding: 'utf8' });
  if (result.status === 0) {
    const dead = String(result.stdout || '').trim();
    if (dead === '0') return { alive: true, reason: 'alive' };
    if (dead === '1') return { alive: false, reason: 'pane_dead' };
    return { alive: false, reason: 'tmux_probe_failed' };
  }
  return { alive: false, reason: tmuxProbeFailureReason(result) };
}

function tmuxPaneAlive(pane) {
  return tmuxPaneProbe(pane).alive;
}

function tmuxPaneWindowKey(pane) {
  if (!pane) return '';
  const result = spawnSync('tmux', ['display-message', '-pt', pane, '#{session_id}\t#{window_id}'], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function sameTmuxWindow(leftPane, rightPane) {
  const left = tmuxPaneWindowKey(leftPane);
  const right = tmuxPaneWindowKey(rightPane);
  return Boolean(left && right && left === right);
}

function socketPathExists(sock) {
  if (!sock) return false;
  try {
    return fs.existsSync(sock);
  } catch (_) {
    return false;
  }
}

function listCodexSessions(root = stateRoot()) {
  return listUnifiedSessions(root)
    .filter((item) => item.role === 'codex')
    .sort((a, b) => {
      const left = Date.parse(a.updated_at || a.created_at || '') || 0;
      const right = Date.parse(b.updated_at || b.created_at || '') || 0;
      return right - left;
    });
}

function readCodexSession(name, root = stateRoot()) {
  return readUnifiedSession('codex', name, root);
}

function codexContextErrorMessage(context, action) {
  const reason = context && context.reason ? context.reason : 'unknown';
  const sessionName = context && context.sessionName ? ` '${context.sessionName}'` : '';
  if (isTmuxProbeUnavailableReason(reason)) {
    return `${action} could not verify the active Codex pane in the current XMux tmux window${sessionName}; reason: ${reason}`;
  }
  return `${action} requires an active Codex pane in the current XMux tmux window${sessionName}; reason: ${reason}`;
}

function isTmuxProbeUnavailableReason(reason) {
  return reason === 'tmux_access_denied' || reason === 'tmux_unavailable' || reason === 'tmux_not_found' || reason === 'tmux_probe_failed';
}

function firstTmuxProbeUnavailableReason(probes = []) {
  for (const probe of probes) {
    if (probe && isTmuxProbeUnavailableReason(probe.reason)) return probe.reason;
  }
  return '';
}

function resolveCodexPaneContext(root = stateRoot()) {
  const envSession = String(process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '').trim();
  const paneProbes = new Map();
  const probePane = (pane) => {
    if (!pane) return null;
    if (!paneProbes.has(pane)) paneProbes.set(pane, tmuxPaneProbe(pane));
    return paneProbes.get(pane);
  };
  const referenceProbe = process.env.TMUX_PANE ? probePane(process.env.TMUX_PANE) : null;
  const referencePane = referenceProbe && referenceProbe.alive ? process.env.TMUX_PANE : '';
  const sessions = listCodexSessions(root);
  const probedCandidates = [];
  const aliveCandidates = sessions.filter((session) => {
    if (!session || session.active === false || !session.pane) return false;
    const probe = probePane(session.pane);
    probedCandidates.push({ session, probe });
    return probe && probe.alive;
  });

  if (!referencePane) {
    if (envSession) {
      const selected = aliveCandidates.find((session) => session.name === envSession) || null;
      if (selected) {
        return {
          sessionName: selected.name || '',
          pane: selected.pane || '',
          referencePane: selected.pane || '',
          referencePaneSource: 'codex-session-state',
        };
      }
      if (aliveCandidates.length === 1) {
        const fallback = aliveCandidates[0];
        return {
          sessionName: fallback.name || '',
          pane: fallback.pane || '',
          referencePane: fallback.pane || '',
          referencePaneSource: 'codex-session-state',
        };
      }
      if (aliveCandidates.length > 1) {
        return { sessionName: '', pane: '', reason: 'ambiguous_codex_session_without_tmux_context' };
      }
      const envRecord = sessions.find((session) => session && session.name === envSession) || null;
      const envProbe = envRecord && envRecord.pane ? probePane(envRecord.pane) : null;
      const tmuxReason = firstTmuxProbeUnavailableReason([referenceProbe, envProbe, ...probedCandidates.map((item) => item.probe)]);
      if (tmuxReason) return { sessionName: envSession, pane: '', reason: tmuxReason };
      if (envRecord && envRecord.active !== false && !envRecord.pane) {
        return { sessionName: envSession, pane: '', reason: 'codex_pane_missing' };
      }
      if (envRecord && envProbe && (envProbe.reason === 'pane_dead' || envProbe.reason === 'pane_not_found')) {
        return { sessionName: envSession, pane: envRecord.pane || '', reason: 'codex_pane_not_alive' };
      }
      return { sessionName: envSession, pane: '', reason: 'codex_session_not_active' };
    }
    if (aliveCandidates.length === 1) {
      const selected = aliveCandidates[0];
      return {
        sessionName: selected.name || '',
        pane: selected.pane || '',
        referencePane: selected.pane || '',
        referencePaneSource: 'codex-session-state',
      };
    }
    if (aliveCandidates.length > 1) {
      return { sessionName: '', pane: '', reason: 'ambiguous_codex_session_without_tmux_context' };
    }
    const tmuxReason = firstTmuxProbeUnavailableReason([referenceProbe, ...probedCandidates.map((item) => item.probe)]);
    if (tmuxReason) return { sessionName: '', pane: '', reason: tmuxReason };
    return { sessionName: '', pane: '', reason: 'no_tmux_pane_context' };
  }

  const sameWindowCandidates = aliveCandidates.filter((session) => sameTmuxWindow(session.pane, referencePane));
  if (envSession) {
    const selected = sameWindowCandidates.find((session) => session.name === envSession) || null;
    if (selected) return { sessionName: selected.name || '', pane: selected.pane || '', referencePane };
    const envAlive = aliveCandidates.find((session) => session.name === envSession);
    if (sameWindowCandidates.length === 1) {
      const fallback = sameWindowCandidates[0];
      return { sessionName: fallback.name || '', pane: fallback.pane || '', referencePane };
    }
    if (sameWindowCandidates.length > 1) {
      return { sessionName: '', pane: '', referencePane, reason: 'ambiguous_current_window_codex_session' };
    }
    const envRecord = sessions.find((session) => session && session.name === envSession) || null;
    const envProbe = envRecord && envRecord.pane ? probePane(envRecord.pane) : null;
    const tmuxReason = firstTmuxProbeUnavailableReason([envProbe, ...probedCandidates.map((item) => item.probe)]);
    if (tmuxReason) return { sessionName: envSession, pane: '', referencePane, reason: tmuxReason };
    return {
      sessionName: envSession,
      pane: '',
      referencePane,
      reason: envAlive ? 'codex_session_not_in_current_window' : 'codex_session_not_active',
    };
  }

  if (sameWindowCandidates.length === 1) {
    const selected = sameWindowCandidates[0];
    return { sessionName: selected.name || '', pane: selected.pane || '', referencePane };
  }
  if (sameWindowCandidates.length > 1) {
    return { sessionName: '', pane: '', referencePane, reason: 'ambiguous_current_window_codex_session' };
  }
  return { sessionName: '', pane: '', referencePane, reason: 'no_current_window_codex_session' };
}

function decorateSessionRuntime(session) {
  const out = { ...session };
  const paneAlive = tmuxPaneAlive(session && session.pane);
  const socketExists = socketPathExists(session && session.socket_path);
  let runtimeStatus = session && session.active === false ? 'inactive' : 'active';
  const staleReasons = [];
  if (runtimeStatus === 'active' && (session.transport_backend || 'pane') === 'pane') {
    if (session.pane && !paneAlive) staleReasons.push('pane_not_alive');
    if (session.socket_path && !socketExists) staleReasons.push('socket_missing');
    if (!session.pane) staleReasons.push('pane_missing');
    if (!session.socket_path) staleReasons.push('socket_missing');
    if (staleReasons.length) runtimeStatus = 'stale';
  }
  out.recorded_active = session && session.active !== false;
  out.active = runtimeStatus === 'active';
  out.runtime_status = runtimeStatus;
  out.pane_alive = paneAlive;
  out.socket_exists = socketExists;
  if (staleReasons.length) out.stale_reasons = staleReasons;
  return out;
}

function claudeSessionNameForCodexContext(requestedName, codexPaneContext) {
  const requested = String(requestedName || '').trim();
  if ((!requested || requested === DEFAULT_SESSION) && codexPaneContext && codexPaneContext.sessionName) {
    return safeComponent(codexPaneContext.sessionName, 'session');
  }
  return safeComponent(requested || DEFAULT_SESSION, 'session');
}

function validateCodexTargetInSameWindow(sessionName, referencePane, root = stateRoot()) {
  const cleanName = safeComponent(sessionName || '', 'codex_session');
  const session = readCodexSession(cleanName, root);
  if (!session || session.active === false || !session.pane) {
    return { ok: false, sessionName: cleanName, error: `Codex session '${cleanName}' is not active` };
  }
  const sessionProbe = tmuxPaneProbe(session.pane);
  if (!sessionProbe.alive) {
    const reason = isTmuxProbeUnavailableReason(sessionProbe.reason) ? sessionProbe.reason : 'codex_pane_not_alive';
    return { ok: false, sessionName: cleanName, pane: session.pane || '', error: `Codex session '${cleanName}' pane is not alive; reason: ${reason}` };
  }
  const referenceProbe = tmuxPaneProbe(referencePane);
  if (!referencePane || !referenceProbe.alive) {
    const reason = isTmuxProbeUnavailableReason(referenceProbe.reason) ? referenceProbe.reason : 'reference_pane_not_alive';
    return { ok: false, sessionName: cleanName, pane: session.pane || '', error: `current Claude pane is not available for pair validation; reason: ${reason}` };
  }
  if (!sameTmuxWindow(session.pane, referencePane)) {
    return { ok: false, sessionName: cleanName, pane: session.pane || '', error: `Codex session '${cleanName}' is not in the current XMux pane pair` };
  }
  return { ok: true, sessionName: cleanName, pane: session.pane || '' };
}

function killTmuxPane(pane) {
  if (!tmuxPaneAlive(pane)) return false;
  const result = spawnSync('tmux', ['kill-pane', '-t', pane], { encoding: 'utf8' });
  return result.status === 0;
}

function resetClaudePaneChrome(pane) {
  if (!pane) return;
  const accent = '#D97757';
  const borderFormat = ' #{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#{?#{@xmux-claude-progress},#{@xmux-claude-progress} ,✳ },#{?#{m/r:^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏],#{pane_title}},#{=1:pane_title} ,}}#{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#[fg=#D97757]#[bold]claude #[default],#[fg=#10A37F]#[bold]codex #[default]}';
  runTmuxQuiet(['select-pane', '-t', pane, '-T', 'claude']);
  runTmuxQuiet(['set-option', '-pt', pane, '@xmux-provider', 'claude']);
  runTmuxQuiet(['select-pane', '-t', pane, '-P', 'default']);
  runTmuxQuiet(['set-option', '-pt', pane, '@xmux-provider-accent', accent]);
  runTmuxQuiet(['set-option', '-p', '-t', pane, '-u', '@xmux-provider-bg']);
  runTmuxQuiet(['set-option', '-p', '-t', pane, '-u', '@xmux-claude-progress']);
  runTmuxQuiet(['set-option', '-p', '-t', pane, '-u', '@xmux-claude-progress-token']);
  runTmuxQuiet(['set-option', '-pt', pane, 'pane-border-style', 'fg=#15171C']);
  runTmuxQuiet(['set-option', '-pt', pane, 'pane-border-status', 'top']);
  runTmuxQuiet(['set-option', '-pt', pane, 'pane-border-format', borderFormat]);
}

function setTmuxPaneOption(pane, option, value) {
  if (!pane) return false;
  return runTmuxQuiet(['set-option', '-pt', pane, option, value]);
}

function unsetTmuxPaneOption(pane, option) {
  if (!pane) return false;
  return runTmuxQuiet(['set-option', '-p', '-t', pane, '-u', option]);
}

function tmuxPaneOption(pane, option) {
  if (!pane) return '';
  const result = spawnSync('tmux', ['show-option', '-qv', '-p', '-t', pane, option], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function startClaudePaneProgress(pane, token) {
  if (!pane || !token) return;
  setTmuxPaneOption(pane, '@xmux-claude-progress-token', token);
  setTmuxPaneOption(pane, '@xmux-claude-progress', '.');
  const paneArg = shellQuote(pane);
  const tokenArg = shellQuote(token);
  const script = [
    `pane=${paneArg}`,
    `token=${tokenArg}`,
    `while [ "$(tmux show-option -qv -p -t "$pane" @xmux-claude-progress-token 2>/dev/null)" = "$token" ]; do tmux set-option -p -t "$pane" @xmux-claude-progress "." >/dev/null 2>&1 || exit 0`,
    'sleep 1',
    `[ "$(tmux show-option -qv -p -t "$pane" @xmux-claude-progress-token 2>/dev/null)" = "$token" ] || break`,
    'tmux set-option -p -t "$pane" @xmux-claude-progress ".." >/dev/null 2>&1 || exit 0',
    'sleep 1',
    'done',
  ].join('; ');
  runTmuxQuiet(['run-shell', '-b', script]);
}

function clearClaudePaneProgress(pane, token = '') {
  if (!pane) return;
  const activeToken = tmuxPaneOption(pane, '@xmux-claude-progress-token');
  if (token && activeToken && activeToken !== token) return;
  unsetTmuxPaneOption(pane, '@xmux-claude-progress');
  unsetTmuxPaneOption(pane, '@xmux-claude-progress-token');
  runTmuxQuiet(['select-pane', '-t', pane, '-T', 'claude']);
}

function clearRequestPaneProgress(request, root = stateRoot()) {
  if (!request || !request.session) return;
  const session = readSession(request.session, root);
  if (session && session.pane) clearClaudePaneProgress(session.pane, request.request_id || '');
}

function findClaudePane(name, targetPane = '') {
  const target = targetPane || currentTmuxPane();
  const output = runTmux(['list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_dead}\t#{@xmux-claude-session}']);
  for (const line of output.split(/\r?\n/)) {
    const [pane, dead, sessionName] = line.split('\t');
    if (pane && dead === '0' && sessionName === name) return pane;
  }
  return '';
}

function socketRequestOnce(sock, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    let response = '';
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = net.createConnection(sock);
    const timer = setTimeout(() => finish({ ok: false, error: 'socket timeout' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        finish({ ok: false, error: error.message || String(error), retryable: response.length === 0 });
      }
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(response || '{}');
        finish(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'invalid response' });
      } catch (_) {
        finish({ ok: false, error: response.trim() || 'invalid response' });
      }
    });
    socket.on('error', (error) => finish({ ok: false, error: error.message || String(error), retryable: response.length === 0 }));
  });
}

async function socketRequest(sock, payload, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, error: 'socket timeout' };
  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 1);
    const attempt = await socketRequestOnce(sock, payload, Math.min(remaining, 5000));
    if (attempt.ok || !attempt.retryable) return attempt;
    last = attempt;
    sleep(100);
  }
  return last;
}

async function waitForSocket(sock, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) {
      const response = await socketRequest(sock, { type: 'ping' }, 500);
      if (response.ok) return true;
    }
    sleep(100);
  }
  return false;
}

function paneReadyMatches(session, expectedLaunchId = '', launchedAfterMs = 0) {
  if (!session || !session.pane_ready_at) return false;
  if (expectedLaunchId && session.pane_launch_id !== expectedLaunchId) return false;
  const readyAt = epochMs(session.pane_ready_at);
  if (!readyAt) return false;
  return readyAt >= Math.max(launchedAfterMs - 1000, 0);
}

async function waitForPaneReady(name, expectedLaunchId, launchedAfterMs, opts = {}, root = stateRoot()) {
  const timeoutMs = Math.max(readyTimeoutMs(opts), 0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const session = readSession(name, root);
    if (paneReadyMatches(session, expectedLaunchId, launchedAfterMs)) {
      appendEvent('claude.pane.ready_confirmed', {
        session: name,
        launch_id: expectedLaunchId || '',
        ready_at: session.pane_ready_at,
      }, root);
      return session;
    }
    sleep(100);
  }

  const fallbackMs = Math.max(fallbackStartupDelayMs(opts), 0);
  appendEvent('claude.pane.ready_timeout', {
    session: name,
    launch_id: expectedLaunchId || '',
    timeout_ms: timeoutMs,
    fallback_ms: fallbackMs,
  }, root);
  if (fallbackMs > 0) {
    sleep(fallbackMs);
    const postFallbackDeadline = Date.now() + Math.max(postFallbackReadyTimeoutMs(opts), 0);
    while (Date.now() <= postFallbackDeadline) {
      const session = readSession(name, root);
      if (paneReadyMatches(session, expectedLaunchId, launchedAfterMs)) {
        appendEvent('claude.pane.ready_confirmed_after_fallback', {
          session: name,
          launch_id: expectedLaunchId || '',
          ready_at: session.pane_ready_at,
        }, root);
        return session;
      }
      sleep(100);
    }
    appendEvent('claude.pane.ready_fallback_unconfirmed', {
      session: name,
      launch_id: expectedLaunchId || '',
      post_fallback_timeout_ms: Math.max(postFallbackReadyTimeoutMs(opts), 0),
    }, root);
    return readSession(name, root);
  }
  throw new Error(`Claude SessionStart hook did not report ready for ${name} within ${timeoutMs}ms; run xmux claude ensure-hooks or set --fallback-startup-delay for compatibility`);
}

function composeCommand(request = {}, body = '') {
  const marker = request.phase_marker || CODEX_REQUEST_MARKER;
  return `${marker}\n\n${canonicalPrompt(body)}`;
}

function composeResponseCommand(request, body = '') {
  const nonceValue = String(request.response_nonce || '').trim();
  if (!/^[A-Fa-f0-9]{32,128}$/.test(nonceValue)) {
    throw new Error(`response nonce missing for ${request.request_id}`);
  }
  const responseBody = canonicalPrompt(body);
  const visible = responseBody || sanitizeTitle(request.response_title || 'Claude response', 'Claude response');
  return `${CLAUDE_RESPONSE_MARKER}\n\n${visible}`;
}

function composeResponseAuditMarker(request) {
  const title = sanitizeTitle(request.response_title || 'Claude response', 'Claude response');
  return `${CLAUDE_RESPONSE_MARKER}\n\n${title}`;
}

function parseMarker(input = {}, marker, fallbackTitle) {
  const prompt = String(input.prompt || '').trim();
  if (prompt !== marker && !prompt.startsWith(`${marker}\n`) && !prompt.startsWith(`${marker} `)) {
    return null;
  }
  const body = prompt
    .slice(marker.length)
    .trim()
    .replace(/^#+\s*/, '');
  return {
    title: sanitizeTitle(body || '', fallbackTitle),
    body: canonicalPrompt(body || ''),
  };
}

function parseCodexRequestMarker(input = {}) {
  const phase = parsePhaseMarker(input);
  if (phase && phase.lineage === 'claude') {
    return {
      title: sanitizeTitle(phase.body || '', 'Claude phase request'),
      body: canonicalPrompt(phase.body || ''),
      source: 'phase-marker',
      phase: phase.phase,
      phase_marker: phase.marker,
      required_executor_agent: phase.required_agent,
      visible_marker: phase.marker,
    };
  }
  const parsed = parseMarker(input, CODEX_REQUEST_MARKER, 'Codex request');
  return parsed ? { ...parsed, source: 'system-marker', visible_marker: CODEX_REQUEST_MARKER } : null;
}

function parseCodexResponseMarker(input = {}) {
  const parsed = parseMarker(input, CODEX_RESPONSE_MARKER, 'Codex response');
  return parsed ? { ...parsed, source: 'system-marker' } : null;
}

function isExplicitXmuxPrompt(input = {}) {
  const prompt = String(input.prompt || '').trim();
  return prompt.startsWith(CODEX_REQUEST_MARKER)
    || prompt.startsWith(CODEX_RESPONSE_MARKER)
    || Boolean(parsePhaseMarker(input));
}

function visibleMarkerBody(input = {}, marker) {
  const prompt = String(input.prompt || '').trim();
  if (prompt === marker) return '';
  if (!prompt.startsWith(marker)) return '';
  return canonicalPrompt(prompt.slice(marker.length).trimStart());
}

function parseClaudeToCodexTrigger(input = {}) {
  const commandName = String(input.command_name || input.commandName || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (commandName !== COMMAND_NAME && prompt !== `/${COMMAND_NAME}` && !prompt.startsWith(`/${COMMAND_NAME}\n`) && !prompt.startsWith(`/${COMMAND_NAME} `)) {
    return null;
  }
  const args = input.command_args !== undefined
    ? String(input.command_args)
    : (input.commandArgs !== undefined ? String(input.commandArgs) : '');
  const body = args.trim()
    ? canonicalPrompt(args)
    : (prompt.startsWith(`/${COMMAND_NAME}`) ? canonicalPrompt(prompt.slice(`/${COMMAND_NAME}`.length).trimStart()) : '');
  return {
    source: commandName === COMMAND_NAME ? 'slash-command' : 'raw-command',
    body,
    title: titleFromText(body, 'Claude request'),
  };
}

function buildAdditionalContext(request) {
  const lines = [
    'XMux request from Codex accepted.',
    `Request ID: ${request.request_id}`,
    `Title: ${request.title || request.request_id}`,
    `Mode: ${request.mode || 'synthesis'}`,
    `Expected role: ${request.expected_role || 'second_opinion'}`,
    '',
    'Rules:',
    `- Treat the visible ${request.phase_marker || CODEX_REQUEST_MARKER} prompt body as the only XMux task.`,
    '- Do not expose the nonce or internal request metadata unless the user explicitly asks for debugging.',
    '- Do not call MCP teammate tools, write_to_lead, raw tmux, send-keys, load-buffer, or paste-buffer.',
  ];
  if (request.phase_marker && request.required_executor_agent) {
    lines.push(
      '',
      'XMux phase execution rule:',
      `- Phase marker ${request.phase_marker} maps to phase ${request.phase || 'unknown'}.`,
      `- Invoke the Claude subagent ${request.required_executor_agent} for this phase before producing the final answer.`,
      '- The main Claude conversation must synthesize the subagent result; it must not perform the phase directly.',
      '- The XMux Stop hook will block completion until the required subagent stop event is recorded.',
    );
  }
  lines.push('- Complete the task normally. The XMux Stop hook will deliver your final assistant message back to Codex.');
  return lines.join('\n');
}

function writeHookContext(eventName, additionalContext) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  })}\n`);
}

function writeHookBlock(eventName, reason) {
  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: eventName,
    },
  })}\n`);
}

function validateTrigger(opts) {
  const trigger = String(opts.trigger || '').trim();
  if (trigger !== 'xmux-claude' && trigger !== 'xmux-claude!') {
    throw new Error('xmux claude send requires --trigger xmux-claude or --trigger xmux-claude!');
  }
  if ((opts.raw || opts.mode === 'raw') && trigger !== 'xmux-claude!') {
    throw new Error('raw mode requires --trigger xmux-claude!');
  }
  const consent = String(opts['transport-consent'] || process.env.XMUX_TRANSPORT_CONSENT || '').trim();
  const workflowConsent = trigger === 'xmux-claude' && consent === 'xmux-implement';
  if (consent !== trigger && !workflowConsent) {
    throw new Error(`xmux claude send requires explicit $${trigger} first-token trigger transport consent`);
  }
  return trigger;
}

async function retrieveRequestBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  const result = await socketRequest(sock, {
    type: 'retrieve_request_body',
    request_id: request.request_id,
    nonce: request.nonce,
  }, Number(process.env.XMUX_CLAUDE_SOCKET_TIMEOUT_MS || 5000));
  if (!result.ok) {
    return { ok: false, error: result.error || 'request body unavailable' };
  }
  const body = canonicalPrompt(result.body || '');
  if (!body.trim()) {
    return { ok: false, error: 'request body empty' };
  }
  if (sha256(body) !== request.prompt_sha256) {
    return { ok: false, error: 'request body sha256 mismatch' };
  }
  return { ok: true, body, bytes: result.bytes || byteLength(body) };
}

async function releaseRequestBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  return socketRequest(sock, {
    type: 'release_request_body',
    request_id: request.request_id,
    nonce: request.nonce,
  }, 1000);
}

async function retrieveResponseBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  const result = await socketRequest(sock, {
    type: 'retrieve_response_body',
    request_id: request.request_id,
    response_nonce: request.response_nonce,
  }, Number(process.env.XMUX_CLAUDE_SOCKET_TIMEOUT_MS || 5000));
  if (!result.ok) {
    return { ok: false, error: result.error || 'response body unavailable' };
  }
  const body = canonicalPrompt(result.body || '');
  if (!body.trim()) {
    return { ok: false, error: 'response body empty' };
  }
  if (sha256(body) !== request.response_sha256) {
    return { ok: false, error: 'response body sha256 mismatch' };
  }
  return { ok: true, body, bytes: result.bytes || byteLength(body) };
}

async function releaseResponseBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  return socketRequest(sock, {
    type: 'release_response_body',
    request_id: request.request_id,
    response_nonce: request.response_nonce,
  }, 1000);
}

async function acceptXmuxCommand(input, eventName, root = stateRoot()) {
  const parsed = parseCodexRequestMarker(input);
  if (!parsed) return { status: 'no_marker' };

  const session = hookSession(input, root);
  if (!session || !session.active_request) {
    return { status: 'invalid', request_id: '', reason: 'active_request_not_found' };
  }

  let request;
  try {
    request = readJson(requestPath(session.active_request, root), null);
  } catch (_) {
    request = null;
  }
  if (!request) {
    return { status: 'invalid', request_id: session.active_request, reason: 'request_not_found' };
  }
  if (request.status === 'accepted' && request.accepted_via === CODEX_REQUEST_NAME) {
    return { status: 'already_accepted', request };
  }

  if (
    !session
    || !['invoking', 'sent'].includes(request.status)
    || request.session !== session.name
    || (request.direction && request.direction !== 'codex_to_claude')
  ) {
    return { status: 'invalid', request_id: request.request_id, reason: 'request_validation_failed' };
  }

  const retrieved = await retrieveRequestBody(session, request, root);
  if (!retrieved.ok) {
    return { status: 'invalid', request_id: request.request_id, reason: retrieved.error || 'request_body_unavailable' };
  }
  const visibleBody = visibleMarkerBody(input, parsed.visible_marker || CODEX_REQUEST_MARKER);
  if (!visibleBody.trim()) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_prompt_body_missing' };
  }
  if (sha256(visibleBody) !== request.prompt_sha256 || canonicalPrompt(visibleBody) !== canonicalPrompt(retrieved.body)) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_prompt_body_mismatch' };
  }

  const accepted = updateRequest(request.request_id, (item) => {
    item.status = 'accepted';
    item.accepted_at = nowTs();
    item.accepted_via = CODEX_REQUEST_NAME;
    item.accepted_hook = eventName;
    item.command_source = parsed.source;
    item.phase = item.phase || parsed.phase || '';
    item.phase_marker = item.phase_marker || parsed.phase_marker || '';
    item.required_executor_agent = item.required_executor_agent || parsed.required_executor_agent || '';
    item.prompt_retrieved_at = nowTs();
    item.prompt_body_bytes = retrieved.bytes || byteLength(retrieved.body);
    item.claude_session_id = input.session_id || input.sessionId || item.claude_session_id || '';
    return item;
  }, root);
  await releaseRequestBody(session, request, root);
  session.active_request = request.request_id;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('claude.hook.xmux_codex.accepted', {
    request_id: request.request_id,
    session: session.name,
    hook: eventName,
    source: parsed.source,
  }, root);
  const routeEvent = appendRouteEvent({
    request_id: request.request_id,
    from_lineage: 'codex',
    to_lineage: 'claude',
    prompt_hash: request.prompt_sha256,
    marker_valid: true,
    model_tier: request.model_tier || process.env.XMUX_CLAUDE_MODEL_TIER || 'unknown',
    transport_event: 'claude.hook.xmux_codex.accepted',
    phase_marker: request.phase_marker || parsed.phase_marker || '',
    phase: request.phase || parsed.phase || '',
  }, root);
  const acceptedWithRouteEvent = updateRequest(request.request_id, (item) => {
    item.codex_to_claude_route_event_id = routeEvent.event_id;
    return item;
  }, root);
  return { status: 'accepted', request: acceptedWithRouteEvent, body: retrieved.body };
}

async function acceptCodexResponseMarker(input, root = stateRoot()) {
  const parsed = parseCodexResponseMarker(input);
  if (!parsed) return { status: 'no_marker' };

  const session = hookSession(input, root);
  const pending = session && session.pending_response ? session.pending_response : null;
  if (!session || !pending || !pending.request_id) {
    return { status: 'invalid', request_id: '', reason: 'pending_response_not_found' };
  }

  const request = readJson(requestPath(pending.request_id, root), null);
  if (!request) {
    return { status: 'invalid', request_id: pending.request_id, reason: 'request_not_found' };
  }

  if (request.claude_response_accepted_at) {
    return { status: 'already_accepted', request };
  }

  if (
    request.direction !== 'claude_to_codex'
    || request.status !== 'responded'
    || request.response_nonce !== pending.response_nonce
    || request.response_sha256 !== pending.response_sha256
  ) {
    return { status: 'invalid', request_id: request.request_id, reason: 'response_validation_failed' };
  }

  const retrieved = await retrieveResponseBody(session, request, root);
  if (!retrieved.ok) {
    return { status: 'invalid', request_id: request.request_id, reason: retrieved.error || 'response_body_unavailable' };
  }

  const visibleBody = visibleMarkerBody(input, CODEX_RESPONSE_MARKER);
  if (!visibleBody.trim()) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_response_body_missing' };
  }
  if (sha256(visibleBody) !== request.response_sha256 || canonicalPrompt(visibleBody) !== canonicalPrompt(retrieved.body)) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_response_body_mismatch' };
  }

  const accepted = updateRequest(request.request_id, (item) => {
    item.status = 'closed';
    item.claude_response_accepted_at = nowTs();
    item.claude_response_marker_title = parsed.title;
    item.claude_response_body_bytes = retrieved.bytes || byteLength(retrieved.body);
    return item;
  }, root);
  await releaseResponseBody(session, request, root);
  delete session.pending_response;
  if (session.active_outbound_request === request.request_id) delete session.active_outbound_request;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('claude.hook.codex_response.accepted', {
    request_id: request.request_id,
    session: session.name,
    title: parsed.title,
  }, root);
  return { status: 'accepted', request: accepted, body: retrieved.body };
}

function updateRequest(id, updater, root = stateRoot()) {
  const file = requestPath(id, root);
  const current = readJson(file, null);
  if (!current) throw new Error(`request not found: ${id}`);
  const next = updater(current) || current;
  next.updated_at = nowTs();
  writeJson(file, next);
  return next;
}

// Request statuses that already represent a terminal outcome in current or
// legacy transport paths. Pane exit cleanup must not downgrade them to failed.
const REQUEST_EXIT_TERMINAL_STATUSES = new Set([
  'responded',
  'failed',
  'rejected',
  'timeout',
  'backend_unavailable',
  'transport_unavailable',
  'closed',
]);

function failRequestOnSessionExit(id, error, exitedAt, root = stateRoot()) {
  if (!id) return { updated: false, missing: true };
  const file = requestPath(id, root);
  const current = readJson(file, null);
  if (!current) return { updated: false, missing: true };
  if (REQUEST_EXIT_TERMINAL_STATUSES.has(current.status)) {
    return { updated: false, status: current.status };
  }
  current.status = 'failed';
  current.error = error;
  current.failed_at = exitedAt;
  current.updated_at = nowTs();
  writeJson(file, current);
  clearRequestPaneProgress(current, root);
  return { updated: true, status: current.status };
}

function finalizePaneRunSessionExit(name, root = stateRoot(), result = {}, opts = {}) {
  const session = readSession(name, root);
  if (!session) return null;
  const launch = opts.launch || '';
  if (launch && session.pane_launch_id && session.pane_launch_id !== launch) {
    appendEvent('claude.session.exit_ignored', {
      session: name,
      launch_id: launch,
      current_launch_id: session.pane_launch_id,
      reason: 'launch_id_mismatch',
    }, root);
    return { ...session, exit_ignored: true };
  }

  const exitedAt = nowTs();
  if (session.active_request) {
    failRequestOnSessionExit(session.active_request, 'session exited before response', exitedAt, root);
    delete session.active_request;
  }
  if (session.active_outbound_request) {
    failRequestOnSessionExit(session.active_outbound_request, 'session exited before Codex response', exitedAt, root);
    delete session.active_outbound_request;
  }
  delete session.pending_response;

  session.active = false;
  session.exited_at = exitedAt;
  if (Object.prototype.hasOwnProperty.call(result || {}, 'status') && result.status != null) {
    session.exit_code = result.status;
    delete session.exit_signal;
  } else if (result && result.signal) {
    session.exit_signal = String(result.signal);
    delete session.exit_code;
  }
  if (session.socket_path && !socketPathExists(session.socket_path)) session.socket_removed_at = exitedAt;
  if (session.pane && !tmuxPaneAlive(session.pane)) session.pane_exited_at = exitedAt;
  session.updated_at = exitedAt;
  writeSession(session, root);
  appendEvent('claude.session.exited', {
    session: name,
    exit_code: Object.prototype.hasOwnProperty.call(result || {}, 'status') ? result.status : null,
    exit_signal: result && result.signal ? String(result.signal) : null,
  }, root);
  return session;
}

function markResponded(request, text, source, root = stateRoot()) {
  const responseText = canonicalPrompt(text);
  const next = updateRequest(request.request_id, (item) => {
    item.status = 'responded';
    item.responded_at = nowTs();
    item.response_source = source;
    item.response_sha256 = sha256(responseText);
    item.response_body_bytes = byteLength(responseText);
    item.response_nonce = item.response_nonce || responseNonce();
    item.response_title = responseTitleFromText(responseText);
    if (debugPreserveBody()) {
      ensureDir(responsesDir(root));
      item.debug_response_path = responsePath(request.request_id, root);
      writeTextAtomic(item.debug_response_path, responseText + '\n');
    } else {
      delete item.response_path;
      delete item.debug_response_path;
    }
    return item;
  }, root);
  const session = readSession(request.session, root);
  if (session && session.active_request === request.request_id) {
    delete session.active_request;
    session.updated_at = nowTs();
    writeSession(session, root);
  }
  clearRequestPaneProgress(request, root);
  appendEvent('claude.response.written', { request_id: request.request_id, session: request.session, source }, root);
  return next;
}

async function deliverResponseToCodex(request, responseText, root = stateRoot()) {
  const sessionName = request.codex_session || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '';
  if (!sessionName) {
    appendEvent('claude.response.codex_delivery_skipped', {
      request_id: request.request_id,
      reason: 'no_codex_session',
    }, root);
    return { ok: false, error: 'no Codex session target' };
  }
  const claudeSession = readSession(request.session, root);
  const pairCheck = validateCodexTargetInSameWindow(sessionName, claudeSession && claudeSession.pane ? claudeSession.pane : '', root);
  if (!pairCheck.ok) {
    appendEvent('claude.response.codex_delivery_failed', {
      request_id: request.request_id,
      session: sessionName,
      error: pairCheck.error,
    }, root);
    updateRequest(request.request_id, (item) => {
      item.codex_delivery = 'failed';
      item.codex_delivery_at = nowTs();
      item.codex_delivery_error = pairCheck.error;
      item.codex_session = sessionName;
      return item;
    }, root);
    return { ok: false, error: pairCheck.error };
  }
  let sendResponseToSession;
  try {
    ({ sendResponseToSession } = require('../codex/cli'));
  } catch (error) {
    appendEvent('claude.response.codex_delivery_failed', {
      request_id: request.request_id,
      session: sessionName,
      error: error && error.message ? error.message : String(error),
    }, root);
    return { ok: false, error: 'Codex harness unavailable' };
  }
  let responsePrompt;
  try {
    responsePrompt = composeResponseCommand(request, responseText);
  } catch (error) {
    appendEvent('claude.response.codex_delivery_failed', {
      request_id: request.request_id,
      session: sessionName,
      error: error && error.message ? error.message : String(error),
    }, root);
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
  const result = await sendResponseToSession({
    root,
    name: sessionName,
    request,
    body: responseText,
    prompt: responsePrompt,
    enter: true,
    bracketedPaste: true,
    clear: true,
    timeoutMs: Number(process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 30000),
  });
  updateRequest(request.request_id, (item) => {
    item.codex_delivery = result.ok ? 'sent' : 'failed';
    item.codex_delivery_at = nowTs();
    item.codex_delivery_error = result.ok ? '' : (result.error || 'Codex delivery failed');
    item.codex_session = sessionName;
    return item;
  }, root);
  appendEvent(result.ok ? 'claude.response.codex_delivered' : 'claude.response.codex_delivery_failed', {
    request_id: request.request_id,
    session: sessionName,
    marker: composeResponseAuditMarker(request),
    error: result.ok ? '' : (result.error || 'Codex delivery failed'),
  }, root);
  return result;
}

async function sendCodexResponseToSession(options = {}) {
  const root = options.root ? path.resolve(expandUser(options.root)) : stateRoot();
  const name = safeComponent(options.name || options.to || DEFAULT_SESSION, 'session');
  const request = options.request || {};
  const requestIdValue = safeComponent(request.request_id || options.request_id || '', 'request_id');
  const responseNonceValue = String(request.response_nonce || options.response_nonce || '').trim();
  if (!/^[A-Fa-f0-9]{32,128}$/.test(responseNonceValue)) {
    return { ok: false, status: 'rejected', error: 'response nonce missing' };
  }
  const body = canonicalPrompt(options.body || '');
  if (!body.trim()) return { ok: false, status: 'rejected', error: 'response body must not be empty' };
  const digest = request.response_sha256 || sha256(body);
  if (sha256(body) !== digest) {
    return { ok: false, status: 'rejected', error: 'response body sha256 mismatch' };
  }
  const title = sanitizeTitle(request.response_title || options.title || body, 'Codex response');
  const prompt = canonicalPrompt(options.prompt || `${CODEX_RESPONSE_MARKER}\n\n${body}`);
  const session = readSession(name, root);
  const sock = options.socket || (session && session.socket_path) || socketPath(name, root);
  if (!session || !sock || !fs.existsSync(sock)) {
    return { ok: false, status: 'unavailable', error: `Claude pane socket is not ready: ${sock || '(none)'}` };
  }
  if (request.codex_session) {
    const pairCheck = validateCodexTargetInSameWindow(request.codex_session, session.pane || '', root);
    if (!pairCheck.ok) {
      return { ok: false, status: 'unavailable', error: pairCheck.error };
    }
  }
  if (session.active_request || (session.active_outbound_request && session.active_outbound_request !== requestIdValue)) {
    return { ok: false, status: 'peer_busy', error: 'Claude session already has an active XMux cycle' };
  }
  session.pending_response = {
    request_id: requestIdValue,
    response_nonce: responseNonceValue,
    response_sha256: digest,
    title,
    set_at: nowTs(),
  };
  session.updated_at = nowTs();
  writeSession(session, root);
  const response = await socketRequest(sock, {
    type: 'inject_response',
    request_id: requestIdValue,
    response_nonce: responseNonceValue,
    title,
    body,
    sha256: digest,
    prompt,
    enter: options.enter !== false,
    bracketed_paste: options.bracketedPaste !== false,
    clear: Boolean(options.clear),
  }, Number(options.timeoutMs || process.env.XMUX_CLAUDE_SOCKET_TIMEOUT_MS || 30000));
  if (!response.ok) {
    const latest = readSession(name, root);
    if (latest && latest.pending_response && latest.pending_response.request_id === requestIdValue) {
      delete latest.pending_response;
      latest.updated_at = nowTs();
      writeSession(latest, root);
    }
    return { ok: false, status: 'failed', error: response.error || 'socket injection failed' };
  }
  appendEvent('claude.codex_response.injected', { session: name, request_id: requestIdValue, pane: session.pane || '', title }, root);
  return { ok: true, status: 'sent', session: name, pane: session.pane || '', socket_path: sock };
}

function clearActiveRequest(request, root = stateRoot()) {
  const session = readSession(request.session, root);
  if (session && session.active_request === request.request_id) {
    delete session.active_request;
    session.updated_at = nowTs();
    writeSession(session, root);
  }
  clearRequestPaneProgress(request, root);
}

function failRequest(request, status, fields = {}, root = stateRoot()) {
  const next = updateRequest(request.request_id, (item) => {
    item.status = status;
    Object.assign(item, fields);
    return item;
  }, root);
  clearActiveRequest(request, root);
  return next;
}

function clearOutboundRequest(sessionName, requestId, root = stateRoot()) {
  const session = readSession(sessionName, root);
  let changed = false;
  if (session && session.active_outbound_request === requestId) {
    delete session.active_outbound_request;
    changed = true;
  }
  if (session && session.pending_response && session.pending_response.request_id === requestId) {
    delete session.pending_response;
    changed = true;
  }
  if (session && changed) {
    session.updated_at = nowTs();
    writeSession(session, root);
  }
}

async function startClaudeToCodexCycle(input, eventName, root = stateRoot()) {
  const parsed = parseClaudeToCodexTrigger(input);
  if (!parsed) return { status: 'no_marker' };
  const session = hookSession(input, root);
  if (!session) return { status: 'invalid', request_id: '', reason: 'session_not_found' };
  const codexPaneContext = resolveCodexPaneContext(root);
  if (!codexPaneContext.pane) {
    return { status: 'invalid', request_id: '', reason: codexContextErrorMessage(codexPaneContext, 'Claude to Codex routing') };
  }
  return sendClaudeToCodexPrompt({
    body: parsed.body,
    title: parsed.title,
    sessionName: session.name,
    codexSession: codexPaneContext.sessionName || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '',
    eventName,
    commandSource: parsed.source,
  }, root);
}

async function sendClaudeToCodexPrompt(options = {}, root = stateRoot()) {
  const body = canonicalPrompt(options.body || '');
  if (!body.trim()) {
    return { status: 'invalid', request_id: '', reason: 'prompt_body_missing' };
  }
  if (byteLength(body) > bodySizeLimit()) {
    return { status: 'invalid', request_id: '', reason: `prompt exceeds ${bodySizeLimit()} bytes` };
  }
  const sessionName = safeComponent(options.sessionName || process.env.XMUX_CLAUDE_SESSION_NAME || DEFAULT_SESSION, 'session');
  const session = readSession(sessionName, root);
  if (!session) return { status: 'invalid', request_id: '', reason: 'session_not_found' };
  if (session.active_request || session.active_outbound_request || session.pending_response) {
    return { status: 'invalid', request_id: '', reason: 'peer_busy' };
  }

  let sendRequestToSession;
  try {
    ({ sendRequestToSession } = require('../codex/cli'));
  } catch (error) {
    return { status: 'invalid', request_id: '', reason: error && error.message ? error.message : 'codex_harness_unavailable' };
  }

  const id = requestId();
  let phaseConfig = null;
  if (options.phase) {
    phaseConfig = phaseEntry('codex', options.phase);
    if (!phaseConfig) return { status: 'invalid', request_id: '', reason: `unknown Codex XMux phase: ${options.phase}` };
  }
  const targetCodexSession = options.codexSession !== undefined
    ? String(options.codexSession || '')
    : (process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '');
  if (!targetCodexSession) {
    return { status: 'invalid', request_id: '', reason: 'codex_session_missing' };
  }
  const pairCheck = validateCodexTargetInSameWindow(targetCodexSession, session.pane || '', root);
  if (!pairCheck.ok) {
    return { status: 'invalid', request_id: '', reason: pairCheck.error };
  }
  const title = options.title || titleFromText(body, id);
  const request = {
    schema: SCHEMA_REQUEST,
    request_id: id,
    nonce: nonce(),
    title,
    trigger: COMMAND_NAME,
    direction: 'claude_to_codex',
    session: session.name,
    codex_session: pairCheck.sessionName,
    from: `claude:${session.name}`,
    to: `codex:${pairCheck.sessionName}`,
    mode: 'synthesis',
    expected_role: 'primary',
    status: 'prepared',
    model_tier: options.modelTier || process.env.XMUX_CODEX_MODEL_TIER || 'codex',
    phase: phaseConfig ? phaseConfig.phase : '',
    phase_marker: phaseConfig ? phaseMarker('codex', phaseConfig.phase) : '',
    required_executor_agent: phaseConfig ? phaseConfig.required_agent : '',
    prompt_sha256: sha256(body),
    prompt_body_bytes: byteLength(body),
    created_at: nowTs(),
    updated_at: nowTs(),
  };
  ensureDir(requestsDir(root));
  writeJson(requestPath(id, root), request);
  session.active_outbound_request = id;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('claude.codex_request.prepared', { request_id: id, session: session.name, title }, root);

  updateRequest(id, (item) => {
    item.status = 'invoking';
    item.invoked_at = nowTs();
    item.trigger_hook = options.eventName || 'cli';
    item.command_source = options.commandSource || 'cli';
    return item;
  }, root);
  const prompt = `${request.phase_marker || CLAUDE_REQUEST_MARKER}\n\n${body}`;
  const result = await sendRequestToSession({
    root,
    name: pairCheck.sessionName,
    request,
    body,
    prompt,
    enter: true,
    bracketedPaste: true,
    clear: true,
    timeoutMs: Number(process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 30000),
  });
  updateRequest(id, (item) => {
    item.status = result.ok ? 'sent' : (result.status || 'failed');
    item.sent_at = result.ok ? nowTs() : item.sent_at;
    item.codex_delivery = result.ok ? 'sent' : 'failed';
    item.codex_delivery_at = nowTs();
    item.codex_delivery_error = result.ok ? '' : (result.error || 'Codex delivery failed');
    item.codex_session = result.session || targetCodexSession || item.codex_session || '';
    return item;
  }, root);
  if (!result.ok) {
    clearOutboundRequest(session.name, id, root);
    appendEvent('claude.codex_request.delivery_failed', {
      request_id: id,
      session: session.name,
      error: result.error || 'Codex delivery failed',
    }, root);
    return { status: 'invalid', request_id: id, reason: result.error || 'Codex delivery failed' };
  }
  appendEvent('claude.codex_request.delivered', {
    request_id: id,
    session: session.name,
    codex_session: result.session || '',
    marker: `${CLAUDE_REQUEST_MARKER}\n\n${title}`,
  }, root);
  return { status: 'sent', request: readJson(requestPath(id, root), request), body };
}

function waitRequest(id, timeoutSeconds = 60, root = stateRoot()) {
  const deadline = Date.now() + Math.max(Number(timeoutSeconds) || 0, 0) * 1000;
  while (true) {
    const request = readJson(requestPath(id, root), null);
    if (!request) return { status: 'missing', request_id: id };
    if (request.status === 'responded') {
      if (!request.codex_session || request.codex_delivery) return request;
    } else if (['rejected', 'timeout', 'backend_unavailable', 'failed'].includes(request.status)) {
      return request;
    }
    if (Date.now() >= deadline) {
      return failRequest(request, 'timeout', { timed_out_at: nowTs() }, root);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

async function ensurePaneSession(name = DEFAULT_SESSION, opts = {}, root = stateRoot()) {
  const codexPaneContext = resolveCodexPaneContext(root);
  if (!codexPaneContext.pane) {
    throw new Error(codexContextErrorMessage(codexPaneContext, 'Claude pane backend'));
  }

  const cleanName = claudeSessionNameForCodexContext(name, codexPaneContext);
  cmdEnsureHooks({ quiet: true });
  const sock = socketPath(cleanName, root);
  const currentPane = codexPaneContext.pane;
  let session = ensureSession(cleanName, {
    active: true,
    splitRequested: true,
    transportBackend: 'pane',
  }, root);
  clearSessionExitMarkers(session);
  writeSession(session, root);

  const existingPane = findClaudePane(cleanName, currentPane);
  if (existingPane && await waitForSocket(sock, 1000)) {
    resetClaudePaneChrome(existingPane);
    session.pane = existingPane;
    session.socket_path = sock;
    session.updated_at = nowTs();
    writeSession(session, root);
    return session;
  }
  if (!existingPane && cleanName !== DEFAULT_SESSION) {
    const legacyPane = findClaudePane(DEFAULT_SESSION, currentPane);
    if (legacyPane) {
      appendEvent('claude.pane.legacy_default_replaced', {
        session: cleanName,
        legacy_session: DEFAULT_SESSION,
        pane: legacyPane,
        current_pane: currentPane,
      }, root);
      killTmuxPane(legacyPane);
      const legacySession = readSession(DEFAULT_SESSION, root);
      if (legacySession && legacySession.pane === legacyPane) {
        legacySession.active = false;
        legacySession.updated_at = nowTs();
        delete legacySession.pane;
        if (legacySession.socket_path) {
          try {
            fs.unlinkSync(legacySession.socket_path);
          } catch (_) {
            // Socket cleanup is best effort; pane runner also removes it on exit.
          }
          delete legacySession.socket_path;
        }
        writeSession(legacySession, root);
      }
    }
  }

  if (session.pane && tmuxPaneAlive(session.pane)) {
    if (!sameTmuxWindow(session.pane, currentPane)) {
      appendEvent('claude.pane.external_ignored', {
        session: cleanName,
        pane: session.pane,
        current_pane: currentPane,
        socket_path: session.socket_path || '',
      }, root);
      delete session.pane;
      delete session.socket_path;
      writeSession(session, root);
    } else if (await waitForSocket(session.socket_path || sock, 1000)) {
      resetClaudePaneChrome(session.pane);
      const current = readSession(cleanName, root) || session;
      if (!current.pane_launch_id || current.pane_ready_at) return current;
      return await waitForPaneReady(cleanName, current.pane_launch_id, epochMs(current.pane_launch_started_at), opts, root);
    } else {
      appendEvent('claude.pane.stale', { session: cleanName, pane: session.pane, socket_path: session.socket_path || '' }, root);
      killTmuxPane(session.pane);
    }
  }

  if (existingPane) {
    appendEvent('claude.pane.stale', { session: cleanName, pane: existingPane, socket_path: sock }, root);
    killTmuxPane(existingPane);
  }

  const newLaunchId = launchId();
  const launchedAtMs = Date.now();
  session.pane_launch_id = newLaunchId;
  session.pane_launch_started_at = nowTs();
  delete session.pane_ready_at;
  delete session.pane_ready_source;
  delete session.pane_ready_model;
  delete session.pane_ready_transcript_path;
  delete session.pane_ready_cwd;
  writeSession(session, root);
  const command = [
    `PATH=${shellQuote(pathWithXmuxCommandBin())}`,
    `XMUX_PROJECT_DIR=${shellQuote(projectDir())}`,
    `XMUX_STATE_DIR=${shellQuote(root)}`,
    `XMUX_INSTALL_DIR=${shellQuote(installRoot())}`,
    `XMUX_CLAUDE_LAUNCH_ID=${shellQuote(newLaunchId)}`,
    process.env.XMUX_CODEX_SESSION_NAME ? `XMUX_CODEX_SESSION_NAME=${shellQuote(process.env.XMUX_CODEX_SESSION_NAME)}` : '',
    process.env.XMUX_TEAM ? `XMUX_TEAM=${shellQuote(process.env.XMUX_TEAM)}` : '',
    shellQuote(xmuxBinPath()),
    'claude',
    'pane-run',
    '--name',
    shellQuote(cleanName),
    '--socket',
    shellQuote(sock),
    '--launch-id',
    shellQuote(newLaunchId),
  ].filter(Boolean).join(' ');
  const pane = runTmux(['split-window', '-t', currentPane, '-h', '-p', '50', '-P', '-F', '#{pane_id}', '-c', projectDir(), command]);
  runTmux(['set-option', '-pt', pane, '@xmux-claude-session', cleanName]);
  runTmux(['set-option', '-pt', pane, '@xmux-agent', `claude:${cleanName}`]);
  resetClaudePaneChrome(pane);
  runTmux(['select-layout', '-t', currentPane, 'even-horizontal']);
  runTmux(['select-pane', '-t', currentPane]);
  runTmuxQuiet(['set-option', '-t', currentPane, 'pane-active-border-style', 'fg=#10A37F,bold']);

  session = readSession(cleanName, root) || session;
  session.pane = pane;
  session.socket_path = sock;
  session.split_requested = true;
  session.transport_backend = 'pane';
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('claude.pane.started', { session: cleanName, pane, socket_path: sock }, root);

  if (!await waitForSocket(sock, Number(opts['socket-timeout'] || 10000))) {
    throw new Error(`Claude pane socket did not become ready: ${sock}`);
  }
  return await waitForPaneReady(cleanName, newLaunchId, launchedAtMs, opts, root);
}

async function invokePane(panePrompt, request, body, opts = {}, root = stateRoot()) {
  let session;
  let sock;
  let response;
  try {
    session = await ensurePaneSession(request.session, opts, root);
    startClaudePaneProgress(session.pane || '', request.request_id);
    sock = session.socket_path || socketPath(request.session, root);
    response = await socketRequest(sock, {
      type: 'inject_request',
      request_id: request.request_id,
      nonce: request.nonce,
      title: request.title || request.request_id,
      body,
      sha256: request.prompt_sha256,
      prompt: panePrompt,
      enter: true,
      bracketed_paste: true,
      clear: true,
    }, Number(opts['socket-timeout'] || 30000));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    failRequest(request, 'transport_unavailable', { error: message }, root);
    return { ok: false, status: 'transport_unavailable', error: message };
  }
  if (!response.ok) {
    failRequest(request, 'transport_unavailable', { error: response.error || 'socket injection failed' }, root);
    return { ok: false, status: 'transport_unavailable', error: response.error || 'socket injection failed' };
  }
  updateRequest(request.request_id, (item) => {
    item.status = 'sent';
    item.sent_at = nowTs();
    item.transport_backend = 'pane';
    item.pane = session.pane || '';
    item.socket_path = sock;
    return item;
  }, root);
  appendEvent('claude.request.sent', { request_id: request.request_id, session: request.session, pane: session.pane || '' }, root);
  return { ok: true, status: 'sent' };
}

function cmdSessions(opts) {
  const sessions = listSessions().map(decorateSessionRuntime);
  if (opts.json) {
    console.log(JSON.stringify({ status: 'ok', sessions }, null, 2));
  } else if (sessions.length === 0) {
    console.log('no Claude sessions registered');
  } else {
    for (const session of sessions) {
      console.log(`${session.name}\t${session.runtime_status}\t${session.transport_backend || 'pane'}\t${session.active_request || '-'}`);
    }
  }
  return 0;
}

async function cmdStart(opts) {
  const session = await ensurePaneSession(opts.name || opts.to || DEFAULT_SESSION, opts);
  appendEvent('claude.session.started', { session: session.name, backend: session.transport_backend, split_requested: Boolean(opts.split) });
  console.log(JSON.stringify({ status: 'ok', session }, null, 2));
  return 0;
}

async function cmdSend(opts) {
  const root = stateRoot();
  const trigger = validateTrigger(opts);
  const backend = 'pane';
  const body = canonicalPrompt(readPrompt(opts, root));
  if (!body.trim()) throw new Error('prompt must not be empty');
  if (byteLength(body) > bodySizeLimit()) {
    throw new Error(`prompt exceeds ${bodySizeLimit()} bytes`);
  }
  const codexPaneContext = resolveCodexPaneContext(root);
  if (!codexPaneContext.pane) {
    throw new Error(codexContextErrorMessage(codexPaneContext, 'xmux claude send'));
  }
  const sessionName = claudeSessionNameForCodexContext(opts.to || opts.name || DEFAULT_SESSION, codexPaneContext);
  const codexSession = opts['codex-session'] || codexPaneContext.sessionName || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '';
  if (codexSession) {
    const pairCheck = validateCodexTargetInSameWindow(codexSession, codexPaneContext.referencePane || process.env.TMUX_PANE || '', root);
    if (!pairCheck.ok) throw new Error(pairCheck.error);
  }

  const session = ensureSession(sessionName, { active: true, transportBackend: backend }, root);
  if (session.active_request || session.active_outbound_request || session.pending_response) {
    throw new Error(`session ${sessionName} already has active XMux cycle`);
  }

  const id = requestId();
  const hash = sha256(body);
  let phaseConfig = null;
  if (opts.phase) {
    phaseConfig = phaseEntry('claude', opts.phase);
    if (!phaseConfig) throw new Error(`unknown Claude XMux phase: ${opts.phase}`);
  }
  const title = opts.title
    ? sanitizeTitle(opts.title, id)
    : titleFromText(body, id);
  const request = {
    schema: SCHEMA_REQUEST,
    request_id: id,
    nonce: nonce(),
    title,
    trigger,
    direction: 'codex_to_claude',
    session: sessionName,
    from: opts.from || 'codex',
    to: `claude:${sessionName}`,
    mode: trigger === 'xmux-claude!' ? 'raw' : (opts.mode || 'synthesis'),
    expected_role: opts['expected-role'] || 'second_opinion',
    status: 'prepared',
    model_tier: opts['model-tier'] || process.env.XMUX_CLAUDE_MODEL_TIER || 'unknown',
    phase: phaseConfig ? phaseConfig.phase : '',
    phase_marker: phaseConfig ? phaseMarker('claude', phaseConfig.phase) : '',
    required_executor_agent: phaseConfig ? phaseConfig.required_agent : '',
    prompt_sha256: hash,
    prompt_body_bytes: byteLength(body),
    codex_session: codexSession,
    created_at: nowTs(),
    updated_at: nowTs(),
  };
  ensureDir(requestsDir(root));
  const commandPrompt = composeCommand(request, body);
  request.command_name = CODEX_REQUEST_NAME;
  if (debugPreserveBody()) {
    request.debug_prompt_path = promptPath(id, root);
    writeTextAtomic(request.debug_prompt_path, body + '\n');
  }
  writeJson(requestPath(id, root), request);

  session.active_request = id;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('claude.request.prepared', { request_id: id, session: sessionName, mode: request.mode }, root);

  if (opts['dry-run']) {
    clearActiveRequest(request, root);
    console.log(JSON.stringify({
      status: 'prepared',
      request_id: id,
      session: request.session,
      codex_session: request.codex_session,
      title: request.title,
      prompt_body_bytes: request.prompt_body_bytes,
      debug_prompt_path: request.debug_prompt_path || '',
    }, null, 2));
    return 0;
  }

  updateRequest(id, (item) => {
    item.status = 'invoking';
    item.invoked_at = nowTs();
    return item;
  }, root);
  const invoke = await invokePane(commandPrompt, request, body, opts, root);
  if (!invoke.ok) {
    console.error(`xmux claude send: ${invoke.status}${invoke.error ? `: ${invoke.error}` : ''}`);
    return 1;
  }

  const finalRequest = opts.wait ? waitRequest(id, opts.timeout || 60, root) : readJson(requestPath(id, root), request);
  const deliveryFailed = opts.wait
    && finalRequest.status === 'responded'
    && finalRequest.codex_delivery === 'failed';
  const paneDelivered = opts.wait
    && finalRequest.status === 'responded'
    && finalRequest.codex_delivery === 'sent';
  const payload = {
    status: deliveryFailed ? 'delivery_failed' : (paneDelivered ? 'delivered' : finalRequest.status),
    request_id: id,
    session: sessionName,
    title: finalRequest.title || request.title || '',
    prompt_body_bytes: finalRequest.prompt_body_bytes || request.prompt_body_bytes || 0,
    response_body_bytes: finalRequest.response_body_bytes || 0,
    body_available: Boolean(finalRequest.debug_response_path && fs.existsSync(finalRequest.debug_response_path)),
    debug_prompt_path: finalRequest.debug_prompt_path || request.debug_prompt_path || '',
    debug_response_path: finalRequest.debug_response_path || '',
    response_title: finalRequest.response_title || '',
    codex_delivery: finalRequest.codex_delivery || '',
    codex_delivery_error: finalRequest.codex_delivery_error || '',
  };
  if (opts.quiet && !deliveryFailed) {
    return finalRequest.status === 'responded' || !opts.wait ? 0 : 1;
  }
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else if (paneDelivered || deliveryFailed) {
    console.log(JSON.stringify(payload));
    if (deliveryFailed) {
      console.error(`xmux claude send: Codex delivery failed: ${payload.codex_delivery_error || 'unknown error'}`);
    }
  }
  else if (payload.debug_response_path) {
    console.log(fs.readFileSync(payload.debug_response_path, 'utf8').trimEnd());
  }
  else console.log(JSON.stringify(payload));
  if (deliveryFailed) return 1;
  return finalRequest.status === 'responded' || !opts.wait ? 0 : 1;
}

async function cmdTriggerCodex(opts) {
  const root = stateRoot();
  const codexPaneContext = resolveCodexPaneContext(root);
  if (!codexPaneContext.pane) {
    throw new Error(codexContextErrorMessage(codexPaneContext, 'xmux claude trigger-codex'));
  }
  const sessionName = claudeSessionNameForCodexContext(opts.to || opts.name || DEFAULT_SESSION, codexPaneContext);
  const body = canonicalPrompt(readPrompt(opts, root));
  if (!body.trim()) throw new Error('prompt must not be empty');
  if (byteLength(body) > bodySizeLimit()) {
    throw new Error(`prompt exceeds ${bodySizeLimit()} bytes`);
  }
  const session = readSession(sessionName, root);
  const sock = session && session.socket_path ? session.socket_path : socketPath(sessionName, root);
  if (!session || session.active === false || !sock || !fs.existsSync(sock)) {
    throw new Error(`Claude pane socket is not ready: ${sock || '(none)'}`);
  }
  const trigger = `/${COMMAND_NAME}`;
  const prompt = `${trigger}\n\n${body}`;
  const response = await socketRequest(sock, {
    type: 'prompt',
    prompt,
    enter: true,
    bracketed_paste: true,
    clear: Boolean(opts.clear),
  }, Number(opts['socket-timeout'] || process.env.XMUX_CLAUDE_SOCKET_TIMEOUT_MS || 30000));
  if (!response.ok) {
    throw new Error(response.error || 'Claude trigger injection failed');
  }
  appendEvent('claude.codex_trigger.injected', { session: sessionName, pane: session.pane || '' }, root);
  const payload = { status: 'sent', session: sessionName, pane: session.pane || '', trigger };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else if (!opts.quiet) console.log(JSON.stringify(payload));
  return 0;
}

async function cmdSendCodex(opts) {
  const root = stateRoot();
  const trigger = String(opts.trigger || '').trim();
  if (trigger !== COMMAND_NAME) {
    throw new Error(`xmux claude send-codex requires --trigger ${COMMAND_NAME}`);
  }
  const body = canonicalPrompt(readPrompt(opts, root));
  const codexPaneContext = resolveCodexPaneContext(root);
  if (!codexPaneContext.pane) {
    throw new Error(codexContextErrorMessage(codexPaneContext, 'xmux claude send-codex'));
  }
  const sessionName = claudeSessionNameForCodexContext(
    opts.from || opts.name || process.env.XMUX_CLAUDE_SESSION_NAME || DEFAULT_SESSION,
    codexPaneContext,
  );
  const result = await sendClaudeToCodexPrompt({
    body,
    title: opts.title || '',
    sessionName,
    codexSession: opts.to || codexPaneContext.sessionName || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '',
    eventName: 'cli',
    commandSource: 'xmux-cli',
    modelTier: opts['model-tier'],
    phase: opts.phase || '',
  }, root);
  const request = result.request || (result.request_id ? readJson(requestPath(result.request_id, root), null) : null);
  const payload = {
    status: result.status,
    request_id: result.request_id || (request && request.request_id) || '',
    session: (request && request.session) || sessionName,
    codex_session: (request && request.codex_session) || opts.to || '',
    title: (request && request.title) || opts.title || '',
    error: result.reason || '',
  };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else if (!opts.quiet) console.log(JSON.stringify(payload));
  return result.status === 'sent' ? 0 : 1;
}

function cmdRead(id, opts) {
  const request = readJson(requestPath(id), null);
  if (!request) throw new Error(`request not found: ${id}`);
  const text = fs.existsSync(request.debug_response_path || '') ? fs.readFileSync(request.debug_response_path, 'utf8') : '';
  if (opts.json) {
    console.log(JSON.stringify({
      status: request.status,
      request,
      text,
      body_available: Boolean(text),
    }, null, 2));
  }
  else process.stdout.write(text);
  return request.status === 'responded' ? 0 : 1;
}

function cmdStatus(opts) {
  const name = opts.to || opts.name;
  if (name) {
    const session = readSession(name);
    if (!session) throw new Error(`session not found: ${name}`);
    console.log(JSON.stringify({ status: 'ok', session: decorateSessionRuntime(session) }, null, 2));
    return 0;
  }
  return cmdSessions({ ...opts, json: true });
}

function cmdStop(opts) {
  const name = opts.name || opts.to || DEFAULT_SESSION;
  const session = readSession(name);
  if (!session) throw new Error(`session not found: ${name}`);
  if (session.active_request) {
    updateRequest(session.active_request, (item) => {
      item.status = 'failed';
      item.error = 'session stopped before response';
      return item;
    });
  }
  if (session.active_outbound_request) {
    updateRequest(session.active_outbound_request, (item) => {
      item.status = 'failed';
      item.error = 'session stopped before Codex response';
      return item;
    });
  }
  session.active = false;
  delete session.active_request;
  delete session.active_outbound_request;
  delete session.pending_response;
  if (session.pane) clearClaudePaneProgress(session.pane);
  if (session.pane && tmuxPaneAlive(session.pane)) {
    killTmuxPane(session.pane);
    session.pane_killed_at = nowTs();
  }
  if (session.socket_path) {
    try {
      fs.unlinkSync(session.socket_path);
    } catch (_) {
      // Socket cleanup is best effort; pane runner also removes it on exit.
    }
  }
  clearSessionVolatileState(session);
  session.updated_at = nowTs();
  const written = writeSession(session);
  appendEvent('claude.session.stopped', { session: name });
  console.log(JSON.stringify({ status: 'ok', session: written }, null, 2));
  return 0;
}

function cmdEnsureHooks(opts) {
  const args = ['ensure-hooks'];
  if (opts.quiet) args.push('--quiet');
  if (opts.json) args.push('--json');
  if (opts['dry-run']) args.push('--dry-run');
  return claudeSetupMain(args);
}

function cmdPaneRun(opts) {
  const name = safeComponent(opts.name || opts.to || DEFAULT_SESSION, 'session');
  const root = stateRoot();
  const script = path.join(installRoot(), 'runtime', 'claude', 'pane-run.py');
  if (!fs.existsSync(script)) throw new Error(`missing Claude pane runner: ${script}`);
  const sock = opts.socket ? path.resolve(expandUser(opts.socket)) : socketPath(name, root);
  const launch = opts['launch-id'] || process.env.XMUX_CLAUDE_LAUNCH_ID || launchId();
  const args = [
    script,
    '--name', name,
    '--project-dir', projectDir(),
    '--state-dir', root,
    '--socket', sock,
    '--launch-id', launch,
  ];
  if (opts['claude-cmd']) args.push('--claude-cmd', opts['claude-cmd']);
  const result = spawnSync('python3', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      XMUX_CLAUDE_SESSION_NAME: name,
      XMUX_CLAUDE_SOCKET: sock,
      XMUX_CLAUDE_LAUNCH_ID: launch,
      XMUX_PROJECT_DIR: projectDir(),
      XMUX_STATE_DIR: root,
      XMUX_INSTALL_DIR: installRoot(),
    },
  });
  if (!result.error) sleep(SESSION_EXIT_CLEANUP_SETTLE_MS);
  try {
    finalizePaneRunSessionExit(name, root, result, { launch });
  } catch (error) {
    appendEvent('claude.session.exit_cleanup_failed', {
      session: name,
      error: error && error.message ? error.message : String(error),
    }, root);
  }
  if (result.error) throw new Error(`failed to start pane runner: ${result.error.message}`);
  return result.status == null ? 1 : result.status;
}

function readHookInput() {
  if (process.stdin.isTTY) return {};
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function cmdHookSessionStart() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const envName = process.env.XMUX_CLAUDE_SESSION_NAME || '';
  const source = String(input.source || '').trim() || 'unknown';
  const claudeSessionId = input.session_id || input.sessionId || '';
  const launch = process.env.XMUX_CLAUDE_LAUNCH_ID || '';
  let session = envName ? readSession(envName, root) : hookSession(input, root);
  if (!session && envName) {
    session = ensureSession(envName, { active: true, transportBackend: 'pane' }, root);
  }
  if (!session) {
    appendEvent('claude.hook.session_start.noop', {
      source,
      reason: 'session_not_found',
      claude_session_id: claudeSessionId,
    }, root);
    return 0;
  }

  if (source === 'clear' && session.active_request) {
    const request = readJson(requestPath(session.active_request, root), null);
    if (request) {
      failRequest(request, 'failed', {
        error: 'Claude session cleared before response',
        cleared_at: nowTs(),
        clear_source: source,
      }, root);
    } else {
      const stale = readSession(session.name, root) || session;
      delete stale.active_request;
      stale.updated_at = nowTs();
      writeSession(stale, root);
    }
  }
  if (source === 'clear' && session.active_outbound_request) {
    const request = readJson(requestPath(session.active_outbound_request, root), null);
    if (request) {
      updateRequest(request.request_id, (item) => {
        item.status = 'failed';
        item.error = 'Claude session cleared before Codex response';
        item.cleared_at = nowTs();
        item.clear_source = source;
        return item;
      }, root);
    }
    const stale = readSession(session.name, root) || session;
    delete stale.active_outbound_request;
    delete stale.pending_response;
    stale.updated_at = nowTs();
    writeSession(stale, root);
  }

  const next = readSession(session.name, root) || session;
  clearSessionExitMarkers(next);
  if (claudeSessionId) next.claude_session_id = claudeSessionId;
  if (launch) next.pane_launch_id = launch;
  next.pane_ready_at = nowTs();
  next.pane_ready_source = source;
  next.pane_ready_model = input.model || '';
  next.pane_ready_transcript_path = input.transcript_path || input.transcriptPath || '';
  next.pane_ready_cwd = input.cwd || '';
  next.active = true;
  next.updated_at = nowTs();
  writeSession(next, root);
  appendEvent('claude.hook.session_start.ready', {
    session: next.name,
    source,
    launch_id: launch,
    claude_session_id: claudeSessionId,
  }, root);
  return 0;
}

function hookSession(input, root = stateRoot()) {
  const envName = process.env.XMUX_CLAUDE_SESSION_NAME || '';
  if (envName) {
    const byEnv = readSession(envName, root);
    if (byEnv && byEnv.active !== false) {
      const claudeSessionId = input.session_id || input.sessionId || '';
      if (claudeSessionId && byEnv.claude_session_id !== claudeSessionId) {
        byEnv.claude_session_id = claudeSessionId;
        byEnv.updated_at = nowTs();
        writeSession(byEnv, root);
      }
      return byEnv;
    }
  }
  const byClaudeId = findSessionByClaudeId(input.session_id || input.sessionId || '', root);
  if (byClaudeId) return byClaudeId;
  const only = uniqueActiveSession(root);
  if (!only) return null;
  if (input.session_id || input.sessionId) {
    only.claude_session_id = input.session_id || input.sessionId;
    only.updated_at = nowTs();
    writeSession(only, root);
  }
  return only;
}

function hookSessionForRequest(input, request, root = stateRoot()) {
  const envName = process.env.XMUX_CLAUDE_SESSION_NAME || '';
  if (envName) {
    const byEnv = readSession(envName, root);
    if (byEnv && byEnv.name === request.session && byEnv.active !== false) return byEnv;
  }
  const claudeSessionId = input.session_id || input.sessionId || '';
  const byClaudeId = findSessionByClaudeId(claudeSessionId, root);
  if (byClaudeId) return byClaudeId.name === request.session ? byClaudeId : null;
  const session = readSession(request.session, root);
  if (!session || session.active === false) return null;
  if (session.active_request && session.active_request !== request.request_id) return null;
  if (claudeSessionId) {
    session.claude_session_id = claudeSessionId;
  }
  session.updated_at = nowTs();
  writeSession(session, root);
  return session;
}

function activePhaseRequest(input, root = stateRoot()) {
  const session = hookSession(input, root);
  if (!session || !session.active_request) return { session, request: null };
  const request = readJson(requestPath(session.active_request, root), null);
  if (!request || request.status !== 'accepted') return { session, request: null };
  if (!request.required_executor_agent) return { session, request: null };
  return { session, request };
}

function agentNameFromHookInput(input = {}) {
  const toolInput = input.tool_input || input.toolInput || {};
  return String(
    input.agent_type
    || input.agentType
    || input.subagent_type
    || input.subagentType
    || input.agent_name
    || input.agentName
    || toolInput.agent_type
    || toolInput.agentType
    || toolInput.subagent_type
    || toolInput.subagentType
    || toolInput.agent
    || toolInput.name
    || ''
  ).trim();
}

function claudeAgentFileCandidates(agentName, input = {}) {
  const project = hookProjectRoot(input);
  return [
    path.join(project, '.claude', 'agents', `${agentName}.md`),
    path.join(os.homedir(), '.claude', 'agents', `${agentName}.md`),
  ];
}

function readClaudeAgentDefinition(agentName, input = {}) {
  for (const candidate of claudeAgentFileCandidates(agentName, input)) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const content = fs.readFileSync(candidate, 'utf8');
      const model = (content.match(/^model:\s*([^\n#]+)/m) || [])[1] || '';
      return {
        path: candidate,
        hash: sha256(content),
        model: model.trim(),
      };
    } catch (_) {
      continue;
    }
  }
  return { path: '', hash: '', model: '' };
}

function requestExecutorEvent(root, request) {
  if (!request || !request.executor_event_ref) return null;
  const event = findExecutorEvent(root, request.executor_event_ref);
  if (!event) return null;
  if (event.request_id !== request.request_id) return null;
  if (event.agent_name !== request.required_executor_agent) return null;
  if (request.phase_marker && event.phase_marker !== request.phase_marker) return null;
  return event;
}

function extractAssistantTextFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.last_assistant_message === 'string') return entry.last_assistant_message;
  if (typeof entry.lastAssistantMessage === 'string') return entry.lastAssistantMessage;
  if (entry.type && entry.type !== 'assistant') return '';
  const message = entry.message && typeof entry.message === 'object' ? entry.message : entry;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

function lastAssistantFromTranscript(transcriptPath) {
  if (!transcriptPath) return '';
  const filePath = path.resolve(expandUser(transcriptPath));
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (_) {
    return '';
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const assistantText = extractAssistantTextFromEntry(entry).trim();
      if (assistantText) last = assistantText;
    } catch (_) {
      continue;
    }
  }
  return last;
}

async function maybeRouteClaudeToCodexFromUserPrompt(input, root) {
  const trigger = await startClaudeToCodexCycle(input, 'UserPromptSubmit', root);
  if (trigger.status === 'no_marker') return false;
  if (trigger.status === 'sent') {
    writeHookBlock('UserPromptSubmit', 'XMux routed this prompt to Codex.');
    return true;
  }
  appendEvent('claude.hook.user_prompt.blocked', {
    request_id: trigger.request_id || '',
    reason: trigger.reason || 'trigger_failed',
  }, root);
  writeHookBlock('UserPromptSubmit', `XMux could not route this prompt to Codex: ${trigger.reason || 'unknown error'}`);
  return true;
}

function buildClaudeToCodexTriggerContext(input = {}) {
  const parsed = parseClaudeToCodexTrigger(input);
  if (!parsed) return '';
  const instruction = canonicalPrompt(parsed.body || '');
  return [
    'XMux Claude-to-Codex trigger detected.',
    '',
    'The current prompt invokes /xmux-codex. Treat the prompt text as routing and synthesis instructions, not as the final Codex-facing payload.',
    'Do not forward the routing instruction verbatim unless it explicitly asks for literal/raw forwarding.',
    'Synthesize a Codex-facing prompt from the current Claude conversation, relevant evidence, and the user routing instruction.',
    '',
    'When the Codex-facing prompt is ready, send it through the single XMux entrypoint:',
    '',
    '```zsh',
    'xmux claude send-codex --trigger xmux-codex --title "<short request title>" --prompt "<synthesized Codex-facing prompt>" --quiet',
    '```',
    '',
    'After the XMux command succeeds, do not answer the original /xmux-codex request directly. Wait for the Codex response marker.',
    '',
    '<xmux_codex_routing_instruction>',
    instruction,
    '</xmux_codex_routing_instruction>',
  ].join('\n');
}

async function cmdHookUserPrompt() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const requestResult = await acceptXmuxCommand(input, 'UserPromptSubmit', root);
  if (requestResult.status !== 'no_marker') {
    if (requestResult.status === 'already_accepted') return 0;
    if (requestResult.status !== 'accepted') {
      appendEvent('claude.hook.user_prompt.blocked', {
        request_id: requestResult.request_id || '',
        reason: requestResult.reason || 'request_validation_failed',
      }, root);
      if (isExplicitXmuxPrompt(input)) writeHookBlock('UserPromptSubmit', 'Invalid or stale XMux Codex request.');
      return 0;
    }
    writeHookContext('UserPromptSubmit', buildAdditionalContext(requestResult.request));
    return 0;
  }

  const responseResult = await acceptCodexResponseMarker(input, root);
  if (responseResult.status !== 'no_marker') {
    if (responseResult.status === 'already_accepted') return 0;
    if (responseResult.status !== 'accepted') {
      appendEvent('claude.hook.user_prompt.blocked', {
        request_id: responseResult.request_id || '',
        reason: responseResult.reason || 'response_validation_failed',
      }, root);
      if (isExplicitXmuxPrompt(input)) writeHookBlock('UserPromptSubmit', 'Invalid or stale XMux Codex response.');
      return 0;
    }
    appendEvent('claude.hook.codex_response.pass_through', {
      request_id: responseResult.request.request_id,
      session: responseResult.request.session || DEFAULT_SESSION,
      title: responseResult.request.response_title || 'Codex response',
    }, root);
    return 0;
  }

  const triggerContext = buildClaudeToCodexTriggerContext(input);
  if (triggerContext) {
    appendEvent('claude.hook.codex_trigger.detected', { hook: 'UserPromptSubmit' }, root);
    writeHookContext('UserPromptSubmit', triggerContext);
  }
  return 0;
}

async function cmdHookUserPromptExpansion() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const triggerContext = buildClaudeToCodexTriggerContext(input);
  if (triggerContext) {
    appendEvent('claude.hook.codex_trigger.detected', { hook: 'UserPromptExpansion' }, root);
    writeHookContext('UserPromptExpansion', triggerContext);
    return 0;
  }

  const result = await acceptXmuxCommand(input, 'UserPromptExpansion', root);
  if (result.status === 'no_marker') return 0;
  if (result.status === 'already_accepted') return 0;
  if (result.status !== 'accepted') {
    appendEvent('claude.hook.user_prompt_expansion.blocked', {
      request_id: result.request_id || '',
      reason: result.reason || 'request_validation_failed',
    }, root);
    writeHookBlock('UserPromptExpansion', 'Invalid or stale XMux Codex request.');
    return 0;
  }
  writeHookContext('UserPromptExpansion', buildAdditionalContext(result.request));
  return 0;
}

function cmdHookPreToolUse() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const { request } = activePhaseRequest(input, root);
  if (!request) return 0;
  const toolName = String(input.tool_name || input.toolName || '').trim();
  if (!/^(Agent|Task)$/i.test(toolName)) return 0;
  const agentName = agentNameFromHookInput(input);
  if (agentName !== request.required_executor_agent) {
    appendEvent('claude.hook.phase_executor.blocked', {
      request_id: request.request_id,
      phase: request.phase || '',
      phase_marker: request.phase_marker || '',
      required_agent: request.required_executor_agent || '',
      attempted_agent: agentName,
      tool: toolName,
    }, root);
    writeHookBlock('PreToolUse', `XMux phase ${request.phase || request.phase_marker} requires subagent ${request.required_executor_agent}; attempted ${agentName || '(unknown)'}.`);
  }
  return 0;
}

function cmdHookSubagentStop() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const { request } = activePhaseRequest(input, root);
  if (!request) return 0;
  const agentName = agentNameFromHookInput(input);
  if (agentName !== request.required_executor_agent) {
    appendEvent('claude.hook.subagent_stop.ignored', {
      request_id: request.request_id,
      phase: request.phase || '',
      required_agent: request.required_executor_agent || '',
      agent_name: agentName,
    }, root);
    return 0;
  }
  const definition = readClaudeAgentDefinition(agentName, input);
  const executorEvent = appendExecutorEvent({
    request_id: request.request_id,
    lineage: 'claude',
    event: 'stop',
    phase_marker: request.phase_marker || '',
    phase: request.phase || '',
    agent_name: agentName,
    agent_model: definition.model || input.model || input.model_name || 'unknown',
    agent_definition_hash: definition.hash,
    transcript_path: input.transcript_path || input.transcriptPath || '',
    hook_event: 'SubagentStop',
  }, root);
  updateRequest(request.request_id, (item) => {
    item.executor_event_ref = executorEvent.event_id;
    item.executor_agent = agentName;
    item.executor_agent_definition_hash = definition.hash;
    item.executor_agent_model = definition.model || input.model || input.model_name || '';
    return item;
  }, root);
  appendEvent('claude.hook.subagent_stop.recorded', {
    request_id: request.request_id,
    phase: request.phase || '',
    phase_marker: request.phase_marker || '',
    agent_name: agentName,
    executor_event_id: executorEvent.event_id,
  }, root);
  return 0;
}

async function cmdHookStop() {
  const input = readHookInput();
  const root = hookStateRoot(input, { requireExisting: true });
  if (!root) return 0;
  const session = hookSession(input, root);
  if (!session || !session.active_request) return 0;
  const request = readJson(requestPath(session.active_request, root), null);
  if (!request || request.status === 'responded') return 0;
  if (request.status !== 'accepted' || request.accepted_via !== CODEX_REQUEST_NAME || (request.direction && request.direction !== 'codex_to_claude')) {
    appendEvent('claude.hook.stop.noop', {
      request_id: session.active_request,
      reason: 'request_not_accepted_by_xmux_codex',
      status: request.status || '',
      accepted_via: request.accepted_via || '',
    }, root);
    return 0;
  }
  if (request.required_executor_agent && !requestExecutorEvent(root, request)) {
    appendEvent('claude.hook.stop.blocked', {
      request_id: request.request_id,
      phase: request.phase || '',
      phase_marker: request.phase_marker || '',
      required_agent: request.required_executor_agent || '',
      reason: 'executor_event_missing',
    }, root);
    writeHookBlock('Stop', `XMux phase ${request.phase || request.phase_marker} requires subagent ${request.required_executor_agent}. Invoke that subagent and synthesize its result before stopping.`);
    return 0;
  }
  const text = input.last_assistant_message
    || input.lastAssistantMessage
    || lastAssistantFromTranscript(input.transcript_path || input.transcriptPath || '');
  if (!text) {
    appendEvent('claude.hook.stop.noop', { request_id: session.active_request, reason: 'empty_last_assistant_message' }, root);
    return 0;
  }
  const next = markResponded(request, text, 'claude-stop-hook', root);
  await deliverResponseToCodex(next, canonicalPrompt(text), root);
  return 0;
}

function usage() {
  console.error(`Usage:
  xmux claude sessions [--json]
  xmux claude start [--name <name>] [--split]
  xmux claude ensure-hooks [--json]
  xmux claude send --trigger xmux-claude|xmux-claude! --transport-consent <trigger> [--to <name>] [--title <text>] [--phase <phase>] [--model-tier <tier>] [--prompt <text>|--stdin] [--wait] [--json]
  xmux claude send-codex --trigger xmux-codex [--from <name>] [--to <codex-session>] [--title <text>] [--phase <phase>] [--model-tier <tier>] [--prompt <text>|--stdin] [--json]
  xmux claude trigger-codex [--to <name>] [--prompt <text>|--stdin] [--json]
  xmux claude read <request_id> [--json]
  xmux claude status [--to <name>]
  xmux claude stop --name <name>
  xmux claude pane-run --name <name>
  xmux claude hook session-start|user-prompt|user-prompt-expansion|pre-tool-use|subagent-stop|stop`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || '';
  const rest = argv.slice(1);
  const opts = parseArgs(rest);
  try {
    switch (command) {
      case 'sessions':
        return cmdSessions(opts);
      case 'start':
        return await cmdStart(opts);
      case 'ensure-hooks':
      case 'install-hooks':
        return cmdEnsureHooks(opts);
      case 'send':
        return await cmdSend(opts);
      case 'send-codex':
        return await cmdSendCodex(opts);
      case 'trigger-codex':
        return await cmdTriggerCodex(opts);
      case 'read':
        if (!opts._[0]) throw new Error('read requires request_id');
        return cmdRead(opts._[0], opts);
      case 'status':
        return cmdStatus(opts);
      case 'stop':
        return cmdStop(opts);
      case 'pane-run':
        return cmdPaneRun(opts);
      case 'hook':
        if (opts._[0] === 'session-start') return cmdHookSessionStart();
        if (opts._[0] === 'user-prompt') return await cmdHookUserPrompt();
        if (opts._[0] === 'user-prompt-expansion') return await cmdHookUserPromptExpansion();
        if (opts._[0] === 'pre-tool-use') return cmdHookPreToolUse();
        if (opts._[0] === 'subagent-stop') return cmdHookSubagentStop();
        if (opts._[0] === 'stop') return cmdHookStop();
        throw new Error('hook requires session-start, user-prompt, user-prompt-expansion, pre-tool-use, subagent-stop, or stop');
      case '-h':
      case '--help':
      case 'help':
      case '':
        usage();
        return command ? 0 : 2;
      default:
        throw new Error(`unknown xmux claude command: ${command}`);
    }
  } catch (error) {
    console.error(`xmux claude: ${error && error.message ? error.message : String(error)}`);
    return 1;
  }
}

module.exports = {
  main,
  composeCommand,
  composeResponseCommand,
  clearOutboundRequest,
  sendCodexResponseToSession,
  resolveCodexPaneContext,
  decorateSessionRuntime,
  finalizePaneRunSessionExit,
  pathWithXmuxCommandBin,
  xmuxCommandBinForInstallDir,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`xmux claude: ${error && error.message ? error.message : String(error)}`);
      process.exit(1);
    });
}
