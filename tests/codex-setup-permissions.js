#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  contentHasCodexPermissionProfile,
  ensureCodexPermissionProfile,
  removeCodexPermissionProfile,
} = require("../src/codex/setup");

const socketA = "/private/tmp/tmux-501/default";
const socketB = "/private/tmp/tmux-501/alternate";

const legacyConfig = [
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  'sandbox_workspace_write.network_access = false',
  "",
  "[sandbox_workspace_write]",
  'writable_roots = ["/private/tmp"]',
  "",
  "[shell_environment_policy.set]",
  'PATH = "/usr/bin:/bin"',
  "",
].join("\n");

const migrated = ensureCodexPermissionProfile(legacyConfig, socketA);
assert.equal(migrated.includes('approval_policy = "on-request"'), true, "unrelated top-level config is preserved");
assert.equal(migrated.includes("sandbox_mode"), false, "legacy sandbox_mode is removed");
assert.equal(migrated.includes("sandbox_workspace_write"), false, "legacy sandbox_workspace_write config is removed");
assert.equal(contentHasCodexPermissionProfile(migrated, socketA), true, "permission profile validates after migration");
assert.equal(
  migrated.indexOf('default_permissions = "xmux-workspace"') < migrated.indexOf("[shell_environment_policy.set]"),
  true,
  "default_permissions remains a top-level TOML assignment before tables",
);
assert.equal(
  migrated.includes('[permissions.xmux-workspace.network.domains]\n# Empty domain allowlist keeps public network requests blocked.'),
  true,
  "network domains stay intentionally empty",
);
assert.equal(migrated.includes('":tmpdir" = "write"'), true, "profile permits tool temp-file writes");

const updated = ensureCodexPermissionProfile(migrated, socketB);
assert.equal(contentHasCodexPermissionProfile(updated, socketB), true, "socket allowlist can be refreshed");
assert.equal(updated.includes(`${JSON.stringify(socketA)} = "allow"`), false, "stale socket allow entry is removed");
assert.equal(updated.includes(`${JSON.stringify(socketB)} = "allow"`), true, "new socket allow entry is installed");

const removed = removeCodexPermissionProfile(updated);
assert.equal(removed.includes('approval_policy = "on-request"'), true, "remove preserves unrelated config");
assert.equal(removed.includes("xmux-workspace"), false, "remove clears XMux permission profile");
assert.equal(removed.includes("default_permissions"), false, "remove clears XMux-owned default profile selector");

console.log("codex setup permission tests passed");
