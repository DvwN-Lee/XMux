'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendPhase,
  classifyRisk,
  evaluateCompletionGate,
  findExecutorEventForRequest,
  readRouteEvents,
  readWorkflowRun,
  recordRiskClassification,
  newWorkflowRun,
  writeWorkflowRun,
} = require('./workflow-state');
const { phaseEntry, markerEntry } = require('./phase-registry');

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
      addArg(out, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    if (['json', 'optional', 'approval-required', 'stdin-output-tail', 'allow-unverified'].includes(key)) {
      addArg(out, key, true);
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`--${key} requires a value`);
    addArg(out, key, argv[++i]);
  }
  return out;
}

function addArg(out, key, value) {
  if (out[key] === undefined) {
    out[key] = value;
  } else if (Array.isArray(out[key])) {
    out[key].push(value);
  } else {
    out[key] = [out[key], value];
  }
}

function arrayArg(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function numberArg(opts, key, fallback = 0) {
  const value = opts[key] === undefined ? fallback : Number(opts[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

function required(opts, key) {
  const value = String(opts[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function requestPath(root, requestId) {
  return path.join(root, 'claude', 'requests', `${requestId}.json`);
}

function readRequest(root, requestId) {
  return readJson(requestPath(root, requestId), null);
}

function findRouteEventForRequest(root, requestId, owner = '') {
  return [...readRouteEvents(root)].reverse().find((event) => (
    event.request_id === requestId
    && (!owner || event.to_lineage === owner)
    && event.marker_valid
  )) || null;
}

function phaseRequirement(lineage, phase, phaseMarker = '') {
  const marker = markerEntry(phaseMarker || '');
  if (marker) return marker;
  if (!lineage || !phase) return null;
  return phaseEntry(lineage, phase);
}

function loadRun(root, opts) {
  const runId = required(opts, 'run-id');
  const run = readWorkflowRun(root, runId);
  if (!run) throw new Error(`workflow run not found: ${runId}`);
  return run;
}

function output(payload, opts = {}) {
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.status === 'ok' && payload.run_id) {
    console.log(`${payload.status} ${payload.run_id}`);
    return;
  }
  console.log(JSON.stringify(payload));
}

function cmdStart(opts, root = stateRoot()) {
  const run = newWorkflowRun({
    run_id: opts['run-id'],
    workflow: opts.workflow || 'xmux-implement',
    phase: 'intake',
    phase_owner: 'codex',
    writer_lineage: 'codex',
    task_ref: opts['task-ref'] || '',
    done_criteria: arrayArg(opts['done-criteria']),
    review_required: opts['review-required'] === undefined ? true : String(opts['review-required']) !== 'false',
  });
  const saved = writeWorkflowRun(root, {
    ...run,
    task_ref: opts['task-ref'] || '',
  });
  return { status: 'ok', run_id: saved.run_id, run: saved };
}

function cmdClassify(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  const classification = classifyRisk({
    changed_files: numberArg(opts, 'changed-files', 0),
    changed_lines: numberArg(opts, 'changed-lines', 0),
    triggers: arrayArg(opts.trigger),
    codex_raised_risk: opts['raise-risk'] || '',
  });
  const next = writeWorkflowRun(root, recordRiskClassification(run, {
    risk_class: classification.risk_class,
    source: classification.risk_class_source,
    risk_triggers: classification.risk_triggers,
  }));
  return { status: 'ok', run_id: next.run_id, classification, run: next };
}

function cmdEvidence(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  let outputTail = opts['output-tail'];
  if (opts['output-tail-file']) outputTail = fs.readFileSync(path.resolve(expandUser(opts['output-tail-file'])), 'utf8');
  if (opts['stdin-output-tail']) outputTail = fs.readFileSync(0, 'utf8');
  const item = {
    type: opts.type || 'command',
    cmd: required(opts, 'cmd'),
    exit_code: Number(opts['exit-code']),
    summary: required(opts, 'summary'),
    output_tail: outputTail === undefined ? '' : String(outputTail),
    required: !opts.optional,
    ts: nowTs(),
  };
  if (!Number.isInteger(item.exit_code)) throw new Error('--exit-code must be an integer');
  const next = writeWorkflowRun(root, {
    ...run,
    evidence_bundle: [...(run.evidence_bundle || []), item],
    phase: 'verify',
    phase_owner: 'codex',
    updated_at: nowTs(),
  });
  return { status: 'ok', run_id: next.run_id, evidence: item, run: next };
}

function phaseFromRequest(root, opts, owner) {
  const requestId = String(opts['request-id'] || '').trim();
  if (!requestId) return {};
  const request = readRequest(root, requestId);
  if (!request) throw new Error(`request not found: ${requestId}`);
  const event = findRouteEventForRequest(root, requestId, owner);
  if (!event && !opts['allow-unverified']) {
    throw new Error(`verified route event not found for request: ${requestId}`);
  }
  return {
    route_event_ref: event ? event.event_id : null,
    prompt_hash: request.prompt_sha256 || (event && event.prompt_hash) || null,
    model_tier: request.model_tier || (event && event.model_tier) || null,
    phase_marker: request.phase_marker || (event && event.phase_marker) || null,
    phase: request.phase || (event && event.phase) || null,
    required_executor_agent: request.required_executor_agent || null,
    executor_event_ref: request.executor_event_ref || null,
    request_id: requestId,
  };
}

function cmdPhase(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  const owner = required(opts, 'owner');
  const fromRequest = phaseFromRequest(root, opts, owner);
  const phaseName = required(opts, 'phase');
  const phaseMarker = opts['phase-marker'] || fromRequest.phase_marker || null;
  const requirement = phaseRequirement(owner, phaseName, phaseMarker);
  const requiredExecutorAgent = opts['required-executor-agent']
    || fromRequest.required_executor_agent
    || (requirement && requirement.required_agent)
    || null;
  const executorEvent = opts['executor-event-ref']
    ? null
    : (requiredExecutorAgent && fromRequest.request_id
      ? findExecutorEventForRequest(root, fromRequest.request_id, {
        agent_name: requiredExecutorAgent,
        phase_marker: phaseMarker || (requirement && `[${requirement.marker_name}]`) || '',
        phase: phaseName,
      })
      : null);
  const phase = {
    phase: phaseName,
    phase_owner: owner,
    status: opts.status || 'recorded',
    route_event_ref: opts['route-event-ref'] || fromRequest.route_event_ref || null,
    phase_marker: phaseMarker || (requirement && `[${requirement.marker_name}]`) || null,
    prompt_hash: opts['prompt-hash'] || fromRequest.prompt_hash || null,
    model_tier: opts['model-tier'] || fromRequest.model_tier || null,
    required_executor_agent: requiredExecutorAgent,
    executor_event_ref: opts['executor-event-ref'] || fromRequest.executor_event_ref || (executorEvent && executorEvent.event_id) || null,
    evidence_sufficiency: opts['evidence-sufficiency'] || null,
  };
  if (owner === 'claude' && !phase.route_event_ref && !opts['allow-unverified']) {
    throw new Error('Claude-owned phases require --request-id or --route-event-ref');
  }
  const next = writeWorkflowRun(root, appendPhase(run, phase));
  return { status: 'ok', run_id: next.run_id, phase, run: next };
}

function cmdFinding(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  const finding = {
    id: opts.id || `finding-${(run.findings || []).length + 1}`,
    severity: opts.severity || 'medium',
    type: opts.type || 'review',
    file: opts.file || '',
    line: opts.line ? Number(opts.line) : null,
    rationale: opts.rationale || '',
    required_fix: opts['required-fix'] || '',
    status: opts.status || 'open',
    ts: nowTs(),
  };
  const existing = (run.findings || []).filter((item) => item.id !== finding.id);
  const next = writeWorkflowRun(root, {
    ...run,
    findings: [...existing, finding],
  });
  return { status: 'ok', run_id: next.run_id, finding, run: next };
}

function cmdContract(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  let route = {};
  if (opts['request-id']) {
    route = phaseFromRequest(root, opts, 'claude');
  }
  const contract = {
    approval_required: Boolean(opts['approval-required']),
    approved_by: opts['approved-by'] || '',
    route_event_ref: opts['route-event-ref'] || route.route_event_ref || null,
    prompt_hash: opts['prompt-hash'] || route.prompt_hash || null,
    summary: opts.summary || '',
    updated_at: nowTs(),
  };
  const next = writeWorkflowRun(root, {
    ...run,
    verification_contract: contract,
  });
  return { status: 'ok', run_id: next.run_id, verification_contract: contract, run: next };
}

function cmdGate(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  const gate = evaluateCompletionGate(root, run);
  const next = writeWorkflowRun(root, {
    ...run,
    gate_state: gate.ok ? 'passed' : 'open',
  });
  return { status: gate.ok ? 'ok' : 'blocked', run_id: next.run_id, gate, run: next };
}

function cmdShow(opts, root = stateRoot()) {
  const run = loadRun(root, opts);
  return { status: 'ok', run_id: run.run_id, run };
}

function usage() {
  console.error(`Usage:
  xmux workflow start [--run-id <id>] [--task-ref <text>] [--done-criteria <text>]... [--json]
  xmux workflow classify --run-id <id> [--changed-files <n>] [--changed-lines <n>] [--trigger <name>]... [--raise-risk high] [--json]
  xmux workflow evidence --run-id <id> --cmd <cmd> --exit-code <n> --summary <text> [--output-tail <text>|--output-tail-file <path>|--stdin-output-tail] [--optional] [--json]
  xmux workflow phase --run-id <id> --phase <name> --owner codex|claude [--status <status>] [--request-id <id>|--route-event-ref <id>] [--phase-marker <marker>] [--required-executor-agent <agent>] [--executor-event-ref <id>] [--prompt-hash <sha256>] [--evidence-sufficiency sufficient|insufficient] [--json]
  xmux workflow finding --run-id <id> [--id <id>] [--severity low|medium|high|critical] [--type <type>] [--status open|addressed|accepted|rejected] [--file <path>] [--line <n>] [--rationale <text>] [--required-fix <text>] [--json]
  xmux workflow contract --run-id <id> [--approval-required] [--approved-by claude] [--request-id <id>|--route-event-ref <id>] [--prompt-hash <sha256>] [--summary <text>] [--json]
  xmux workflow gate --run-id <id> [--json]
  xmux workflow show --run-id <id> [--json]`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const command = opts._.shift() || '';
  try {
    let payload;
    switch (command) {
      case 'start':
        payload = cmdStart(opts);
        break;
      case 'classify':
        payload = cmdClassify(opts);
        break;
      case 'evidence':
        payload = cmdEvidence(opts);
        break;
      case 'phase':
        payload = cmdPhase(opts);
        break;
      case 'finding':
        payload = cmdFinding(opts);
        break;
      case 'contract':
        payload = cmdContract(opts);
        break;
      case 'gate':
        payload = cmdGate(opts);
        break;
      case 'show':
        payload = cmdShow(opts);
        break;
      case '-h':
      case '--help':
      case 'help':
        usage();
        return 0;
      default:
        usage();
        throw new Error(command ? `unknown workflow command: ${command}` : 'workflow command is required');
    }
    output(payload, opts);
    return payload.status === 'blocked' ? 2 : 0;
  } catch (error) {
    console.error(`xmux workflow: ${error && error.message ? error.message : String(error)}`);
    return 1;
  }
}

module.exports = {
  main,
  parseArgs,
  cmdStart,
  cmdClassify,
  cmdEvidence,
  cmdPhase,
  cmdFinding,
  cmdContract,
  cmdGate,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`xmux workflow: ${error && error.message ? error.message : String(error)}`);
      process.exit(1);
    });
}
