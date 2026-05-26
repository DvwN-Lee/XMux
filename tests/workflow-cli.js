#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const workflowCli = path.join(repoRoot, "src", "xmux", "workflow-cli.js");
const xmuxBin = path.join(repoRoot, "bin", "xmux");
const { appendExecutorEvent, appendRouteEvent } = require("../src/xmux/workflow-state");

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function run(args, env, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [workflowCli, ...args], {
    cwd: env.XMUX_PROJECT_DIR,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `workflow command ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function runXmux(args, env, expectedStatus = 0) {
  const result = spawnSync(xmuxBin, args, {
    cwd: env.XMUX_PROJECT_DIR,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `xmux command ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-workflow-cli-"));
try {
  const project = path.join(tempRoot, "project");
  const state = path.join(project, ".codex", "xmux");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const env = {
    XMUX_INSTALL_DIR: repoRoot,
    XMUX_PROJECT_DIR: project,
    XMUX_STATE_DIR: state,
  };

  const started = run([
    "start",
    "--run-id", "run-cli",
    "--task-ref", "workflow cli e2e",
    "--done-criteria", "tests pass",
    "--json",
  ], env);
  assert.equal(started.run_id, "run-cli");
  assert.equal(started.run.review_required, true);

  const classified = run([
    "classify",
    "--run-id", "run-cli",
    "--changed-files", "1",
    "--changed-lines", "10",
    "--trigger", "auth_security_pii",
    "--json",
  ], env);
  assert.equal(classified.classification.risk_class, "high");

  run([
    "evidence",
    "--run-id", "run-cli",
    "--cmd", "node --test tests/workflow-cli.js",
    "--exit-code", "0",
    "--summary", "workflow cli assertions passed",
    "--output-tail", "ok",
    "--json",
  ], env);

  const missingReview = run(["gate", "--run-id", "run-cli", "--json"], env, 2);
  assert.equal(missingReview.gate.reasons.includes("review_route_event_missing"), true);

  const reviewHash = digest("review packet");
  writeJson(path.join(state, "claude", "requests", "req-review.json"), {
    request_id: "req-review",
    prompt_sha256: reviewHash,
    model_tier: "sonnet-4.6",
    phase: "review",
    phase_marker: "[xmux-claude-review]",
    required_executor_agent: "xmux-review",
  });
  appendRouteEvent({
    request_id: "req-review",
    from_lineage: "codex",
    to_lineage: "claude",
    prompt_hash: reviewHash,
    marker_valid: true,
    model_tier: "sonnet-4.6",
    transport_event: "claude.hook.xmux_codex.accepted",
    phase_marker: "[xmux-claude-review]",
    phase: "review",
  }, state);
  appendExecutorEvent({
    request_id: "req-review",
    lineage: "claude",
    event: "stop",
    phase_marker: "[xmux-claude-review]",
    phase: "review",
    agent_name: "xmux-review",
    agent_model: "sonnet-4.6",
    hook_event: "SubagentStop",
  }, state);

  run([
    "phase",
    "--run-id", "run-cli",
    "--phase", "review",
    "--owner", "claude",
    "--status", "approved",
    "--request-id", "req-review",
    "--evidence-sufficiency", "sufficient",
    "--json",
  ], env);

  const missingSignoff = run(["gate", "--run-id", "run-cli", "--json"], env, 2);
  assert.equal(missingSignoff.gate.reasons.includes("opus_final_signoff_missing"), true);

  run([
    "finding",
    "--run-id", "run-cli",
    "--id", "finding-1",
    "--severity", "medium",
    "--type", "request_changes",
    "--status", "open",
    "--file", "src/example.js",
    "--line", "7",
    "--rationale", "needs fix",
    "--required-fix", "fix it",
    "--json",
  ], env);
  const openFinding = run(["gate", "--run-id", "run-cli", "--json"], env, 2);
  assert.equal(openFinding.gate.reasons.includes("open_finding:finding-1"), true);

  run([
    "finding",
    "--run-id", "run-cli",
    "--id", "finding-1",
    "--severity", "medium",
    "--type", "request_changes",
    "--status", "addressed",
    "--json",
  ], env);

  const signoffHash = digest("signoff packet");
  writeJson(path.join(state, "claude", "requests", "req-signoff.json"), {
    request_id: "req-signoff",
    prompt_sha256: signoffHash,
    model_tier: "opus-4.7",
    phase: "final-signoff",
    phase_marker: "[xmux-claude-final-signoff]",
    required_executor_agent: "xmux-final-signoff",
  });
  appendRouteEvent({
    request_id: "req-signoff",
    from_lineage: "codex",
    to_lineage: "claude",
    prompt_hash: signoffHash,
    marker_valid: true,
    model_tier: "opus-4.7",
    transport_event: "claude.hook.xmux_codex.accepted",
    phase_marker: "[xmux-claude-final-signoff]",
    phase: "final-signoff",
  }, state);
  appendExecutorEvent({
    request_id: "req-signoff",
    lineage: "claude",
    event: "stop",
    phase_marker: "[xmux-claude-final-signoff]",
    phase: "final-signoff",
    agent_name: "xmux-final-signoff",
    agent_model: "opus-4.7",
    hook_event: "SubagentStop",
  }, state);
  run([
    "phase",
    "--run-id", "run-cli",
    "--phase", "final-signoff",
    "--owner", "claude",
    "--status", "approved",
    "--request-id", "req-signoff",
    "--json",
  ], env);

  const passed = runXmux(["workflow", "gate", "--run-id", "run-cli", "--json"], env);
  assert.equal(passed.gate.ok, true);

  const forged = spawnSync(process.execPath, [workflowCli,
    "phase",
    "--run-id", "run-cli",
    "--phase", "review-recheck",
    "--owner", "claude",
    "--request-id", "missing-request",
    "--json",
  ], {
    cwd: project,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.notEqual(forged.status, 0, "missing request should not record a Claude-owned phase");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("workflow cli tests passed");
