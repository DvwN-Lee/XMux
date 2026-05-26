Back to [repository layout](repository-layout.md)

# XMux Workflow Gates

XMux workflow skills are orchestration surfaces. They do not decide whether a
task is complete. Completion is decided by project-local workflow state under:

```text
<project>/.codex/xmux/workflows/
```

## Minimum Safe V1

The first implementation slice is intentionally conservative:

- Codex remains the only writer.
- Every implementation run receives Claude review before finalize.
- Low-risk review skipping, Haiku screening, adaptive sampling, and Claude
  writer baton handoff are deferred.
- Claude handoffs still use the existing `xmux claude send` request/response
  harness.
- `$xmux-implement` is a Codex skill orchestration surface over
  `xmux workflow ...` commands. The skill instructs Codex; the runtime commands
  enforce ledger and gate state.

The safe path is:

```text
intake -> classify-risk -> scope -> plan -> implement-core -> verify
-> review -> fixup if needed -> verify.attempt++ -> review-recheck
-> finalize
```

## Runtime Commands

Workflow state is controlled through the wrapper:

```zsh
xmux workflow start --task-ref "<task>" --done-criteria "<criterion>" --json
xmux workflow classify --run-id "<run_id>" --changed-files <n> --changed-lines <n> --trigger "<trigger>" --json
xmux workflow evidence --run-id "<run_id>" --cmd "<command>" --exit-code <code> --summary "<summary>" --output-tail "<tail>" --json
xmux workflow phase --run-id "<run_id>" --phase review --owner claude --request-id "<request_id>" --evidence-sufficiency sufficient --json
xmux workflow finding --run-id "<run_id>" --id "<finding_id>" --severity medium --status open --json
xmux workflow gate --run-id "<run_id>" --json
```

Claude review handoff still uses the Claude harness. `$xmux-implement` is
accepted as workflow transport consent only for synthesis review handoffs:

```zsh
xmux claude send --trigger xmux-claude --transport-consent xmux-implement --phase review --title "review:<run_id>" --prompt "<review packet>" --json
```

## Phase Ownership

Every phase has exactly one owner. Advisor participation is metadata, not
ownership.

| Phase | Owner | Route condition |
| --- | --- | --- |
| `intake` | Codex | Always |
| `classify-risk` | Harness rules, Codex records | Always |
| `scope` | Codex | Always |
| `plan` | Codex | Always |
| `verification-contract` | Codex | Claude approval for high/triggered medium |
| `implement-core` | Codex | Always |
| `verify` | Codex | Always |
| `review` | Claude | Minimum V1 always; later medium/high |
| `fixup` | Codex | On verify or review failure |
| `review-recheck` | Claude | On review-driven fixup |
| `final-signoff` | Claude Opus | High risk or reopened review |
| `finalize` | Codex | Only after gate passes |
| `stuck` | Claude diagnosis | Repeated failure or retry exhaustion |

`re-verify` is not a separate phase. It is `verify` with `attempt > 1`.

## Route Event Provenance

Claude-owned phases must be proved by an append-only route event. Codex may
reference a route event id, but Codex must not set `actor_verified`.

Phase-specific handoffs use target-and-phase markers such as:

```text
[xmux-claude-review]
[xmux-claude-final-signoff]
[xmux-codex-verify]
```

The prompt body should not include executor model metadata. Hooks map the phase
marker to a managed phase executor, for example `[xmux-claude-review]` requires
the Claude `xmux-review` subagent. The subagent definition owns the model.

Route events are stored in:

```text
<project>/.codex/xmux/workflows/route-events.jsonl
```

Each route event records:

```json
{
  "schema": "xmux.workflow.route_event.v1",
  "event_id": "route-...",
  "request_id": "req-...",
  "from_lineage": "codex",
  "to_lineage": "claude",
  "prompt_hash": "...",
  "marker_valid": true,
  "model_tier": "sonnet",
  "transport_event": "claude.hook.xmux_codex.accepted",
  "phase_marker": "[xmux-claude-review]",
  "phase": "review",
  "ts": "..."
}
```

`actor_verified` is computed by the gate as a join:

```text
phase_owner == route_event.to_lineage
AND route_event.marker_valid == true
AND phase.prompt_hash == route_event.prompt_hash
```

A missing, mismatched, or forged route event fails the gate.

Claude phase executors are proved separately by:

```text
<project>/.codex/xmux/workflows/executor-events.jsonl
```

For a phase such as `review`, the gate requires both a valid route event and a
matching executor event:

```text
phase.required_executor_agent == executor_event.agent_name
AND phase.phase_marker == executor_event.phase_marker
AND executor_event.event == "stop"
```

This prevents a main Claude Opus response from satisfying a phase that required
the `xmux-review` Sonnet subagent.

## Risk Rules

Risk is rule-derived and monotonic. Codex may raise risk, but any attempt to
lower risk is rejected.

Low-risk fast path is deferred in minimum V1. When enabled later, review skip is
allowed only if none of these triggers fired:

- `public_behavior_change`
- `domain_business_logic`
- `unclear_test_coverage`
- `cross_module`
- `new_dependency`
- `new_abstraction`
- `auth_security_pii`
- `schema_migration`
- `file_count` greater than the V1 threshold
- `line_count` greater than the V1 threshold

V1 thresholds:

```text
file_count > 3
line_count > 120
```

`auth_security_pii` and `schema_migration` classify as high risk by rule. Other
fired triggers classify as medium unless the workflow raises them to high.

Model names are normalized to gate tiers before evaluation. For example,
`opus-4.7` records as `opus`, so high-risk signoff checks the tier family
rather than one exact model string.

## Evidence Contract

`verify` can pass only with machine evidence:

```json
{
  "cmd": "npm test",
  "exit_code": 0,
  "summary": "all tests passed",
  "output_tail": "..."
}
```

Missing `cmd`, missing integer `exit_code`, missing `summary`, or missing
`output_tail` means the evidence is invalid. Prose-only verification is
`blocked`, not `pass`.

Failure signatures normalize unstable text before hashing:

- ANSI escape sequences
- timestamps
- memory addresses
- absolute paths
- line and column numbers
- whitespace runs

The same normalized failure twice, or `max_fixup = 3`, routes to `stuck`.
Minimum V1 sets `max_stuck = 1`; if Claude diagnosis plus one Codex revised
attempt still does not progress, the terminal state is `human_handoff`.

## Completion Gate

Finalize is blocked when any of these predicates fail:

- verification evidence is missing or invalid
- any required evidence has a non-zero exit code
- minimum V1 has no verified Claude `review` route event, unless a later
  review-skip rule explicitly disables review
- any Claude-owned phase lacks a valid route event
- any `request_changes` finding at or above the severity threshold is not
  `addressed` or `accepted`
- latest evidence sufficiency is `insufficient`
- a required verification contract lacks verified Claude approval
- high-risk final signoff lacks an Opus route event
- risk was lowered
- human handoff is open

The gate reads the ledger and route-event log. It does not trust Codex or Claude
prose.
