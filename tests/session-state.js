#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { clearPaneRunExitMarkers } = require("../src/codex/cli");
const {
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  legacySessionsDir,
  listUnifiedSessions,
  migrateLegacySessions,
  readUnifiedSession,
  unifiedSessionFromLegacy,
  unifiedSessionId,
  unifiedSessionPath,
  writeLegacySessionMirror,
  writeUnifiedSession,
} = require("../src/xmux/session-state");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-session-state-"));

const codexSession = {
  schema: "xmux.codex.session.v1",
  name: "default",
  active: true,
  transport_backend: "pane",
  pane: "%101",
  socket_path: "/tmp/xmux-codex-test.sock",
  active_request: "legacy-request-id",
  created_at: "2026-05-21T00:00:00.000Z",
  updated_at: "2026-05-21T00:01:00.000Z",
};
const claudeSession = {
  schema: "xmux.claude.session.v1",
  name: "default",
  active: false,
  transport_backend: "pane",
  pane: "%102",
  socket_path: "/tmp/xmux-claude-test.sock",
  pane_launch_id: "launch-test",
  pane_ready_at: "2026-05-21T00:01:30.000Z",
  active_outbound_request: "legacy-outbound-id",
  claude_session_id: "provider-session-id",
  created_at: "2026-05-21T00:00:05.000Z",
  updated_at: "2026-05-21T00:02:00.000Z",
};

assert.equal(unifiedSessionId("codex", "default"), "codex--default");
assert.equal(
  unifiedSessionPath("claude", "default", tempRoot),
  path.join(tempRoot, "sessions", "claude--default.json"),
);

const codexDoc = writeUnifiedSession("codex", codexSession, tempRoot);
const claudeDoc = writeUnifiedSession("claude", claudeSession, tempRoot);

assert.equal(codexDoc.schema, SESSION_SCHEMA);
assert.equal(codexDoc.schema_version, SESSION_SCHEMA_VERSION);
assert.equal(codexDoc.session_id, "codex--default");
assert.equal(codexDoc.role, "codex");
assert.equal(codexDoc.status, "active");
assert.equal(codexDoc.transport.pane, "%101");
assert.equal(codexDoc.transport.socket_path, "/tmp/xmux-codex-test.sock");
assert.equal(codexDoc.active_request, "legacy-request-id");
assert.equal(codexDoc.active_exchange_id, undefined);

assert.equal(claudeDoc.session_id, "claude--default");
assert.equal(claudeDoc.role, "claude");
assert.equal(claudeDoc.status, "terminated");
assert.equal(claudeDoc.terminated_at, "2026-05-21T00:02:00.000Z");
assert.equal(claudeDoc.transport.launch_id, "launch-test");
assert.equal(claudeDoc.transport.ready_at, "2026-05-21T00:01:30.000Z");
assert.equal(claudeDoc.provider_session_id, "provider-session-id");
assert.equal(claudeDoc.active_outbound_request, "legacy-outbound-id");
assert.equal(claudeDoc.active_exchange_id, undefined);

const resumed = unifiedSessionFromLegacy("codex", {
  schema: "xmux.codex.session.v1",
  name: "resumed",
  active: true,
  status: "terminated",
  terminated_at: "2026-05-21T00:03:00.000Z",
  updated_at: "2026-05-21T00:04:00.000Z",
});
assert.equal(resumed.status, "active");
assert.equal(resumed.terminated_at, null);

const draining = unifiedSessionFromLegacy("codex", {
  schema: "xmux.codex.session.v1",
  name: "draining",
  active: true,
  status: "draining",
  updated_at: "2026-05-21T00:05:00.000Z",
});
assert.equal(draining.status, "draining");

const inactiveOverride = unifiedSessionFromLegacy("codex", {
  schema: "xmux.codex.session.v1",
  name: "inactive",
  active: false,
  status: "active",
  updated_at: "2026-05-21T00:06:00.000Z",
});
assert.equal(inactiveOverride.status, "terminated");
assert.equal(inactiveOverride.terminated_at, "2026-05-21T00:06:00.000Z");

const staleExitMarkers = {
  name: "dev",
  active: false,
  status: "terminated",
  terminated_at: "2026-05-21T00:07:00.000Z",
  exited_at: "2026-05-21T00:07:05.000Z",
  exit_code: 3,
  exit_signal: "SIGTERM",
  socket_removed_at: "2026-05-21T00:07:10.000Z",
  pane_killed_at: "2026-05-21T00:07:15.000Z",
  pane_exited_at: "2026-05-21T00:07:20.000Z",
  pane: "%101",
};
clearPaneRunExitMarkers(staleExitMarkers);
assert.equal(staleExitMarkers.status, undefined);
assert.equal(staleExitMarkers.terminated_at, undefined);
assert.equal(staleExitMarkers.exited_at, undefined);
assert.equal(staleExitMarkers.exit_code, undefined);
assert.equal(staleExitMarkers.exit_signal, undefined);
assert.equal(staleExitMarkers.socket_removed_at, undefined);
assert.equal(staleExitMarkers.pane_killed_at, undefined);
assert.equal(staleExitMarkers.pane_exited_at, undefined);
assert.equal(staleExitMarkers.pane, "%101");

assert.deepEqual(readUnifiedSession("codex", "default", tempRoot), codexDoc);
assert.deepEqual(listUnifiedSessions(tempRoot).map((item) => item.session_id), [
  "claude--default",
  "codex--default",
]);

fs.writeFileSync(
  unifiedSessionPath("codex", "raw-stale", tempRoot),
  `${JSON.stringify({
    schema: SESSION_SCHEMA,
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: "codex--raw-stale",
    role: "codex",
    name: "raw-stale",
    active: true,
    status: "terminated",
    terminated_at: "2026-05-21T00:08:00.000Z",
    exited_at: "2026-05-21T00:08:05.000Z",
    exit_code: 0,
    updated_at: "2026-05-21T00:09:00.000Z",
  })}\n`,
  "utf8",
);
const normalizedStale = readUnifiedSession("codex", "raw-stale", tempRoot);
assert.equal(normalizedStale.status, "active");
assert.equal(normalizedStale.terminated_at, null);
assert.equal(normalizedStale.exited_at, undefined);
assert.equal(normalizedStale.exit_code, undefined);
assert.equal(
  listUnifiedSessions(tempRoot).find((item) => item.session_id === "codex--raw-stale").status,
  "active",
);

assert.throws(
  () => unifiedSessionFromLegacy("worker", codexSession),
  /session role must be one of/,
);

const migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-session-migration-"));
const legacyCodexDir = legacySessionsDir("codex", migrationRoot);
const legacyClaudeDir = legacySessionsDir("claude", migrationRoot);
fs.mkdirSync(legacyCodexDir, { recursive: true });
fs.mkdirSync(legacyClaudeDir, { recursive: true });
fs.writeFileSync(
  path.join(legacyCodexDir, "dev.json"),
  `${JSON.stringify({
    schema: "xmux.codex.session.v1",
    name: "dev",
    active: true,
    pane: "%303",
    updated_at: "2026-05-21T00:01:00.000Z",
  })}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(legacyClaudeDir, "dev.json"),
  `${JSON.stringify({
    schema: "xmux.claude.session.v1",
    name: "dev",
    active: true,
    pane: "%304",
    updated_at: "2026-05-21T00:01:00.000Z",
  })}\n`,
  "utf8",
);

const migration = migrateLegacySessions(migrationRoot);
assert.deepEqual(migration.migrated.map((item) => `${item.role}:${item.name}`).sort(), [
  "claude:dev",
  "codex:dev",
]);
assert.equal(readUnifiedSession("codex", "dev", migrationRoot).pane, "%303");
assert.equal(readUnifiedSession("claude", "dev", migrationRoot).pane, "%304");

writeUnifiedSession("codex", {
  schema: "xmux.codex.session.v1",
  name: "dev",
  active: true,
  pane: "%999",
  updated_at: "2026-05-21T00:02:00.000Z",
}, migrationRoot);
const cleanupMigration = migrateLegacySessions(migrationRoot, { removeLegacy: true });
assert.equal(cleanupMigration.skipped.some((item) => item.role === "codex" && item.name === "dev"), true);
assert.equal(cleanupMigration.removed.includes(legacyCodexDir), true);
assert.equal(cleanupMigration.removed.includes(legacyClaudeDir), true);
assert.equal(fs.existsSync(legacyCodexDir), false);
assert.equal(fs.existsSync(legacyClaudeDir), false);
assert.equal(readUnifiedSession("codex", "dev", migrationRoot).pane, "%999");

const partialCleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-session-partial-cleanup-"));
const partialLegacyCodexDir = legacySessionsDir("codex", partialCleanupRoot);
fs.mkdirSync(partialLegacyCodexDir, { recursive: true });
fs.writeFileSync(
  path.join(partialLegacyCodexDir, "ok.json"),
  `${JSON.stringify({
    schema: "xmux.codex.session.v1",
    name: "ok",
    active: true,
    pane: "%305",
    updated_at: "2026-05-21T00:01:00.000Z",
  })}\n`,
  "utf8",
);
fs.writeFileSync(path.join(partialLegacyCodexDir, "unreadable.json"), "{bad json\n", "utf8");
fs.writeFileSync(
  path.join(partialLegacyCodexDir, "invalid.json"),
  `${JSON.stringify({
    schema: "xmux.codex.session.v1",
    name: "../invalid",
    active: true,
    updated_at: "2026-05-21T00:01:00.000Z",
  })}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(partialLegacyCodexDir, "stale.json"),
  `${JSON.stringify({
    schema: "xmux.codex.session.v1",
    name: "stale",
    active: true,
    pane: "%401",
    updated_at: "2026-05-21T00:01:00.000Z",
  })}\n`,
  "utf8",
);
writeUnifiedSession("codex", {
  schema: "xmux.codex.session.v1",
  name: "stale",
  active: true,
  pane: "%999",
  updated_at: "2026-05-21T00:02:00.000Z",
}, partialCleanupRoot);
const partialCleanupMigration = migrateLegacySessions(partialCleanupRoot, { removeLegacy: true });
assert.equal(partialCleanupMigration.migrated.some((item) => item.role === "codex" && item.name === "ok"), true);
assert.equal(partialCleanupMigration.skipped.some((item) => item.role === "codex" && item.name === "stale"), true);
assert.equal(partialCleanupMigration.removed.includes(path.join(partialLegacyCodexDir, "ok.json")), true);
assert.equal(partialCleanupMigration.removed.includes(path.join(partialLegacyCodexDir, "stale.json")), true);
assert.equal(partialCleanupMigration.removed.includes(path.join(partialLegacyCodexDir, "unreadable.json")), false);
assert.equal(partialCleanupMigration.removed.includes(path.join(partialLegacyCodexDir, "invalid.json")), false);
assert.equal(partialCleanupMigration.removed.includes(partialLegacyCodexDir), false);
assert.equal(
  partialCleanupMigration.warnings.some((item) => item.includes("unreadable.json") && item.includes("unreadable")),
  true,
);
assert.equal(
  partialCleanupMigration.warnings.some((item) => item.includes("invalid.json") && item.includes("cannot be migrated")),
  true,
);
assert.equal(fs.existsSync(path.join(partialLegacyCodexDir, "ok.json")), false);
assert.equal(fs.existsSync(path.join(partialLegacyCodexDir, "stale.json")), false);
assert.equal(fs.existsSync(path.join(partialLegacyCodexDir, "unreadable.json")), true);
assert.equal(fs.existsSync(path.join(partialLegacyCodexDir, "invalid.json")), true);
assert.equal(fs.existsSync(partialLegacyCodexDir), true);
assert.equal(readUnifiedSession("codex", "ok", partialCleanupRoot).pane, "%305");
assert.equal(readUnifiedSession("codex", "stale", partialCleanupRoot).pane, "%999");

const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-session-mirror-"));
const mirrorLegacyCodexDir = legacySessionsDir("codex", mirrorRoot);
fs.mkdirSync(mirrorLegacyCodexDir, { recursive: true });
fs.writeFileSync(
  path.join(mirrorLegacyCodexDir, "test.json"),
  `${JSON.stringify({ schema: "xmux.codex.session.v1", name: "test", active: true })}\n`,
  "utf8",
);
assert.equal(
  writeLegacySessionMirror("codex", {
    name: "test",
    active: true,
    role: "codex",
    session_id: "codex--test",
    pending_response: { request_id: "req-mirror" },
  }, mirrorRoot),
  path.join(mirrorLegacyCodexDir, "test.json"),
);
const mirrored = JSON.parse(fs.readFileSync(path.join(mirrorLegacyCodexDir, "test.json"), "utf8"));
assert.equal(mirrored.schema, "xmux.codex.session.v1");
assert.equal(mirrored.pending_response.request_id, "req-mirror");
assert.equal(mirrored.session_id, undefined);
assert.equal(mirrored.role, undefined);
assert.equal(
  writeLegacySessionMirror("codex", { name: "new", active: true }, mirrorRoot),
  null,
  "legacy mirrors are not created for new unified-only sessions",
);

const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-session-cli-"));
writeUnifiedSession("codex", {
  schema: "xmux.codex.session.v1",
  name: "dev",
  active: true,
  transport_backend: "pane",
  created_at: "2026-05-21T00:00:00.000Z",
  updated_at: "2026-05-21T00:01:00.000Z",
}, cliRoot);
writeUnifiedSession("claude", {
  schema: "xmux.claude.session.v1",
  name: "dev",
  active: true,
  transport_backend: "pane",
  created_at: "2026-05-21T00:00:00.000Z",
  updated_at: "2026-05-21T00:01:00.000Z",
}, cliRoot);

const codexStop = spawnSync(process.execPath, [
  path.join(__dirname, "..", "src", "codex", "cli.js"),
  "stop",
  "--name",
  "dev",
], {
  encoding: "utf8",
  env: { ...process.env, XMUX_STATE_DIR: cliRoot },
});
assert.equal(codexStop.status, 0, codexStop.stderr || codexStop.stdout);

const claudeStop = spawnSync(process.execPath, [
  path.join(__dirname, "..", "src", "claude", "cli.js"),
  "stop",
  "--name",
  "dev",
], {
  encoding: "utf8",
  env: { ...process.env, XMUX_STATE_DIR: cliRoot },
});
assert.equal(claudeStop.status, 0, claudeStop.stderr || claudeStop.stdout);

assert.equal(readUnifiedSession("codex", "dev", cliRoot).status, "terminated");
assert.equal(readUnifiedSession("claude", "dev", cliRoot).status, "terminated");

const codexStatus = spawnSync(process.execPath, [
  path.join(__dirname, "..", "src", "codex", "cli.js"),
  "status",
  "--to",
  "dev",
], {
  encoding: "utf8",
  env: { ...process.env, XMUX_STATE_DIR: cliRoot },
});
assert.equal(codexStatus.status, 0, codexStatus.stderr || codexStatus.stdout);
assert.equal(JSON.parse(codexStatus.stdout).session.session_id, "codex--dev");

const claudeSessions = spawnSync(process.execPath, [
  path.join(__dirname, "..", "src", "claude", "cli.js"),
  "sessions",
  "--json",
], {
  encoding: "utf8",
  env: { ...process.env, XMUX_STATE_DIR: cliRoot },
});
assert.equal(claudeSessions.status, 0, claudeSessions.stderr || claudeSessions.stdout);
assert.deepEqual(JSON.parse(claudeSessions.stdout).sessions.map((item) => item.session_id), ["claude--dev"]);

fs.rmSync(tempRoot, { recursive: true, force: true });
fs.rmSync(migrationRoot, { recursive: true, force: true });
fs.rmSync(partialCleanupRoot, { recursive: true, force: true });
fs.rmSync(mirrorRoot, { recursive: true, force: true });
fs.rmSync(cliRoot, { recursive: true, force: true });

console.log("session state tests passed");
