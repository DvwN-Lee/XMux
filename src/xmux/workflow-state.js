'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE_EVENT_SCHEMA = 'xmux.workflow.route_event.v1';
const EXECUTOR_EVENT_SCHEMA = 'xmux.workflow.executor_event.v1';
const RUN_SCHEMA = 'xmux.workflow.run.v1';
const RISK_ORDER = ['low', 'medium', 'high'];
const MODEL_TIERS = new Set(['unknown', 'haiku', 'sonnet', 'opus', 'codex', 'gpt-5.3-codex', 'gpt-5.5']);
const LINEAGES = new Set(['codex', 'claude']);
const RISK_TRIGGERS = new Set([
  'public_behavior_change',
  'domain_business_logic',
  'unclear_test_coverage',
  'cross_module',
  'new_dependency',
  'new_abstraction',
  'auth_security_pii',
  'schema_migration',
  'file_count',
  'line_count',
]);
const HIGH_RISK_TRIGGERS = new Set([
  'auth_security_pii',
  'schema_migration',
]);
const LOW_RISK_ELIGIBLE_TRIGGERS = new Set([
  'docs_only',
  'comments_only',
  'typo_only',
  'test_only_addition',
  'non_behavioral_config',
  'isolated_mechanical_refactor',
]);
const DEFAULT_FILE_COUNT_THRESHOLD = 3;
const DEFAULT_LINE_COUNT_THRESHOLD = 120;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function nowTs() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z/, '$1Z');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeComponent(value, field) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') throw new Error(`${field} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  return text;
}

function safeLineage(value, field = 'lineage') {
  const text = String(value || '').trim();
  if (!LINEAGES.has(text)) throw new Error(`${field} must be one of: ${[...LINEAGES].join(', ')}`);
  return text;
}

function safeRisk(value, fallback = 'low') {
  const text = String(value || fallback).trim();
  if (!RISK_ORDER.includes(text)) throw new Error(`risk_class must be one of: ${RISK_ORDER.join(', ')}`);
  return text;
}

function riskRank(value) {
  return RISK_ORDER.indexOf(safeRisk(value));
}

function safeModelTier(value) {
  const text = String(value || 'unknown').trim().toLowerCase();
  if (text.includes('opus')) return 'opus';
  if (text.includes('sonnet')) return 'sonnet';
  if (text.includes('haiku')) return 'haiku';
  if (text.includes('gpt-5.5')) return 'gpt-5.5';
  if (text.includes('gpt-5.3') || text.includes('gpt5.3')) return 'gpt-5.3-codex';
  return MODEL_TIERS.has(text) ? text : 'unknown';
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
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

function workflowsDir(root) {
  return path.join(root, 'workflows');
}

function workflowRunsDir(root) {
  return path.join(workflowsDir(root), 'runs');
}

function workflowRunPath(root, runId) {
  return path.join(workflowRunsDir(root), `${safeComponent(runId, 'run_id')}.json`);
}

function routeEventsPath(root) {
  return path.join(workflowsDir(root), 'route-events.jsonl');
}

function executorEventsPath(root) {
  return path.join(workflowsDir(root), 'executor-events.jsonl');
}

function routeEventId() {
  return `route-${crypto.randomBytes(12).toString('hex')}`;
}

function executorEventId() {
  return `exec-${crypto.randomBytes(12).toString('hex')}`;
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function appendRouteEvent(event = {}, root) {
  if (!root) throw new Error('root is required');
  const record = {
    schema: ROUTE_EVENT_SCHEMA,
    event_id: safeComponent(event.event_id || routeEventId(), 'event_id'),
    request_id: safeComponent(event.request_id, 'request_id'),
    from_lineage: safeLineage(event.from_lineage, 'from_lineage'),
    to_lineage: safeLineage(event.to_lineage, 'to_lineage'),
    prompt_hash: String(event.prompt_hash || '').trim(),
    marker_valid: Boolean(event.marker_valid),
    model_tier: safeModelTier(event.model_tier),
    transport_event: String(event.transport_event || '').trim(),
    phase_marker: String(event.phase_marker || '').trim(),
    phase: String(event.phase || '').trim(),
    ts: event.ts || nowTs(),
  };
  if (!/^[A-Fa-f0-9]{64}$/.test(record.prompt_hash)) throw new Error('prompt_hash must be a sha256 hex digest');
  appendJsonl(routeEventsPath(root), record);
  return record;
}

function appendExecutorEvent(event = {}, root) {
  if (!root) throw new Error('root is required');
  const record = {
    schema: EXECUTOR_EVENT_SCHEMA,
    event_id: safeComponent(event.event_id || executorEventId(), 'event_id'),
    request_id: safeComponent(event.request_id, 'request_id'),
    lineage: safeLineage(event.lineage, 'lineage'),
    event: String(event.event || 'stop').trim(),
    phase_marker: String(event.phase_marker || '').trim(),
    phase: String(event.phase || '').trim(),
    agent_name: safeComponent(event.agent_name, 'agent_name'),
    agent_model: safeModelTier(event.agent_model || event.model_tier || 'unknown'),
    agent_definition_hash: String(event.agent_definition_hash || '').trim(),
    transcript_path: String(event.transcript_path || '').trim(),
    hook_event: String(event.hook_event || '').trim(),
    ts: event.ts || nowTs(),
  };
  appendJsonl(executorEventsPath(root), record);
  return record;
}

function readRouteEvents(root) {
  const filePath = routeEventsPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter((item) => item && item.schema === ROUTE_EVENT_SCHEMA);
}

function readExecutorEvents(root) {
  const filePath = executorEventsPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter((item) => item && item.schema === EXECUTOR_EVENT_SCHEMA);
}

function findRouteEvent(root, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  return readRouteEvents(root).find((event) => event.event_id === id) || null;
}

function findExecutorEvent(root, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  return readExecutorEvents(root).find((event) => event.event_id === id) || null;
}

function findExecutorEventForRequest(root, requestId, opts = {}) {
  const id = String(requestId || '').trim();
  if (!id) return null;
  const agentName = String(opts.agent_name || '').trim();
  const phaseMarker = String(opts.phase_marker || '').trim();
  const phase = String(opts.phase || '').trim();
  const eventName = String(opts.event || 'stop').trim();
  return [...readExecutorEvents(root)].reverse().find((event) => (
    event.request_id === id
    && (!agentName || event.agent_name === agentName)
    && (!phaseMarker || event.phase_marker === phaseMarker)
    && (!phase || event.phase === phase)
    && (!eventName || event.event === eventName)
  )) || null;
}

function newWorkflowRun(fields = {}) {
  const ts = fields.created_at || nowTs();
  const runId = fields.run_id || `run-${crypto.randomBytes(12).toString('hex')}`;
  return {
    schema: RUN_SCHEMA,
    run_id: safeComponent(runId, 'run_id'),
    workflow: String(fields.workflow || 'xmux-implement'),
    phase: fields.phase || 'intake',
    phase_owner: fields.phase_owner || 'codex',
    writer_lineage: fields.writer_lineage || 'codex',
    risk_class: safeRisk(fields.risk_class || 'low'),
    risk_class_source: fields.risk_class_source || 'initial',
    risk_triggers: Array.isArray(fields.risk_triggers) ? [...fields.risk_triggers] : [],
    risk_history: Array.isArray(fields.risk_history) ? [...fields.risk_history] : [],
    done_criteria: Array.isArray(fields.done_criteria) ? [...fields.done_criteria] : [],
    phase_history: Array.isArray(fields.phase_history) ? [...fields.phase_history] : [],
    evidence_bundle: Array.isArray(fields.evidence_bundle) ? [...fields.evidence_bundle] : [],
    findings: Array.isArray(fields.findings) ? [...fields.findings] : [],
    verification_contract: fields.verification_contract || null,
    evidence_sufficiency: fields.evidence_sufficiency || '',
    review_required: fields.review_required === undefined ? true : Boolean(fields.review_required),
    signoff_required: Boolean(fields.signoff_required),
    review_skipped: Boolean(fields.review_skipped),
    skip_rule_id: fields.skip_rule_id || null,
    sampled: Boolean(fields.sampled),
    sample_reason: fields.sample_reason || '',
    misclassification: Boolean(fields.misclassification),
    attempt: Number(fields.attempt || 1),
    fixup_count: Number(fields.fixup_count || 0),
    max_fixup: Number(fields.max_fixup || 3),
    failure_signatures: Array.isArray(fields.failure_signatures) ? [...fields.failure_signatures] : [],
    previous_failure_signature: fields.previous_failure_signature || null,
    stuck_count: Number(fields.stuck_count || 0),
    max_stuck: Number(fields.max_stuck || 1),
    gate_state: fields.gate_state || 'open',
    human_handoff: fields.human_handoff || null,
    created_at: ts,
    updated_at: fields.updated_at || ts,
  };
}

function writeWorkflowRun(root, run) {
  const next = { ...run, schema: RUN_SCHEMA, updated_at: nowTs() };
  writeJson(workflowRunPath(root, next.run_id), next);
  return next;
}

function readWorkflowRun(root, runId) {
  const run = readJson(workflowRunPath(root, runId), null);
  return run && run.schema === RUN_SCHEMA ? run : null;
}

function appendPhase(run, phase = {}) {
  const entry = {
    phase: String(phase.phase || run.phase || ''),
    phase_owner: String(phase.phase_owner || run.phase_owner || ''),
    status: String(phase.status || 'recorded'),
    route_event_ref: phase.route_event_ref || null,
    phase_marker: phase.phase_marker || null,
    prompt_hash: phase.prompt_hash || null,
    model_tier: phase.model_tier || null,
    required_executor_agent: phase.required_executor_agent || null,
    executor_event_ref: phase.executor_event_ref || null,
    evidence_sufficiency: phase.evidence_sufficiency || null,
    ts: phase.ts || nowTs(),
  };
  return {
    ...run,
    phase: entry.phase || run.phase,
    phase_owner: entry.phase_owner || run.phase_owner,
    phase_history: [...(run.phase_history || []), entry],
  };
}

function recordRiskClassification(run, classification = {}) {
  const current = safeRisk(run.risk_class || 'low');
  const next = safeRisk(classification.risk_class || current);
  if (riskRank(next) < riskRank(current)) {
    throw new Error(`risk_class cannot be lowered from ${current} to ${next}`);
  }
  const record = {
    risk_class: next,
    source: String(classification.source || classification.risk_class_source || 'rule_id'),
    triggers: Array.isArray(classification.risk_triggers) ? [...classification.risk_triggers] : [],
    ts: classification.ts || nowTs(),
  };
  return {
    ...run,
    risk_class: next,
    risk_class_source: record.source,
    risk_triggers: record.triggers,
    risk_history: [...(run.risk_history || []), record],
  };
}

function classifyRisk(input = {}, opts = {}) {
  const thresholdFiles = Number(opts.fileCountThreshold || DEFAULT_FILE_COUNT_THRESHOLD);
  const thresholdLines = Number(opts.lineCountThreshold || DEFAULT_LINE_COUNT_THRESHOLD);
  const fired = new Set();
  for (const trigger of input.triggers || []) {
    if (RISK_TRIGGERS.has(trigger)) fired.add(trigger);
  }
  if (Number(input.changed_files || 0) > thresholdFiles) fired.add('file_count');
  if (Number(input.changed_lines || 0) > thresholdLines) fired.add('line_count');
  const riskClass = [...fired].some((trigger) => HIGH_RISK_TRIGGERS.has(trigger)) ? 'high' : (fired.size ? 'medium' : 'low');
  const raised = input.codex_raised_risk ? safeRisk(input.codex_raised_risk) : riskClass;
  return {
    risk_class: riskRank(raised) > riskRank(riskClass) ? raised : riskClass,
    risk_class_source: fired.size ? 'rule_id' : 'low_risk_rules',
    risk_triggers: [...fired].sort(),
    low_risk_fast_path_allowed: fired.size === 0,
  };
}

function validateEvidenceItem(item = {}) {
  const errors = [];
  if (!String(item.cmd || '').trim()) errors.push('cmd missing');
  if (!Number.isInteger(item.exit_code)) errors.push('exit_code missing');
  if (!String(item.summary || '').trim()) errors.push('summary missing');
  if (item.output_tail === undefined || item.output_tail === null) errors.push('output_tail missing');
  return {
    ok: errors.length === 0,
    pass: errors.length === 0 && item.exit_code === 0,
    errors,
  };
}

function normalizeFailureText(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(new RegExp(`${escapeRegExp(process.cwd())}/?`, 'g'), '<cwd>/')
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/g, '<path>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/:\d+\b/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failureSignature(text) {
  return sha256(normalizeFailureText(text));
}

function severityRank(value) {
  const index = SEVERITY_ORDER.indexOf(String(value || 'low'));
  return index >= 0 ? index : 0;
}

function latestEvidenceSufficiency(run = {}) {
  for (const phase of [...(run.phase_history || [])].reverse()) {
    if (phase && phase.evidence_sufficiency) return phase.evidence_sufficiency;
  }
  return run.evidence_sufficiency || '';
}

function computeActorVerification(root, phase = {}) {
  const owner = String(phase.phase_owner || '').trim();
  const ref = String(phase.route_event_ref || '').trim();
  if (!owner || !ref) return { ok: false, reason: 'route_event_ref_missing' };
  let event;
  try {
    event = findRouteEvent(root, ref);
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
  if (!event) return { ok: false, reason: 'route_event_not_found' };
  if (event.to_lineage !== owner) return { ok: false, reason: 'route_event_lineage_mismatch', event };
  if (!event.marker_valid) return { ok: false, reason: 'route_event_marker_invalid', event };
  const expectedHash = String(phase.prompt_hash || phase.prompt_sha256 || '').trim();
  if (!expectedHash) return { ok: false, reason: 'route_event_prompt_hash_missing', event };
  if (expectedHash && event.prompt_hash !== expectedHash) return { ok: false, reason: 'route_event_prompt_hash_mismatch', event };
  return { ok: true, reason: 'verified', event };
}

function computeExecutorVerification(root, phase = {}) {
  const required = String(phase.required_executor_agent || '').trim();
  if (!required) return { ok: true, reason: 'not_required' };
  const ref = String(phase.executor_event_ref || '').trim();
  if (!ref) return { ok: false, reason: 'executor_event_ref_missing' };
  let event;
  try {
    event = findExecutorEvent(root, ref);
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
  if (!event) return { ok: false, reason: 'executor_event_not_found' };
  if (event.agent_name !== required) return { ok: false, reason: 'executor_agent_mismatch', event };
  if (event.event !== 'stop') return { ok: false, reason: 'executor_not_stopped', event };
  if (phase.phase_marker && event.phase_marker !== phase.phase_marker) {
    return { ok: false, reason: 'executor_phase_marker_mismatch', event };
  }
  if (phase.phase && event.phase && event.phase !== phase.phase) {
    return { ok: false, reason: 'executor_phase_mismatch', event };
  }
  return { ok: true, reason: 'verified', event };
}

function requiredClaudePhases(run = {}) {
  return (run.phase_history || []).filter((phase) => phase && phase.phase_owner === 'claude');
}

function hasValidClaudePhase(root, run, name, opts = {}) {
  const expectedTier = opts.model_tier || '';
  return requiredClaudePhases(run).some((phase) => {
    if (phase.phase !== name) return false;
    const verified = computeActorVerification(root, phase);
    if (!verified.ok) return false;
    if (expectedTier && verified.event.model_tier !== expectedTier) return false;
    return true;
  });
}

function evaluateCompletionGate(root, run = {}, opts = {}) {
  const reasons = [];
  const severityThreshold = opts.findingSeverityThreshold || 'low';
  if (run.human_handoff) reasons.push('human_handoff_open');
  if (!Array.isArray(run.evidence_bundle) || run.evidence_bundle.length === 0) {
    reasons.push('verification_evidence_missing');
  } else {
    for (const item of run.evidence_bundle) {
      const validation = validateEvidenceItem(item);
      if (!validation.ok) reasons.push(`invalid_evidence:${validation.errors.join(',')}`);
      else if (item.required !== false && item.exit_code !== 0) reasons.push(`evidence_failed:${item.cmd}`);
    }
  }
  for (const phase of requiredClaudePhases(run)) {
    const verified = computeActorVerification(root, phase);
    if (!verified.ok) reasons.push(`actor_unverified:${phase.phase}:${verified.reason}`);
    const executor = computeExecutorVerification(root, phase);
    if (!executor.ok) reasons.push(`executor_unverified:${phase.phase}:${executor.reason}`);
  }
  if (run.review_required !== false && !run.review_skipped && !hasValidClaudePhase(root, run, 'review')) {
    reasons.push('review_route_event_missing');
  }
  for (const finding of run.findings || []) {
    if (severityRank(finding.severity) >= severityRank(severityThreshold)
      && !['addressed', 'accepted'].includes(String(finding.status || 'open'))) {
      reasons.push(`open_finding:${finding.id || finding.type || 'unknown'}`);
    }
  }
  if (latestEvidenceSufficiency(run) === 'insufficient') reasons.push('evidence_sufficiency_insufficient');
  const contract = run.verification_contract || {};
  if (contract.approval_required && contract.approved_by === 'claude') {
    const verified = computeActorVerification(root, {
      phase_owner: 'claude',
      route_event_ref: contract.route_event_ref,
      prompt_hash: contract.prompt_hash,
    });
    if (!verified.ok) reasons.push(`verification_contract_unverified:${verified.reason}`);
  } else if (contract.approval_required) {
    reasons.push('verification_contract_approval_missing');
  }
  if ((run.signoff_required || run.risk_class === 'high') && !hasValidClaudePhase(root, run, 'final-signoff', { model_tier: 'opus' })) {
    reasons.push('opus_final_signoff_missing');
  }
  if (run.risk_lowered) reasons.push('risk_lowered');
  return {
    ok: reasons.length === 0,
    reasons,
  };
}

module.exports = {
  ROUTE_EVENT_SCHEMA,
  EXECUTOR_EVENT_SCHEMA,
  RUN_SCHEMA,
  RISK_TRIGGERS,
  HIGH_RISK_TRIGGERS,
  LOW_RISK_ELIGIBLE_TRIGGERS,
  DEFAULT_FILE_COUNT_THRESHOLD,
  DEFAULT_LINE_COUNT_THRESHOLD,
  workflowsDir,
  workflowRunsDir,
  workflowRunPath,
  routeEventsPath,
  executorEventsPath,
  appendRouteEvent,
  appendExecutorEvent,
  readRouteEvents,
  readExecutorEvents,
  findRouteEvent,
  findExecutorEvent,
  findExecutorEventForRequest,
  newWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
  appendPhase,
  recordRiskClassification,
  classifyRisk,
  validateEvidenceItem,
  normalizeFailureText,
  failureSignature,
  computeActorVerification,
  computeExecutorVerification,
  evaluateCompletionGate,
};
