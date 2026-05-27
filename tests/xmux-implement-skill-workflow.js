#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const {
  markerEntry,
  parsePhaseMarker,
  phaseEntry,
  phaseMarker,
} = require("../src/xmux/phase-registry");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludes(haystack, needle, message) {
  assert.equal(haystack.includes(needle), true, message || `expected to include: ${needle}`);
}

function assertInOrder(text, needles, message) {
  let offset = -1;
  for (const needle of needles) {
    const found = text.indexOf(needle, offset + 1);
    assert.notEqual(found, -1, `${message}: missing ${needle}`);
    assert.equal(found > offset, true, `${message}: ${needle} should appear after prior item`);
    offset = found;
  }
}

const codexSkill = read("assets/codex/skills/xmux-implement/SKILL.md");
const codexAgent = read("assets/codex/skills/xmux-implement/agents/openai.yaml").replace(/\\"/g, '"');
const claudeReviewAgent = read("assets/claude/agents/xmux-review.md");

assertIncludes(
  codexSkill,
  'description: "Use only when the user explicitly invokes $xmux-implement as the first token of the prompt."',
  "Codex skill front matter should require exact first-token invocation",
);
assertIncludes(
  codexSkill,
  "Do not use this skill for ordinary implementation requests unless the first\ntoken is exactly `$xmux-implement`.",
  "Codex skill body should forbid implicit invocation",
);
assertIncludes(
  codexAgent,
  "allow_implicit_invocation: false",
  "Codex agent metadata should forbid implicit invocation",
);
assertIncludes(
  codexSkill,
  "Codex is the only writer in v1. Claude is used as the independent semantic\nreviewer through the XMux Claude harness.",
  "Workflow contract should preserve Codex writer and Claude reviewer roles",
);

assertInOrder(codexSkill, [
  "intake",
  "classify-risk",
  "scope",
  "plan",
  "implement-core",
  "verify",
  "Claude review",
  "fixup if needed",
  "verify.attempt++",
  "review-recheck",
  "finalize gate",
], "Workflow contract should keep the evidence-gated implementation order");

for (const requiredCommand of [
  "xmux workflow start",
  "xmux workflow classify",
  "xmux workflow evidence",
  "xmux claude send --trigger xmux-claude --transport-consent xmux-implement --phase review",
  "xmux workflow phase",
  "xmux workflow finding",
  "xmux workflow gate",
]) {
  assertIncludes(codexSkill, requiredCommand, `Codex skill should document ${requiredCommand}`);
}

for (const agentPromptFragment of [
  'prompt starts with $xmux-implement',
  "xmux workflow start",
  "workflow classify",
  "workflow evidence",
  "xmux claude send --trigger xmux-claude --transport-consent xmux-implement --phase review",
  "workflow phase",
  "workflow finding",
  "workflow gate",
]) {
  assertIncludes(codexAgent, agentPromptFragment, `Codex agent prompt should document ${agentPromptFragment}`);
}
assert.equal(codexSkill.includes("$XMUX_INSTALL_DIR/bin/xmux"), false, "Codex skill should not use the old templated wrapper");
assert.equal(codexAgent.includes("$XMUX_INSTALL_DIR/bin/xmux"), false, "Codex agent prompt should not use the old templated wrapper");

for (const reviewPacketField of [
  "run_id",
  "task and done criteria",
  "risk class and fired triggers",
  "changed files and summary",
  "verification evidence with command, exit code, summary, and output tail",
  "review questions focused on semantic correctness, side effects, and evidence\n  sufficiency",
]) {
  assertIncludes(codexSkill, reviewPacketField, `Claude review packet should require ${reviewPacketField}`);
}

for (const prohibitedPath of [
  "raw `tmux`, `send-keys`, `paste-buffer`, or `load-buffer`",
  "teammate/MCP routing paths",
  "legacy `xmux sendPane`",
  "Claude transport outside XMux commands",
]) {
  assertIncludes(codexSkill, prohibitedPath, `Codex skill should prohibit ${prohibitedPath}`);
}
assertIncludes(
  codexSkill,
  "Do not\nput executor model or agent metadata in the prompt.",
  "Codex skill should keep executor selection out of review prompt text",
);

const reviewPhase = phaseEntry("claude", "review");
assert.deepEqual(reviewPhase, {
  lineage: "claude",
  phase: "review",
  marker_name: "xmux-claude-review",
  required_agent: "xmux-review",
});
assert.equal(phaseMarker("claude", "review"), "[xmux-claude-review]");
assert.equal(markerEntry("[xmux-claude-review]").required_agent, "xmux-review");
assert.deepEqual(parsePhaseMarker({ prompt: "[xmux-claude-review]\nreview packet" }), {
  lineage: "claude",
  phase: "review",
  marker_name: "xmux-claude-review",
  required_agent: "xmux-review",
  marker: "[xmux-claude-review]",
  body: "review packet",
});

const recheckPhase = phaseEntry("claude", "review-recheck");
assert.equal(recheckPhase.required_agent, "xmux-review");
assert.equal(phaseMarker("claude", "review-recheck"), "[xmux-claude-review-recheck]");

assertIncludes(claudeReviewAgent, "name: xmux-review", "Claude review agent should have the required name");
assertIncludes(
  claudeReviewAgent,
  "Use only when the active prompt contains [xmux-claude-review] or [xmux-claude-review-recheck].",
  "Claude review agent should be marker scoped",
);
assertIncludes(claudeReviewAgent, "model: sonnet", "Claude review should not use Haiku for authoritative review");
assertIncludes(claudeReviewAgent, "tools: Read, Glob, Grep", "Claude review should be read-only");
assertIncludes(claudeReviewAgent, "maxTurns: 6", "Claude review should keep enough turns for semantic review");
assertIncludes(claudeReviewAgent, "Do not\nedit files.", "Claude review should not write files");

console.log("xmux implement skill workflow tests passed");
