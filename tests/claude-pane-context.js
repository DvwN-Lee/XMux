#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readUnifiedSession, writeUnifiedSession } = require("../src/xmux/session-state");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-claude-context-"));
const fakeBin = path.join(tempRoot, "bin");
fs.mkdirSync(fakeBin, { recursive: true });

const fakeTmux = `#!/usr/bin/env node
"use strict";

const args = process.argv.slice(2);
if (args[0] === "show-option") {
  process.exit(1);
}
if (args[0] === "set-option" || args[0] === "select-pane") {
  process.exit(0);
}
if (args[0] === "display-message" && args[1] === "-pt") {
  const pane = args[2];
  const format = args.slice(3).join(" ");
  const alive = pane === "%404" || pane === "%405";
  if (format.includes("#{pane_dead}")) {
    console.log(alive ? "0" : "1");
    process.exit(0);
  }
  if (format.includes("#{session_id}") && format.includes("#{window_id}")) {
    if (!alive) process.exit(1);
    console.log("$1\\t@1");
    process.exit(0);
  }
}
console.error("unexpected tmux invocation: " + args.join(" "));
process.exit(1);
`;

const fakeTmuxPath = path.join(fakeBin, "tmux");
fs.writeFileSync(fakeTmuxPath, fakeTmux, "utf8");
fs.chmodSync(fakeTmuxPath, 0o755);

process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.XMUX_STATE_DIR = tempRoot;
delete process.env.TMUX_PANE;

writeUnifiedSession("codex", {
  schema: "xmux.codex.session.v1",
  name: "dev",
  active: true,
  pane: "%404",
  socket_path: "/tmp/xmux-codex-test-dev.sock",
}, tempRoot);

const {
  decorateSessionRuntime,
  finalizePaneRunSessionExit,
  resolveCodexPaneContext,
} = require("../src/claude/cli");

const claudeRequestsDir = path.join(tempRoot, "claude", "requests");
fs.mkdirSync(claudeRequestsDir, { recursive: true });

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

process.env.XMUX_CODEX_SESSION_NAME = "dev";
assert.deepEqual(resolveCodexPaneContext(tempRoot), {
  sessionName: "dev",
  pane: "%404",
  referencePane: "%404",
  referencePaneSource: "codex-session-state",
});

process.env.XMUX_CODEX_SESSION_NAME = "inv";
assert.deepEqual(resolveCodexPaneContext(tempRoot), {
  sessionName: "dev",
  pane: "%404",
  referencePane: "%404",
  referencePaneSource: "codex-session-state",
});

process.env.TMUX_PANE = "%404";
assert.deepEqual(resolveCodexPaneContext(tempRoot), {
  sessionName: "dev",
  pane: "%404",
  referencePane: "%404",
});

delete process.env.XMUX_CODEX_SESSION_NAME;
delete process.env.TMUX_PANE;
assert.deepEqual(resolveCodexPaneContext(tempRoot), {
  sessionName: "dev",
  pane: "%404",
  referencePane: "%404",
  referencePaneSource: "codex-session-state",
});

writeUnifiedSession("codex", {
  schema: "xmux.codex.session.v1",
  name: "other",
  active: true,
  pane: "%405",
}, tempRoot);
assert.equal(resolveCodexPaneContext(tempRoot).reason, "ambiguous_codex_session_without_tmux_context");

const stale = decorateSessionRuntime({
  schema: "xmux.claude.session.v1",
  name: "dev",
  active: true,
  transport_backend: "pane",
  pane: "%401",
  socket_path: path.join(tempRoot, "missing.sock"),
});
assert.equal(stale.active, false);
assert.equal(stale.recorded_active, true);
assert.equal(stale.runtime_status, "stale");
assert.deepEqual(stale.stale_reasons.sort(), ["pane_not_alive", "socket_missing"]);

const inactive = decorateSessionRuntime({
  schema: "xmux.claude.session.v1",
  name: "stopped",
  active: false,
  transport_backend: "pane",
});
assert.equal(inactive.active, false);
assert.equal(inactive.runtime_status, "inactive");

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "cleanup",
  active: true,
  active_request: "req-exit",
  transport_backend: "pane",
  pane_launch_id: "launch-cleanup",
  pane: "%401",
  socket_path: path.join(tempRoot, "cleanup.sock"),
}, tempRoot);
writeJson(path.join(claudeRequestsDir, "req-exit.json"), {
  schema: "xmux.claude.request.v2",
  request_id: "req-exit",
  session: "cleanup",
  status: "sent",
});
const cleaned = finalizePaneRunSessionExit("cleanup", tempRoot, { status: 0 }, { launch: "launch-cleanup" });
assert.equal(cleaned.active, false);
assert.equal(cleaned.exit_code, 0);
assert.equal(cleaned.active_request, undefined);
assert.equal(Boolean(cleaned.socket_removed_at), true);
assert.equal(Boolean(cleaned.pane_exited_at), true);
const failedRequest = readJson(path.join(claudeRequestsDir, "req-exit.json"));
assert.equal(failedRequest.status, "failed");
assert.equal(failedRequest.error, "session exited before response");

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "responded",
  active: true,
  active_request: "req-responded",
  transport_backend: "pane",
  pane_launch_id: "launch-responded",
  pane: "%401",
  socket_path: path.join(tempRoot, "responded.sock"),
}, tempRoot);
writeJson(path.join(claudeRequestsDir, "req-responded.json"), {
  schema: "xmux.claude.request.v2",
  request_id: "req-responded",
  session: "responded",
  status: "responded",
  responded_at: "2026-05-21T00:00:00.000Z",
});
finalizePaneRunSessionExit("responded", tempRoot, { status: 0 }, { launch: "launch-responded" });
const respondedRequest = readJson(path.join(claudeRequestsDir, "req-responded.json"));
assert.equal(respondedRequest.status, "responded");
assert.equal(respondedRequest.failed_at, undefined);

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "signaled",
  active: true,
  active_outbound_request: "req-outbound",
  pending_response: { request_id: "req-outbound" },
  transport_backend: "pane",
  pane_launch_id: "launch-signaled",
  pane: "%401",
  socket_path: path.join(tempRoot, "signaled.sock"),
}, tempRoot);
writeJson(path.join(claudeRequestsDir, "req-outbound.json"), {
  schema: "xmux.claude.request.v2",
  request_id: "req-outbound",
  session: "signaled",
  status: "invoking",
});
const signaled = finalizePaneRunSessionExit("signaled", tempRoot, { status: null, signal: "SIGTERM" }, { launch: "launch-signaled" });
assert.equal(signaled.active, false);
assert.equal(signaled.exit_signal, "SIGTERM");
assert.equal(signaled.exit_code, undefined);
assert.equal(signaled.active_outbound_request, undefined);
assert.equal(signaled.pending_response, undefined);
assert.equal(readJson(path.join(claudeRequestsDir, "req-outbound.json")).status, "failed");

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "idle",
  active: true,
  transport_backend: "pane",
  pane_launch_id: "launch-idle",
  pane: "%401",
  socket_path: path.join(tempRoot, "idle.sock"),
}, tempRoot);
const idle = finalizePaneRunSessionExit("idle", tempRoot, { status: 0 }, { launch: "launch-idle" });
assert.equal(idle.active, false);
assert.equal(idle.exit_code, 0);
assert.equal(Boolean(idle.exited_at), true);
assert.equal(idle.active_request, undefined);
assert.equal(idle.active_outbound_request, undefined);
assert.equal(idle.pending_response, undefined);

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "missing-request",
  active: true,
  active_request: "req-missing",
  transport_backend: "pane",
  pane_launch_id: "launch-missing",
  pane: "%401",
  socket_path: path.join(tempRoot, "missing-request.sock"),
}, tempRoot);
const missingRequest = finalizePaneRunSessionExit("missing-request", tempRoot, { status: 0 }, { launch: "launch-missing" });
assert.equal(missingRequest.active, false);
assert.equal(missingRequest.active_request, undefined);

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "mismatch",
  active: true,
  active_request: "req-mismatch",
  transport_backend: "pane",
  pane_launch_id: "launch-current",
  pane: "%404",
  socket_path: path.join(tempRoot, "mismatch.sock"),
}, tempRoot);
writeJson(path.join(claudeRequestsDir, "req-mismatch.json"), {
  schema: "xmux.claude.request.v2",
  request_id: "req-mismatch",
  session: "mismatch",
  status: "prepared",
});
const ignored = finalizePaneRunSessionExit("mismatch", tempRoot, { status: 0 }, { launch: "launch-old" });
assert.equal(ignored.exit_ignored, true);
assert.equal(readUnifiedSession("claude", "mismatch", tempRoot).active, true);
assert.equal(readJson(path.join(claudeRequestsDir, "req-mismatch.json")).status, "prepared");

writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "ready-clears",
  active: false,
  transport_backend: "pane",
  exited_at: "2026-05-21T00:00:00.000Z",
  exit_code: 0,
  exit_signal: "SIGTERM",
  socket_removed_at: "2026-05-21T00:00:00.000Z",
  pane_killed_at: "2026-05-21T00:00:00.000Z",
  pane_exited_at: "2026-05-21T00:00:00.000Z",
}, tempRoot);
const hookResult = spawnSync(process.execPath, [
  path.join(__dirname, "..", "src", "claude", "cli.js"),
  "hook",
  "session-start",
], {
  encoding: "utf8",
  input: JSON.stringify({ source: "startup", session_id: "claude-test-session" }),
  env: {
    ...process.env,
    XMUX_STATE_DIR: tempRoot,
    XMUX_CLAUDE_SESSION_NAME: "ready-clears",
    XMUX_CLAUDE_LAUNCH_ID: "launch-ready",
  },
});
assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
const readyClears = readUnifiedSession("claude", "ready-clears", tempRoot);
assert.equal(readyClears.active, true);
assert.equal(readyClears.pane_launch_id, "launch-ready");
assert.equal(readyClears.exited_at, undefined);
assert.equal(readyClears.exit_code, undefined);
assert.equal(readyClears.exit_signal, undefined);
assert.equal(readyClears.socket_removed_at, undefined);
assert.equal(readyClears.pane_killed_at, undefined);
assert.equal(readyClears.pane_exited_at, undefined);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("claude pane context tests passed");
