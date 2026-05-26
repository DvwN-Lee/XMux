#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendPhase,
  appendExecutorEvent,
  appendRouteEvent,
  classifyRisk,
  computeActorVerification,
  computeExecutorVerification,
  evaluateCompletionGate,
  failureSignature,
  newWorkflowRun,
  normalizeFailureText,
  recordRiskClassification,
  routeEventsPath,
  executorEventsPath,
  validateEvidenceItem,
  writeWorkflowRun,
  readWorkflowRun,
} = require("../src/xmux/workflow-state");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-workflow-state-"));

function digest(text) {
  return require("node:crypto").createHash("sha256").update(String(text), "utf8").digest("hex");
}

try {
  const promptHash = digest("review packet");
  const routeEvent = appendRouteEvent({
    request_id: "req-review",
    from_lineage: "codex",
    to_lineage: "claude",
    prompt_hash: promptHash,
    marker_valid: true,
    model_tier: "sonnet",
    transport_event: "claude.hook.xmux_codex.accepted",
  }, tempRoot);

  assert.equal(fs.existsSync(routeEventsPath(tempRoot)), true, "route event log should be append-only on disk");
  assert.equal(routeEvent.to_lineage, "claude");

  const executorEvent = appendExecutorEvent({
    request_id: "req-review",
    lineage: "claude",
    event: "stop",
    phase_marker: "[xmux-claude-review]",
    phase: "review",
    agent_name: "xmux-review",
    agent_model: "sonnet",
    agent_definition_hash: digest("agent"),
    hook_event: "SubagentStop",
  }, tempRoot);
  assert.equal(fs.existsSync(executorEventsPath(tempRoot)), true, "executor event log should be append-only on disk");

  assert.equal(
    computeActorVerification(tempRoot, {
      phase_owner: "claude",
      route_event_ref: routeEvent.event_id,
      prompt_hash: promptHash,
    }).ok,
    true,
    "matching route event should verify Claude actor",
  );
  assert.equal(
    computeActorVerification(tempRoot, {
      phase_owner: "claude",
      route_event_ref: "missing-event",
      prompt_hash: promptHash,
    }).reason,
    "route_event_not_found",
    "forged route_event_ref should not verify",
  );
  assert.equal(
    computeActorVerification(tempRoot, {
      phase_owner: "claude",
      route_event_ref: routeEvent.event_id,
      prompt_hash: digest("different packet"),
    }).reason,
    "route_event_prompt_hash_mismatch",
    "prompt hash mismatch should not verify",
  );
  assert.equal(
    computeActorVerification(tempRoot, {
      phase_owner: "claude",
      route_event_ref: routeEvent.event_id,
    }).reason,
    "route_event_prompt_hash_missing",
    "actor verification should require a phase prompt hash",
  );
  assert.equal(
    computeActorVerification(tempRoot, {
      phase_owner: "codex",
      route_event_ref: routeEvent.event_id,
      prompt_hash: promptHash,
    }).reason,
    "route_event_lineage_mismatch",
    "route event target lineage must match phase owner",
  );

  assert.deepEqual(validateEvidenceItem({
    cmd: "npm test",
    exit_code: 0,
    summary: "all tests passed",
    output_tail: "",
  }), { ok: true, pass: true, errors: [] });
  assert.equal(validateEvidenceItem({ cmd: "npm test", summary: "claimed pass", output_tail: "" }).pass, false);

  const low = classifyRisk({ changed_files: 1, changed_lines: 8, triggers: [] });
  assert.equal(low.risk_class, "low");
  assert.equal(low.low_risk_fast_path_allowed, true);

  for (const trigger of [
    "public_behavior_change",
    "domain_business_logic",
    "unclear_test_coverage",
    "cross_module",
    "new_dependency",
    "new_abstraction",
    "auth_security_pii",
    "schema_migration",
  ]) {
    const classified = classifyRisk({ changed_files: 1, changed_lines: 8, triggers: [trigger] });
    assert.notEqual(classified.risk_class, "low", `${trigger} should escalate out of low risk`);
    assert.equal(classified.low_risk_fast_path_allowed, false, `${trigger} should disable fast path`);
  }
  assert.equal(classifyRisk({ triggers: ["auth_security_pii"] }).risk_class, "high");
  assert.equal(classifyRisk({ triggers: ["schema_migration"] }).risk_class, "high");
  assert.equal(classifyRisk({ changed_files: 4, changed_lines: 8, triggers: [] }).risk_triggers.includes("file_count"), true);
  assert.equal(classifyRisk({ changed_files: 1, changed_lines: 121, triggers: [] }).risk_triggers.includes("line_count"), true);

  let run = newWorkflowRun({ run_id: "run-review", risk_class: "medium" });
  run = recordRiskClassification(run, { risk_class: "medium", source: "rule_id", risk_triggers: ["cross_module"] });
  assert.throws(
    () => recordRiskClassification(run, { risk_class: "low", source: "manual" }),
    /cannot be lowered/,
    "risk lowering should be rejected",
  );

  run.evidence_bundle.push({
    cmd: "npm test",
    exit_code: 0,
    summary: "all tests passed",
    output_tail: "ok",
  });
  run = appendPhase(run, {
    phase: "review",
    phase_owner: "claude",
    status: "approved",
    route_event_ref: routeEvent.event_id,
    phase_marker: "[xmux-claude-review]",
    prompt_hash: promptHash,
    required_executor_agent: "xmux-review",
    executor_event_ref: executorEvent.event_id,
    evidence_sufficiency: "sufficient",
  });
  assert.deepEqual(evaluateCompletionGate(tempRoot, run), { ok: true, reasons: [] });
  assert.equal(
    computeExecutorVerification(tempRoot, {
      phase: "review",
      phase_marker: "[xmux-claude-review]",
      required_executor_agent: "xmux-review",
      executor_event_ref: executorEvent.event_id,
    }).ok,
    true,
    "matching executor event should verify phase subagent",
  );
  assert.equal(
    computeExecutorVerification(tempRoot, {
      phase: "review",
      phase_marker: "[xmux-claude-review]",
      required_executor_agent: "xmux-review",
      executor_event_ref: "missing-executor-event",
    }).reason,
    "executor_event_not_found",
    "forged executor_event_ref should not verify",
  );
  assert.equal(
    evaluateCompletionGate(tempRoot, {
      ...run,
      phase_history: [{ ...run.phase_history[0], executor_event_ref: null }],
    }).reasons.includes("executor_unverified:review:executor_event_ref_missing"),
    true,
    "Claude phase requiring a subagent should block without executor event proof",
  );
  assert.equal(
    evaluateCompletionGate(tempRoot, { ...run, phase_history: [] }).reasons.includes("review_route_event_missing"),
    true,
    "minimum safe v1 requires verified Claude review unless explicitly skipped",
  );

  const openFindingRun = {
    ...run,
    findings: [{
      id: "finding-1",
      severity: "medium",
      type: "bug",
      status: "open",
    }],
  };
  assert.equal(evaluateCompletionGate(tempRoot, openFindingRun).reasons.includes("open_finding:finding-1"), true);

  const insufficientRun = appendPhase({ ...run }, {
    phase: "review-recheck",
    phase_owner: "claude",
    status: "request_changes",
    route_event_ref: routeEvent.event_id,
    phase_marker: "[xmux-claude-review]",
    prompt_hash: promptHash,
    required_executor_agent: "xmux-review",
    executor_event_ref: executorEvent.event_id,
    evidence_sufficiency: "insufficient",
  });
  assert.equal(
    evaluateCompletionGate(tempRoot, insufficientRun).reasons.includes("evidence_sufficiency_insufficient"),
    true,
    "insufficient evidence should block finalize",
  );

  const highRun = {
    ...run,
    risk_class: "high",
    signoff_required: true,
  };
  assert.equal(
    evaluateCompletionGate(tempRoot, highRun).reasons.includes("opus_final_signoff_missing"),
    true,
    "high-risk runs require Opus final signoff",
  );
  const opusEvent = appendRouteEvent({
    request_id: "req-signoff",
    from_lineage: "codex",
    to_lineage: "claude",
    prompt_hash: digest("signoff packet"),
    marker_valid: true,
    model_tier: "opus-4.7",
    transport_event: "claude.hook.xmux_codex.accepted",
  }, tempRoot);
  assert.equal(opusEvent.model_tier, "opus", "specific Opus model names should normalize to opus tier");
  const signed = appendPhase(highRun, {
    phase: "final-signoff",
    phase_owner: "claude",
    status: "approved",
    route_event_ref: opusEvent.event_id,
    prompt_hash: digest("signoff packet"),
  });
  assert.deepEqual(evaluateCompletionGate(tempRoot, signed), { ok: true, reasons: [] });

  const badContract = {
    ...run,
    verification_contract: {
      approval_required: true,
      approved_by: "claude",
      route_event_ref: "missing-contract-route",
      prompt_hash: promptHash,
    },
  };
  assert.equal(
    evaluateCompletionGate(tempRoot, badContract).reasons.some((reason) => reason.startsWith("verification_contract_unverified")),
    true,
    "contract approval should require a valid Claude route event",
  );

  const first = failureSignature("/tmp/project/test.js:10:2 2026-05-26T10:20:30.123Z Error at 0xABC");
  const second = failureSignature("/Users/me/project/test.js:42:9 2026-05-26T10:21:31.999Z Error at 0xDEF");
  assert.equal(first, second, "normalized failure signature should ignore unstable details");
  assert.equal(normalizeFailureText("abc  \n  def"), "abc def");

  const persisted = writeWorkflowRun(tempRoot, signed);
  assert.equal(readWorkflowRun(tempRoot, "run-review").run_id, persisted.run_id);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("workflow state tests passed");
