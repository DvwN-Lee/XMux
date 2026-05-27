'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  listUnifiedSessions,
  readUnifiedSession,
  unifiedSessionPath,
  writeLegacySessionMirror,
  writeUnifiedSession,
} = require('../xmux/session-state');
const { appendRouteEvent } = require('../xmux/workflow-state');
const { parsePhaseMarker } = require('../xmux/phase-registry');

const SCHEMA_SESSION = 'xmux.codex.session.v1';
const DEFAULT_SESSION = 'default';
const CLAUDE_RESPONSE_NAME = 'xmux-claude-response';
const CLAUDE_REQUEST_NAME = 'xmux-claude-request';
const CODEX_RESPONSE_NAME = 'xmux-codex-response';
const CLAUDE_RESPONSE_MARKER = `[${CLAUDE_RESPONSE_NAME}]`;
const CLAUDE_REQUEST_MARKER = `[${CLAUDE_REQUEST_NAME}]`;
const CODEX_RESPONSE_MARKER = `[${CODEX_RESPONSE_NAME}]`;
const HOOK_TAG_KEY = 'XMUX_HOOK_TAG';
const HOOK_TAG_VALUE = 'xmux-codex-harness';

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

function codexHome(opts = {}) {
  return opts.home
    ? path.resolve(expandUser(opts.home))
    : process.env.CODEX_HOME
    ? path.resolve(expandUser(process.env.CODEX_HOME))
    : path.join(os.homedir(), '.codex');
}

function stateRoot() {
  if (process.env.XMUX_STATE_DIR) return path.resolve(expandUser(process.env.XMUX_STATE_DIR));
  if (process.env.XMUX_PROJECT_DIR) return path.join(path.resolve(expandUser(process.env.XMUX_PROJECT_DIR)), '.codex', 'xmux');
  return path.join(projectRoot(), '.codex', 'xmux');
}

function hookInputCwd(input = {}) {
  return input.cwd
    || input.working_directory
    || input.workingDirectory
    || input.project_dir
    || input.projectDir
    || process.cwd();
}

function hookStateRoot(input = {}) {
  if (process.env.XMUX_STATE_DIR || process.env.XMUX_PROJECT_DIR) return stateRoot();
  const root = path.join(projectRoot(hookInputCwd(input)), '.codex', 'xmux');
  return fs.existsSync(root) ? root : '';
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

function projectDir() {
  if (process.env.XMUX_PROJECT_DIR) return path.resolve(expandUser(process.env.XMUX_PROJECT_DIR));
  return projectRoot();
}

function codexRoot(root = stateRoot()) {
  return path.join(root, 'codex');
}

function claudeRoot(root = stateRoot()) {
  return path.join(root, 'claude');
}

function sessionsDir(root = stateRoot()) {
  return path.join(root, 'sessions');
}

function claudeRequestsDir(root = stateRoot()) {
  return path.join(claudeRoot(root), 'requests');
}

function claudeResponsesDir(root = stateRoot()) {
  return path.join(claudeRoot(root), 'responses');
}

function eventsPath(root = stateRoot()) {
  return path.join(codexRoot(root), 'events.jsonl');
}

function safeComponent(value, field) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') throw new Error(`${field} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  return text;
}

function defaultSessionName() {
  return process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || DEFAULT_SESSION;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

function codexHookEventKeyLabel(eventName) {
  if (eventName === 'UserPromptSubmit') return 'user_prompt_submit';
  if (eventName === 'Stop') return 'stop';
  return String(eventName || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function codexHookTrustHash(eventName, options = {}) {
  const handler = {
    async: false,
    command: String(options.command || ''),
    timeout: Number(options.timeoutSec || 600),
    type: 'command',
  };
  if (options.statusMessage !== undefined) handler.statusMessage = String(options.statusMessage);
  const identity = {
    event_name: codexHookEventKeyLabel(eventName),
    hooks: [handler],
  };
  if (options.matcher !== undefined && options.matcher !== null) {
    identity.matcher = String(options.matcher);
  }
  return `sha256:${sha256(JSON.stringify(canonicalJson(identity)))}`;
}

function responseNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function canonicalPrompt(text) {
  return String(text || '').trimEnd();
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function keySequence(name) {
  const key = String(name || '').trim().toLowerCase();
  if (key === 'esc' || key === 'escape') return '\x1b';
  if (key === 'enter' || key === 'return') return '\r';
  if (key === 'tab') return '\t';
  if (key === 'up') return '\x1b[A';
  if (key === 'down') return '\x1b[B';
  if (key === 'left') return '\x1b[D';
  if (key === 'right') return '\x1b[C';
  throw new Error(`unsupported key: ${name}`);
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

function titleFromText(text, fallback = 'XMux message') {
  const firstLine = canonicalPrompt(text).split(/\r?\n/).find((line) => line.trim()) || '';
  return sanitizeTitle(firstLine, fallback);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function xmuxBinPath() {
  const candidate = path.join(installRoot(), 'bin', 'xmux');
  return fs.existsSync(candidate) ? candidate : 'xmux';
}

function socketPath(name, root = stateRoot()) {
  const safeName = safeComponent(name, 'session');
  const digest = sha256(path.resolve(root)).slice(0, 12);
  const dir = process.env.XMUX_CODEX_SOCKET_DIR
    ? path.resolve(expandUser(process.env.XMUX_CODEX_SOCKET_DIR))
    : '/tmp';
  return path.join(dir, `xmux-codex-${digest}-${safeName}.sock`);
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

function tmuxPaneAlive(pane) {
  if (!pane) return false;
  const result = spawnSync('tmux', ['display-message', '-pt', pane, '#{pane_dead}'], { encoding: 'utf8' });
  return result.status === 0 && String(result.stdout || '').trim() === '0';
}

function killTmuxPane(pane) {
  if (!tmuxPaneAlive(pane)) return false;
  const result = spawnSync('tmux', ['kill-pane', '-t', pane], { encoding: 'utf8' });
  return result.status === 0;
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

function tomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertCodexHookTrust(configFile, key, trustedHash) {
  let text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const header = `[hooks.state."${tomlString(key)}"]`;
  const sectionRe = new RegExp(`(^|\\n)${escapeRegExp(header)}\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`);
  if (!sectionRe.test(text)) {
    const block = `${header}\ntrusted_hash = "${tomlString(trustedHash)}"\n`;
    text = text.trimEnd() ? `${text.trimEnd()}\n\n${block}` : `${block}`;
    writeTextAtomic(configFile, text);
    return;
  }
  text = text.replace(sectionRe, (match, prefix, body) => {
    const nextBody = /^trusted_hash\s*=/m.test(body)
      ? body.replace(/^trusted_hash\s*=.*$/m, `trusted_hash = "${tomlString(trustedHash)}"`)
      : `trusted_hash = "${tomlString(trustedHash)}"\n${body}`;
    return `${prefix}${header}\n${nextBody}`;
  });
  writeTextAtomic(configFile, text);
}

function appendEvent(event, data = {}, root = stateRoot()) {
  ensureDir(path.dirname(eventsPath(root)));
  fs.appendFileSync(eventsPath(root), `${JSON.stringify({ ts: nowTs(), event, data })}\n`, 'utf8');
}

function sessionPath(name, root = stateRoot()) {
  return unifiedSessionPath('codex', name, root);
}

function claudeRequestPath(id, root = stateRoot()) {
  return path.join(claudeRequestsDir(root), `${safeComponent(id, 'request_id')}.json`);
}

function claudeResponsePath(id, root = stateRoot()) {
  return path.join(claudeResponsesDir(root), `${safeComponent(id, 'request_id')}.md`);
}

function readSession(name, root = stateRoot()) {
  return readUnifiedSession('codex', name, root);
}

function writeSession(session, root = stateRoot()) {
  const written = writeUnifiedSession('codex', session, root);
  writeLegacySessionMirror('codex', written, root);
  return written;
}

function pendingTtlMs() {
  const seconds = Number(process.env.XMUX_BODY_TTL_SECONDS || 120);
  return Math.max(1, Number.isFinite(seconds) ? seconds : 120) * 1000;
}

function isPendingExpired(pending) {
  if (!pending || !pending.set_at) return false;
  const ts = Date.parse(pending.set_at);
  return Number.isFinite(ts) && Date.now() - ts > pendingTtlMs();
}

function clearExpiredPending(session, root = stateRoot()) {
  if (!session) return session;
  let changed = false;
  for (const field of ['pending_request', 'pending_response']) {
    const pending = session[field];
    if (!isPendingExpired(pending)) continue;
    appendEvent('codex.pending.expired', {
      session: session.name || defaultSessionName(),
      field,
      request_id: pending.request_id || '',
      set_at: pending.set_at || '',
    }, root);
    delete session[field];
    changed = true;
  }
  if (changed) {
    session.updated_at = nowTs();
    writeSession(session, root);
  }
  return session;
}

const PANE_RUN_EXIT_MARKER_FIELDS = [
  'status',
  'terminated_at',
  'exited_at',
  'exit_code',
  'exit_signal',
  'socket_removed_at',
  'pane_killed_at',
  'pane_exited_at',
];
const SESSION_VOLATILE_FIELDS = [
  'active_request',
  'pending_request',
  'pending_response',
];

function clearPaneRunExitMarkers(session = {}) {
  if (!session || typeof session !== 'object') return session;
  for (const field of PANE_RUN_EXIT_MARKER_FIELDS) delete session[field];
  return session;
}

function clearSessionVolatileState(session = {}) {
  if (!session || typeof session !== 'object') return session;
  for (const field of SESSION_VOLATILE_FIELDS) delete session[field];
  return session;
}

function listSessions(root = stateRoot()) {
  ensureDir(sessionsDir(root));
  return listUnifiedSessions(root)
    .filter((item) => item.role === 'codex')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function resolveTargetSessionName(name = '', root = stateRoot()) {
  const requested = String(name || '').trim();
  if (requested) return safeComponent(requested, 'session');
  const envName = String(process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '').trim();
  if (envName) return safeComponent(envName, 'session');
  const active = listSessions(root).filter((session) => session.active !== false);
  if (active.length === 1) return safeComponent(active[0].name, 'session');
  return DEFAULT_SESSION;
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
    if (['json', 'stdin', 'no-enter', 'no-bracketed-paste', 'quiet', 'clear', 'force'].includes(key)) {
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

function readPrompt(opts) {
  if (opts.stdin) return readStdinRequired();
  if (opts.prompt !== undefined) return String(opts.prompt);
  throw new Error('provide --prompt or --stdin');
}

function socketRequestOnce(sock, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    let response = '';
    const socket = net.createConnection(sock);
    const timer = setTimeout(() => finish({ ok: false, error: 'socket timeout' }), timeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return last;
}

async function sendPromptToSession(options = {}) {
  const root = options.root ? path.resolve(expandUser(options.root)) : stateRoot();
  const name = safeComponent(options.name || defaultSessionName(), 'session');
  const prompt = options.allowControl ? String(options.prompt || '') : canonicalPrompt(options.prompt || '');
  if (!options.allowControl && !prompt.trim()) return { ok: false, status: 'rejected', error: 'prompt must not be empty' };
  let session = readSession(name, root);
  session = clearExpiredPending(session, root);
  const sock = options.socket || (session && session.socket_path) || socketPath(name, root);
  if (!sock || !fs.existsSync(sock)) {
    return { ok: false, status: 'unavailable', error: `Codex pane socket is not ready: ${sock || '(none)'}` };
  }
  if (session && !options.force && (session.active_request || session.pending_request || session.pending_response)) {
    return { ok: false, status: 'peer_busy', error: 'Codex session already has an active XMux cycle; use --force to override' };
  }
  const response = await socketRequest(sock, {
    type: 'prompt',
    prompt,
    enter: options.enter !== false,
    bracketed_paste: options.bracketedPaste !== false,
    clear: Boolean(options.clear),
  }, Number(options.timeoutMs || process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 30000));
  if (!response.ok) return { ok: false, status: 'failed', error: response.error || 'socket injection failed' };
  appendEvent('codex.prompt.injected', {
    session: name,
    pane: session && session.pane ? session.pane : '',
    origin: options.origin || 'codex-send',
    forced: Boolean(options.force),
  }, root);
  return { ok: true, status: 'sent', session: name, pane: session && session.pane ? session.pane : '', socket_path: sock };
}

async function sendResponseToSession(options = {}) {
  const root = options.root ? path.resolve(expandUser(options.root)) : stateRoot();
  const name = safeComponent(options.name || defaultSessionName(), 'session');
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
  const title = sanitizeTitle(request.response_title || options.title || body, 'Claude response');
  const prompt = canonicalPrompt(options.prompt || `${CLAUDE_RESPONSE_MARKER}\n\n${title}`);
  let session = readSession(name, root);
  session = clearExpiredPending(session, root);
  const sock = options.socket || (session && session.socket_path) || socketPath(name, root);
  if (!session || !sock || !fs.existsSync(sock)) {
    return { ok: false, status: 'unavailable', error: `Codex pane socket is not ready: ${sock || '(none)'}` };
  }
  if (session.active_request || session.pending_request) {
    return { ok: false, status: 'peer_busy', error: 'Codex session already has an active XMux cycle' };
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
  }, Number(options.timeoutMs || process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 30000));
  if (!response.ok) {
    const latest = readSession(name, root);
    if (latest && latest.pending_response && latest.pending_response.request_id === requestIdValue) {
      delete latest.pending_response;
      latest.updated_at = nowTs();
      writeSession(latest, root);
    }
    return { ok: false, status: 'failed', error: response.error || 'socket injection failed' };
  }
  appendEvent('codex.response.injected', { session: name, request_id: requestIdValue, pane: session.pane || '', title }, root);
  return { ok: true, status: 'sent', session: name, pane: session.pane || '', socket_path: sock };
}

async function sendRequestToSession(options = {}) {
  const root = options.root ? path.resolve(expandUser(options.root)) : stateRoot();
  const name = resolveTargetSessionName(options.name || options.to || '', root);
  const request = options.request || {};
  const requestIdValue = safeComponent(request.request_id || options.request_id || '', 'request_id');
  const nonceValue = String(request.nonce || options.nonce || '').trim();
  if (!/^[A-Fa-f0-9]{32,128}$/.test(nonceValue)) {
    return { ok: false, status: 'rejected', error: 'request nonce missing' };
  }
  const body = canonicalPrompt(options.body || '');
  if (!body.trim()) return { ok: false, status: 'rejected', error: 'request body must not be empty' };
  const digest = request.prompt_sha256 || sha256(body);
  if (sha256(body) !== digest) {
    return { ok: false, status: 'rejected', error: 'request body sha256 mismatch' };
  }
  const title = sanitizeTitle(request.title || options.title || body, 'Claude request');
  const prompt = canonicalPrompt(options.prompt || `${CLAUDE_REQUEST_MARKER}\n\n${body}`);
  let session = readSession(name, root);
  session = clearExpiredPending(session, root);
  const sock = options.socket || (session && session.socket_path) || socketPath(name, root);
  if (!session || !sock || !fs.existsSync(sock)) {
    return { ok: false, status: 'unavailable', error: `Codex pane socket is not ready: ${sock || '(none)'}` };
  }
  if (session.active_request || session.pending_request || session.pending_response) {
    return { ok: false, status: 'peer_busy', error: 'Codex session already has an active XMux cycle' };
  }
  session.pending_request = {
    request_id: requestIdValue,
    nonce: nonceValue,
    prompt_sha256: digest,
    title,
    set_at: nowTs(),
  };
  session.updated_at = nowTs();
  writeSession(session, root);
  const response = await socketRequest(sock, {
    type: 'inject_request',
    request_id: requestIdValue,
    nonce: nonceValue,
    title,
    body,
    sha256: digest,
    prompt,
    enter: options.enter !== false,
    bracketed_paste: options.bracketedPaste !== false,
    clear: Boolean(options.clear),
  }, Number(options.timeoutMs || process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 30000));
  if (!response.ok) {
    const latest = readSession(name, root);
    if (latest && latest.pending_request && latest.pending_request.request_id === requestIdValue) {
      delete latest.pending_request;
      latest.updated_at = nowTs();
      writeSession(latest, root);
    }
    return { ok: false, status: 'failed', error: response.error || 'socket injection failed' };
  }
  appendEvent('codex.request.injected', { session: name, request_id: requestIdValue, pane: session.pane || '', title }, root);
  return { ok: true, status: 'sent', session: name, pane: session.pane || '', socket_path: sock };
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

function parseMarker(input = {}, marker, fallbackTitle) {
  const prompt = String(input.prompt || '').trim();
  if (prompt !== marker && !prompt.startsWith(`${marker}\n`) && !prompt.startsWith(`${marker} `)) {
    return null;
  }
  const body = visibleMarkerBody(input, marker);
  return {
    title: titleFromText(body, fallbackTitle),
    body,
  };
}

function parseResponseMarker(input = {}) {
  return parseMarker(input, CLAUDE_RESPONSE_MARKER, 'Claude response');
}

function parseRequestMarker(input = {}) {
  const phase = parsePhaseMarker(input);
  if (phase && phase.lineage === 'codex') {
    return {
      title: titleFromText(phase.body, 'Codex phase request'),
      body: phase.body,
      phase: phase.phase,
      phase_marker: phase.marker,
      required_executor_agent: phase.required_agent,
      visible_marker: phase.marker,
    };
  }
  return parseMarker(input, CLAUDE_REQUEST_MARKER, 'Claude request');
}

function visibleMarkerBody(input = {}, marker) {
  const prompt = String(input.prompt || '').trim();
  if (prompt === marker) return '';
  if (!prompt.startsWith(marker)) return '';
  return canonicalPrompt(prompt.slice(marker.length).trimStart());
}

function isExplicitXmuxMarker(input = {}) {
  const prompt = String(input.prompt || '').trim();
  return prompt.startsWith(CLAUDE_RESPONSE_MARKER)
    || prompt.startsWith(CLAUDE_REQUEST_MARKER)
    || Boolean(parsePhaseMarker(input));
}

function updateClaudeRequest(id, updater, root = stateRoot()) {
  const file = claudeRequestPath(id, root);
  const current = readJson(file, null);
  if (!current) throw new Error(`request not found: ${id}`);
  const next = updater(current) || current;
  next.updated_at = nowTs();
  writeJson(file, next);
  return next;
}

const CLAUDE_REQUEST_EXIT_TERMINAL_STATUSES = new Set([
  'responded',
  'failed',
  'rejected',
  'timeout',
  'backend_unavailable',
  'transport_unavailable',
  'closed',
]);

function clearClaudeOutboundRequest(sessionName, requestId, root = stateRoot()) {
  if (!sessionName || !requestId) return;
  try {
    const { clearOutboundRequest } = require('../claude/cli');
    if (typeof clearOutboundRequest === 'function') clearOutboundRequest(sessionName, requestId, root);
  } catch (_) {
    // Claude-side cleanup is best effort; request state is still finalized below.
  }
}

function failClaudeRequestOnCodexExit(id, error, exitedAt, root = stateRoot()) {
  if (!id) return { updated: false, missing: true };
  const file = claudeRequestPath(id, root);
  const current = readJson(file, null);
  if (!current) return { updated: false, missing: true };
  clearClaudeOutboundRequest(current.session || '', current.request_id || id, root);
  if (CLAUDE_REQUEST_EXIT_TERMINAL_STATUSES.has(current.status)) {
    return { updated: false, status: current.status };
  }
  current.status = 'failed';
  current.error = error;
  current.failed_at = exitedAt;
  current.updated_at = nowTs();
  writeJson(file, current);
  return { updated: true, status: current.status };
}

function failSessionClaudeRequestsOnCodexExit(session = {}, error, exitedAt, root = stateRoot()) {
  const requestIds = new Set();
  if (session.active_request) requestIds.add(session.active_request);
  if (session.pending_request && session.pending_request.request_id) requestIds.add(session.pending_request.request_id);
  if (session.pending_response && session.pending_response.request_id) requestIds.add(session.pending_response.request_id);
  for (const requestId of requestIds) {
    failClaudeRequestOnCodexExit(requestId, error, exitedAt, root);
  }
}

function buildClaudeResponseContext(request, body) {
  return [
    'XMux response from Claude accepted.',
    `Request ID: ${request.request_id}`,
    `Request title: ${request.title || request.request_id}`,
    `Response title: ${request.response_title || 'Claude response'}`,
    '',
    'Rules:',
    '- The current user prompt is an XMux transport marker, not ordinary text typed by the user.',
    '- Treat the response body below as Claude Code output for the active XMux request.',
    '- Do not expose nonce values unless the user explicitly asks for XMux debugging.',
    '',
    '<xmux_claude_response>',
    canonicalPrompt(body),
    '</xmux_claude_response>',
  ].join('\n');
}

function writeHookContext(additionalContext, systemMessage = '') {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeHookBlock(reason, systemMessage = '') {
  const payload = {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function hookSession(root = stateRoot()) {
  const name = resolveTargetSessionName('', root);
  const session = readSession(name, root);
  return session && session.active !== false ? session : null;
}

function envHookSession(root = stateRoot()) {
  const envName = String(process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '').trim();
  if (!envName) return null;
  try {
    const session = readSession(safeComponent(envName, 'session'), root);
    return session && session.active !== false ? session : null;
  } catch (_) {
    return null;
  }
}

function uniquePendingSession(candidates) {
  return candidates.length === 1 ? candidates[0] : null;
}

function pendingSessions(field, root = stateRoot()) {
  return listSessions(root)
    .filter((session) => session && session.active !== false && session[field] && session[field].request_id);
}

function responsePendingMatches(session, parsed, root = stateRoot()) {
  const pending = session && session.pending_response;
  if (!pending || !pending.request_id) return false;
  if (pending.title && parsed.title && pending.title === parsed.title) return true;
  const request = readJson(claudeRequestPath(pending.request_id, root), null);
  return Boolean(request && request.response_title && parsed.title && request.response_title === parsed.title);
}

function requestPendingMatches(session, input, parsed, root = stateRoot()) {
  const pending = session && session.pending_request;
  if (!pending || !pending.request_id) return false;
  const visibleBody = visibleMarkerBody(input, parsed.visible_marker || CLAUDE_REQUEST_MARKER);
  if (visibleBody.trim() && pending.prompt_sha256 && pending.prompt_sha256 === sha256(visibleBody)) return true;
  if (pending.title && parsed.title && pending.title === parsed.title) return true;
  const request = readJson(claudeRequestPath(pending.request_id, root), null);
  return Boolean(request && request.title && parsed.title && request.title === parsed.title);
}

function resolvePendingResponseSession(parsed, root = stateRoot()) {
  const envSession = envHookSession(root);
  if (responsePendingMatches(envSession, parsed, root)) return envSession;
  const candidates = pendingSessions('pending_response', root);
  const matches = candidates.filter((session) => responsePendingMatches(session, parsed, root));
  const matched = uniquePendingSession(matches);
  if (matched) return matched;
  if (matches.length > 1) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

function resolvePendingRequestSession(input, parsed, root = stateRoot()) {
  const envSession = envHookSession(root);
  if (requestPendingMatches(envSession, input, parsed, root)) return envSession;
  const candidates = pendingSessions('pending_request', root);
  const matches = candidates.filter((session) => requestPendingMatches(session, input, parsed, root));
  const matched = uniquePendingSession(matches);
  if (matched) return matched;
  if (matches.length > 1) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

async function retrieveResponseBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  const result = await socketRequest(sock, {
    type: 'retrieve_response_body',
    request_id: request.request_id,
    response_nonce: request.response_nonce,
  }, Number(process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 5000));
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

async function retrieveRequestBody(session, request, root = stateRoot()) {
  const sock = session.socket_path || socketPath(session.name, root);
  const result = await socketRequest(sock, {
    type: 'retrieve_request_body',
    request_id: request.request_id,
    nonce: request.nonce,
  }, Number(process.env.XMUX_CODEX_SOCKET_TIMEOUT_MS || 5000));
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

async function acceptClaudeResponseMarker(input, root = stateRoot()) {
  const parsed = parseResponseMarker(input);
  if (!parsed) return { status: 'no_marker' };

  const session = resolvePendingResponseSession(parsed, root);
  const pending = session && session.pending_response ? session.pending_response : null;
  if (!session || !pending || !pending.request_id) {
    return { status: 'invalid', request_id: '', reason: 'pending_response_not_found' };
  }

  const request = readJson(claudeRequestPath(pending.request_id, root), null);
  if (!request) {
    return { status: 'invalid', request_id: pending.request_id, reason: 'request_not_found' };
  }

  const turnId = input.turn_id || input.turnId || '';
  if (request.codex_response_accepted_at) {
    if (turnId && request.codex_response_turn_id === turnId) {
      return { status: 'already_accepted', request };
    }
    return { status: 'invalid', request_id: request.request_id, reason: 'response_replay' };
  }

  const codexSession = session.name || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '';
  if (
    request.status !== 'responded'
    || request.response_nonce !== pending.response_nonce
    || !request.response_sha256
    || (request.codex_session && codexSession && request.codex_session !== codexSession)
  ) {
    return { status: 'invalid', request_id: request.request_id, reason: 'response_validation_failed' };
  }

  const retrieved = await retrieveResponseBody(session, request, root);
  if (!retrieved.ok) {
    return { status: 'invalid', request_id: request.request_id, reason: retrieved.error || 'response_body_unavailable' };
  }

  const accepted = updateClaudeRequest(request.request_id, (item) => {
    item.codex_response_accepted_at = nowTs();
    item.codex_response_turn_id = turnId;
    item.codex_response_marker_title = parsed.title;
    item.codex_response_accepted_by = codexSession || defaultSessionName();
    item.codex_response_body_bytes = retrieved.bytes || byteLength(retrieved.body);
    return item;
  }, root);
  await releaseResponseBody(session, request, root);
  delete session.pending_response;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('codex.hook.claude_response.accepted', {
    request_id: request.request_id,
    session: codexSession || defaultSessionName(),
    title: parsed.title,
  }, root);
  return { status: 'accepted', request: accepted, body: retrieved.body };
}

async function acceptClaudeRequestMarker(input, root = stateRoot()) {
  const parsed = parseRequestMarker(input);
  if (!parsed) return { status: 'no_marker' };

  const session = resolvePendingRequestSession(input, parsed, root);
  const pending = session && session.pending_request ? session.pending_request : null;
  if (!session || !pending || !pending.request_id) {
    return { status: 'invalid', request_id: '', reason: 'pending_request_not_found' };
  }

  const request = readJson(claudeRequestPath(pending.request_id, root), null);
  if (!request) {
    return { status: 'invalid', request_id: pending.request_id, reason: 'request_not_found' };
  }

  if (request.codex_request_accepted_at) {
    return { status: 'already_accepted', request };
  }

  const codexSession = session.name || process.env.XMUX_CODEX_SESSION_NAME || process.env.XMUX_TEAM || '';
  if (
    request.direction !== 'claude_to_codex'
    || !['sent', 'invoking'].includes(request.status)
    || request.nonce !== pending.nonce
    || request.prompt_sha256 !== pending.prompt_sha256
    || (request.codex_session && codexSession && request.codex_session !== codexSession)
  ) {
    return { status: 'invalid', request_id: request.request_id, reason: 'request_validation_failed' };
  }

  const retrieved = await retrieveRequestBody(session, request, root);
  if (!retrieved.ok) {
    return { status: 'invalid', request_id: request.request_id, reason: retrieved.error || 'request_body_unavailable' };
  }

  const visibleBody = visibleMarkerBody(input, CLAUDE_REQUEST_MARKER);
  if (!visibleBody.trim()) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_request_body_missing' };
  }
  if (sha256(visibleBody) !== request.prompt_sha256 || canonicalPrompt(visibleBody) !== canonicalPrompt(retrieved.body)) {
    return { status: 'invalid', request_id: request.request_id, reason: 'visible_request_body_mismatch' };
  }

  const accepted = updateClaudeRequest(request.request_id, (item) => {
    item.status = 'accepted';
    item.codex_request_accepted_at = nowTs();
    item.codex_request_marker_title = parsed.title;
    item.codex_request_accepted_by = codexSession || defaultSessionName();
    item.phase = item.phase || parsed.phase || '';
    item.phase_marker = item.phase_marker || parsed.phase_marker || '';
    item.required_executor_agent = item.required_executor_agent || parsed.required_executor_agent || '';
    item.prompt_body_bytes = retrieved.bytes || byteLength(retrieved.body);
    return item;
  }, root);
  await releaseRequestBody(session, request, root);
  delete session.pending_request;
  session.active_request = request.request_id;
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('codex.hook.claude_request.accepted', {
    request_id: request.request_id,
    session: codexSession || defaultSessionName(),
    title: parsed.title,
  }, root);
  const routeEvent = appendRouteEvent({
    request_id: request.request_id,
    from_lineage: 'claude',
    to_lineage: 'codex',
    prompt_hash: request.prompt_sha256,
    marker_valid: true,
    model_tier: request.model_tier || process.env.XMUX_CODEX_MODEL_TIER || 'codex',
    transport_event: 'codex.hook.claude_request.accepted',
    phase_marker: request.phase_marker || parsed.phase_marker || '',
    phase: request.phase || parsed.phase || '',
  }, root);
  const acceptedWithRouteEvent = updateClaudeRequest(request.request_id, (item) => {
    item.claude_to_codex_route_event_id = routeEvent.event_id;
    return item;
  }, root);
  return { status: 'accepted', request: acceptedWithRouteEvent, body: retrieved.body };
}

function hookCommandGlobal(subcommand) {
  const env = [
    `${HOOK_TAG_KEY}=${shellQuote(HOOK_TAG_VALUE)}`,
    `XMUX_INSTALL_DIR=${shellQuote(installRoot())}`,
  ].join(' ');
  return `${env} ${shellQuote(xmuxBinPath())} codex hook ${subcommand}`;
}

function hookSubcommandForEvent(eventName) {
  if (eventName === 'Stop') return 'stop';
  return 'user-prompt';
}

function isManagedHookCommand(command, eventName) {
  const text = String(command || '');
  const subcommand = hookSubcommandForEvent(eventName);
  if (text.includes(HOOK_TAG_KEY) && text.includes(HOOK_TAG_VALUE) && text.includes(` codex hook ${subcommand}`)) {
    return true;
  }
  const pattern = new RegExp(
    String.raw`(^|\s)(?:'[^']*/bin/xmux'|"[^"]*/bin/xmux"|[^\s]+/bin/xmux|xmux)\s+codex\s+hook\s+${subcommand}(\s|$)`
  );
  return pattern.test(text);
}

function ensureCodexHookList(settings, eventName, command, statusMessage) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const current = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  const filtered = current
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const hooks = Array.isArray(entry.hooks)
        ? entry.hooks.filter((hook) => !isManagedHookCommand((hook || {}).command || '', eventName))
        : entry.hooks;
      return { ...entry, hooks };
    })
    .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  filtered.push({
    hooks: [{
      type: 'command',
      command,
      statusMessage,
    }],
  });
  settings.hooks[eventName] = filtered;
  return { groupIndex: filtered.length - 1, handlerIndex: 0 };
}

function ensureCodexHooksFeature(configFile) {
  let text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const original = text;
  if (!text.trim()) {
    text = '[features]\nhooks = true\n';
  } else if (/(^|\n)\[features\]\s*(\n|$)/.test(text)) {
    const header = text.match(/(^|\n)\[features\]\s*(\n|$)/);
    const start = header.index + header[0].length;
    const nextSection = text.slice(start).search(/\n\[[^\]]+\]/);
    const end = nextSection >= 0 ? start + nextSection : text.length;
    let section = text.slice(start, end);
    section = section.replace(/^codex_hooks\s*=.*(?:\n|$)/m, '');
    if (/^hooks\s*=/m.test(section)) {
      section = section.replace(/^hooks\s*=\s*(?:true|false).*$/m, 'hooks = true');
    } else {
      section = `hooks = true\n${section}`;
    }
    text = `${text.slice(0, start)}${section}${text.slice(end)}`;
  } else {
    text = `${text.trimEnd()}\n\n[features]\nhooks = true\n`;
  }
  if (text !== original) writeTextAtomic(configFile, text);
}

function cmdEnsureHooks(opts) {
  const codexDir = codexHome(opts);
  ensureDir(codexDir);

  const configFile = path.join(codexDir, 'config.toml');
  ensureCodexHooksFeature(configFile);

  const hooksFile = path.join(codexDir, 'hooks.json');
  const hooksConfig = readJson(hooksFile, {});
  const userPromptCommand = hookCommandGlobal('user-prompt');
  const userPromptStatus = 'Checking XMux peer marker';
  const userPromptPosition = ensureCodexHookList(
    hooksConfig,
    'UserPromptSubmit',
    userPromptCommand,
    userPromptStatus
  );
  const stopCommand = hookCommandGlobal('stop');
  const stopStatus = 'Checking XMux Codex response delivery';
  const stopPosition = ensureCodexHookList(
    hooksConfig,
    'Stop',
    stopCommand,
    stopStatus
  );
  writeJson(hooksFile, hooksConfig);

  upsertCodexHookTrust(
    configFile,
    `${hooksFile}:${codexHookEventKeyLabel('UserPromptSubmit')}:${userPromptPosition.groupIndex}:${userPromptPosition.handlerIndex}`,
    codexHookTrustHash('UserPromptSubmit', { command: userPromptCommand, statusMessage: userPromptStatus })
  );
  upsertCodexHookTrust(
    configFile,
    `${hooksFile}:${codexHookEventKeyLabel('Stop')}:${stopPosition.groupIndex}:${stopPosition.handlerIndex}`,
    codexHookTrustHash('Stop', { command: stopCommand, statusMessage: stopStatus })
  );

  if (opts.quiet) return 0;
  const payload = { status: 'ok', hooks: hooksFile, config: configFile };
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`[xmux] installed Codex hooks in ${hooksFile}`);
  return 0;
}

async function cmdHookUserPrompt() {
  const input = readHookInput();
  const root = hookStateRoot(input);
  if (!root) return 0;
  const responseResult = await acceptClaudeResponseMarker(input, root);
  if (responseResult.status !== 'no_marker') {
    if (responseResult.status === 'already_accepted') return 0;
    if (responseResult.status !== 'accepted') {
      appendEvent('codex.hook.user_prompt.blocked', {
        request_id: responseResult.request_id || '',
        reason: responseResult.reason || 'response_validation_failed',
      }, root);
      if (isExplicitXmuxMarker(input)) {
        writeHookBlock('Invalid or stale XMux Claude response.', 'XMux blocked an invalid Claude response marker.');
      }
      return 0;
    }
    const title = sanitizeTitle(responseResult.request.response_title || 'Claude response', 'Claude response');
    appendEvent('codex.hook.claude_response.pass_through', {
      request_id: responseResult.request.request_id,
      session: responseResult.request.codex_response_accepted_by || defaultSessionName(),
      title,
    }, root);
    return 0;
  }

  const requestResult = await acceptClaudeRequestMarker(input, root);
  if (requestResult.status === 'no_marker' || requestResult.status === 'already_accepted') return 0;
  if (requestResult.status !== 'accepted') {
    appendEvent('codex.hook.user_prompt.blocked', {
      request_id: requestResult.request_id || '',
      reason: requestResult.reason || 'request_validation_failed',
    }, root);
    if (isExplicitXmuxMarker(input)) {
      writeHookBlock('Invalid or stale XMux Claude request.', 'XMux blocked an invalid Claude request marker.');
    }
    return 0;
  }
  const requestTitle = sanitizeTitle(requestResult.request.title || 'Claude request', 'Claude request');
  appendEvent('codex.hook.claude_request.pass_through', {
    request_id: requestResult.request.request_id,
    session: requestResult.request.codex_request_accepted_by || defaultSessionName(),
    title: requestTitle,
  }, root);
  return 0;
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

function markCodexResponded(request, text, source, root = stateRoot()) {
  const responseText = canonicalPrompt(text);
  const next = updateClaudeRequest(request.request_id, (item) => {
    item.status = 'responded';
    item.responded_at = nowTs();
    item.response_source = source;
    item.response_sha256 = sha256(responseText);
    item.response_body_bytes = byteLength(responseText);
    item.response_nonce = item.response_nonce || responseNonce();
    item.response_title = titleFromText(responseText, 'Codex response');
    return item;
  }, root);
  const sessionName = request.codex_request_accepted_by || request.codex_session || defaultSessionName();
  const session = readSession(sessionName, root);
  if (session && session.active_request === request.request_id) {
    delete session.active_request;
    session.updated_at = nowTs();
    writeSession(session, root);
  }
  appendEvent('codex.response.written', { request_id: request.request_id, session: sessionName, source }, root);
  return next;
}

async function deliverResponseToClaude(request, responseText, root = stateRoot()) {
  let sendCodexResponseToSession;
  let clearOutboundRequest;
  try {
    ({ sendCodexResponseToSession, clearOutboundRequest } = require('../claude/cli'));
  } catch (error) {
    appendEvent('codex.response.claude_delivery_failed', {
      request_id: request.request_id,
      session: request.session || '',
      error: error && error.message ? error.message : String(error),
    }, root);
    return { ok: false, error: 'Claude harness unavailable' };
  }
  const prompt = `${CODEX_RESPONSE_MARKER}\n\n${canonicalPrompt(responseText)}`;
  const result = await sendCodexResponseToSession({
    root,
    name: request.session,
    request,
    body: responseText,
    prompt,
    enter: true,
    bracketedPaste: true,
    clear: true,
    timeoutMs: Number(process.env.XMUX_CLAUDE_SOCKET_TIMEOUT_MS || 30000),
  });
  updateClaudeRequest(request.request_id, (item) => {
    item.claude_delivery = result.ok ? 'sent' : 'failed';
    item.claude_delivery_at = nowTs();
    item.claude_delivery_error = result.ok ? '' : (result.error || 'Claude delivery failed');
    return item;
  }, root);
  appendEvent(result.ok ? 'codex.response.claude_delivered' : 'codex.response.claude_delivery_failed', {
    request_id: request.request_id,
    session: request.session || '',
    marker: `${CODEX_RESPONSE_MARKER}\n\n${sanitizeTitle(request.response_title || 'Codex response', 'Codex response')}`,
    error: result.ok ? '' : (result.error || 'Claude delivery failed'),
  }, root);
  if (!result.ok && typeof clearOutboundRequest === 'function') {
    clearOutboundRequest(request.session, request.request_id, root);
  }
  return result;
}

async function cmdHookStop() {
  const input = readHookInput();
  const root = hookStateRoot(input);
  if (!root) return 0;
  const session = hookSession(root);
  if (!session || !session.active_request) return 0;
  const request = readJson(claudeRequestPath(session.active_request, root), null);
  if (!request || request.status === 'responded') return 0;
  if (request.direction !== 'claude_to_codex' || request.status !== 'accepted') {
    appendEvent('codex.hook.stop.noop', {
      request_id: session.active_request,
      reason: 'request_not_accepted_by_xmux_claude_request',
      status: request.status || '',
      direction: request.direction || '',
    }, root);
    return 0;
  }
  const text = input.last_assistant_message
    || input.lastAssistantMessage
    || lastAssistantFromTranscript(input.transcript_path || input.transcriptPath || '');
  if (!text) {
    appendEvent('codex.hook.stop.noop', { request_id: session.active_request, reason: 'empty_last_assistant_message' }, root);
    return 0;
  }
  const next = markCodexResponded(request, text, 'codex-stop-hook', root);
  await deliverResponseToClaude(next, canonicalPrompt(text), root);
  return 0;
}

function cmdSessions(opts) {
  const sessions = listSessions();
  if (opts.json) {
    console.log(JSON.stringify({ status: 'ok', sessions }, null, 2));
  } else if (sessions.length === 0) {
    console.log('no Codex sessions registered');
  } else {
    for (const session of sessions) {
      console.log(`${session.name}\t${session.active === false ? 'inactive' : 'active'}\t${session.pane || '-'}\t${session.socket_path || '-'}`);
    }
  }
  return 0;
}

async function cmdSend(opts) {
  const controlKey = opts.key ? keySequence(opts.key) : '';
  const prompt = controlKey || canonicalPrompt(readPrompt(opts));
  if (!controlKey && !prompt.trim()) throw new Error('prompt must not be empty');
  const response = await sendPromptToSession({
    name: opts.to || opts.name || defaultSessionName(),
    prompt,
    enter: !opts['no-enter'],
    bracketedPaste: !opts['no-bracketed-paste'],
    clear: Boolean(opts.clear),
    force: Boolean(opts.force),
    origin: opts.origin || process.env.XMUX_CODEX_SEND_ORIGIN || 'codex-send',
    allowControl: Boolean(controlKey),
    timeoutMs: opts['socket-timeout'] || 30000,
  });
  if (opts.json) console.log(JSON.stringify(response, null, 2));
  else if (!response.ok) console.error(`xmux codex send: ${response.error}`);
  else if (!opts.quiet) console.log(JSON.stringify({ status: response.status, session: response.session, pane: response.pane || '' }));
  return response.ok ? 0 : 1;
}

function cmdStatus(opts) {
  const name = opts.to || opts.name;
  if (name) {
    const session = readSession(name);
    if (!session) throw new Error(`session not found: ${name}`);
    console.log(JSON.stringify({ status: 'ok', session }, null, 2));
    return 0;
  }
  return cmdSessions({ ...opts, json: true });
}

function cmdStop(opts) {
  const name = safeComponent(opts.name || opts.to || defaultSessionName(), 'session');
  const session = readSession(name);
  if (!session) throw new Error(`session not found: ${name}`);
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
  const stoppedAt = nowTs();
  failSessionClaudeRequestsOnCodexExit(session, 'Codex session stopped before response', stoppedAt);
  clearSessionVolatileState(session);
  session.active = false;
  session.updated_at = stoppedAt;
  const written = writeSession(session);
  appendEvent('codex.session.stopped', { session: name });
  console.log(JSON.stringify({ status: 'ok', session: written }, null, 2));
  return 0;
}

function cmdPaneRun(opts) {
  const name = safeComponent(opts.name || opts.to || defaultSessionName(), 'session');
  const root = stateRoot();
  cmdEnsureHooks({ quiet: true });
  const script = path.join(installRoot(), 'runtime', 'codex', 'pane-run.py');
  if (!fs.existsSync(script)) throw new Error(`missing Codex pane runner: ${script}`);
  const sock = opts.socket ? path.resolve(expandUser(opts.socket)) : socketPath(name, root);
  const session = readSession(name, root) || {
    schema: SCHEMA_SESSION,
    name,
    created_at: nowTs(),
  };
  clearPaneRunExitMarkers(session);
  clearSessionVolatileState(session);
  session.active = true;
  session.pane = process.env.TMUX_PANE || session.pane || '';
  session.socket_path = sock;
  session.project_dir = projectDir();
  session.updated_at = nowTs();
  writeSession(session, root);
  appendEvent('codex.session.started', { session: name, pane: session.pane, socket_path: sock }, root);

  const args = [
    script,
    '--name', name,
    '--project-dir', projectDir(),
    '--state-dir', root,
    '--socket', sock,
  ];
  if (opts['codex-cmd']) args.push('--codex-cmd', opts['codex-cmd']);
  if (opts._.length) args.push('--', ...opts._);
  const result = spawnSync('python3', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      XMUX_CODEX_SESSION_NAME: name,
      XMUX_CODEX_SOCKET: sock,
      XMUX_PROJECT_DIR: projectDir(),
      XMUX_STATE_DIR: root,
      XMUX_INSTALL_DIR: installRoot(),
    },
  });
  const latest = readSession(name, root) || session;
  const exitedAt = nowTs();
  failSessionClaudeRequestsOnCodexExit(latest, 'Codex session exited before response', exitedAt, root);
  clearSessionVolatileState(latest);
  latest.active = false;
  latest.exited_at = exitedAt;
  latest.exit_code = result.status || 0;
  latest.updated_at = exitedAt;
  writeSession(latest, root);
  appendEvent('codex.session.exited', { session: name, exit_code: latest.exit_code }, root);
  if (result.error) throw new Error(`failed to start pane runner: ${result.error.message}`);
  return result.status || 0;
}

function usage() {
  console.error(`Usage:
  xmux codex sessions [--json]
  xmux codex ensure-hooks [--json]
  xmux codex status [--to <name>]
  xmux codex send [--to <name>] [--prompt <text>|--stdin] [--clear] [--no-enter] [--force] [--json]
  xmux codex stop --name <name>
  xmux codex pane-run --name <name> [-- <codex args...>]
  xmux codex hook user-prompt|stop`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || '';
  const opts = parseArgs(argv.slice(1));
  try {
    switch (command) {
      case 'sessions':
        return cmdSessions(opts);
      case 'ensure-hooks':
      case 'install-hooks':
        return cmdEnsureHooks(opts);
      case 'status':
        return cmdStatus(opts);
      case 'send':
        return await cmdSend(opts);
      case 'stop':
        return cmdStop(opts);
      case 'pane-run':
        return cmdPaneRun(opts);
      case 'hook':
        if (opts._[0] === 'user-prompt') return await cmdHookUserPrompt();
        if (opts._[0] === 'stop') return await cmdHookStop();
        throw new Error('hook requires user-prompt or stop');
      case '-h':
      case '--help':
      case 'help':
      case '':
        usage();
        return command ? 0 : 2;
      default:
        throw new Error(`unknown xmux codex command: ${command}`);
    }
  } catch (error) {
    console.error(`xmux codex: ${error && error.message ? error.message : String(error)}`);
    return 1;
  }
}

module.exports = {
  main,
  sendPromptToSession,
  sendResponseToSession,
  sendRequestToSession,
  socketPath,
  clearPaneRunExitMarkers,
  clearSessionVolatileState,
  parseResponseMarker,
  resolvePendingResponseSession,
  resolvePendingRequestSession,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`xmux codex: ${error && error.message ? error.message : String(error)}`);
      process.exit(1);
    });
}
