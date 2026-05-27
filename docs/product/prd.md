Back to [documentation](../README.md)

# XMux Product Rationale

This document records the product problem, PRD-level requirements, and model
placement rationale that shaped XMux. It is a product and architecture rationale,
not a line-by-line implementation spec.

## Problem Recognition

XMux started from one core problem: Codex and Claude are useful together, but
ad hoc communication between them is unsafe and hard to audit.

The original desired workflows were:

- Codex asks Claude for analysis, review, or advice, then receives a response
  back in Codex.
- Claude asks Codex to inspect or execute code work, then receives a response
  back in Claude.
- One XMux-managed Codex session sends work to another XMux-managed Codex
  session.

The rejected alternatives were raw pane injection, legacy teammate routing, MCP
mailbox paths, and ambiguous manual copy/paste. Those paths can move text, but
they do not provide a clear consent boundary, request lifecycle, role ownership,
or reliable validation surface.

The product therefore split into two layers:

- **Layer 1: communication harness**: make agent-to-agent transport explicit,
  wrapper-first, stateful, and auditable.
- **Layer 2: completion workflow**: use that transport to make implementation
  completion evidence-backed instead of prose-backed.

## Layer 1: Communication Harness

Layer 1 answers one question: how does work move safely between Codex, Claude,
and other XMux sessions?

### Goals

- Provide explicit Codex-to-Claude-to-Codex communication.
- Provide explicit Claude-to-Codex-to-Claude communication.
- Provide explicit Codex-to-Codex communication between XMux sessions.
- Require user-visible triggers before transport occurs.
- Keep request and response state project-local.
- Verify markers against metadata instead of trusting visible text alone.
- Route only through XMux wrapper commands.

### User-Facing Routes

| Route | Trigger | Runtime path | Mode |
| --- | --- | --- | --- |
| Codex -> Claude -> Codex | `$xmux-claude` | `xmux claude send` | synthesis |
| Codex -> Claude -> Codex | `$xmux-claude!` | `xmux claude send` | raw |
| Claude -> Codex -> Claude | `/xmux-codex` | `xmux claude send-codex` | synthesis |
| Codex -> Codex | `$xmux-send` | `xmux send-pane` | synthesis |
| Codex -> Codex | `$xmux-send!` | `xmux send-pane` | raw |

The first token is the consent boundary. If the user did not explicitly start
with the trigger, XMux should not infer permission to route work to another
agent.

### Synthesis And Raw Mode

Normal mode is synthesis mode. The receiving prompt is not a literal forward of
the user's trigger text. The sending agent uses current task context, evidence,
and the user's routing intent to construct a recipient-facing prompt.

Raw mode is deliberately separate and uses a bang trigger. It exists for narrow
transport/debug cases where literal forwarding is desired. It should not be the
default workflow surface.

### Harness Invariants

Layer 1 is valid only if these invariants hold:

- Prompt transport goes through XMux wrapper commands.
- Raw `tmux`, `send-keys`, `load-buffer`, and `paste-buffer` are not fallback
  prompt transports.
- Legacy teammate/MCP routes are not valid Codex/Claude transport paths.
- Request state lives under the project-local `.codex/xmux` tree.
- Visible markers are not trusted by themselves.
- Request id, nonce, prompt hash, session binding, marker validation, and
  response markers are used to correlate requests and responses.
- The sender does not wait for or summarize unrelated target responses in a
  one-way Codex-to-Codex send.

### Product Acceptance Criteria

Layer 1 is healthy when:

- `$xmux-claude` sends a synthesized Claude-facing request through
  `xmux claude send` and a validated `[xmux-claude-response]` returns to Codex.
- `/xmux-codex` is treated as a Claude-side routing instruction, not forwarded
  verbatim by default.
- `$xmux-send` delivers a one-way `[xmux-send-message]` envelope only to an
  explicit XMux target.
- Transport fails loudly when the supported harness path is unavailable.
- A forged or stale marker without matching request metadata is blocked or
  ignored.

## Layer 2: Completion Workflow

Layer 2 answers a different question: when Codex says an implementation is done,
how does XMux know that is true?

The design discussion identified a completion gap. A code-only `implement`
phase is not enough. Real implementation completion requires:

```text
intake -> classify-risk -> scope -> plan -> implement-core -> verify
-> review -> fixup if needed -> verify.attempt++ -> review-recheck
-> finalize
```

The key product insight is that skills can instruct but cannot enforce. A
`SKILL.md` can tell an agent to verify, review, or stop, but completion must be
decided by runtime state, evidence, and gates.

### Goals

- Treat `implement` as the full completion loop, not only file edits.
- Keep Codex as the default single writer for v1.
- Use Claude as an independent semantic reviewer and stuck-diagnosis lineage.
- Record mechanical evidence from real commands.
- Block completion on missing evidence, open findings, or unverified review.
- Prove the expected agent and phase actually ran.

### Workflow Ownership

| Phase | Owner | Model placement intent |
| --- | --- | --- |
| `intake` | Codex | Main Codex interprets task and done criteria |
| `classify-risk` | Harness rules, Codex records | Rule-derived, monotonic risk |
| `scope` | Codex | Claude advisor only when ambiguous or risky |
| `plan` | Codex | Claude critique for high or triggered-medium risk |
| `verification-contract` | Codex draft | Claude approval for high or triggered-medium risk |
| `implement-core` | Codex | Codex edits files as single writer |
| `verify` | Codex | Codex runs commands and captures evidence |
| `review` | Claude | Claude semantic reviewer, normally Sonnet subagent |
| `fixup` | Codex | Codex resolves verify or review failures |
| `review-recheck` | Claude | Claude checks review-driven fixes |
| `final-signoff` | Claude | Opus for high risk or repeated reopen |
| `stuck` | Claude | Opus diagnosis when Codex stops making progress |
| `finalize` | Codex | Codex packages result only after gate passes |

`re-verify` is not a separate phase. It is `verify` with an incremented attempt.

### Evidence And Gate Requirements

Verification evidence must include:

- command
- integer exit code
- summary
- output tail

Prose-only verification is not a pass. The completion gate reads the ledger and
event logs, not the executor's confidence.

Finalize is blocked when:

- required evidence is missing or invalid
- a required command has non-zero exit code
- a Claude-owned phase lacks a valid route event
- the required Claude phase executor did not run
- a blocking finding remains open
- evidence sufficiency is marked insufficient
- risk was lowered
- required high-risk signoff is missing
- the run is in human handoff

### Route And Executor Proof

The discussion identified a trust problem: Codex must not be able to self-certify
that Claude reviewed the change. Therefore:

- Cross-agent transport emits append-only route events.
- Codex may reference a route event, but cannot set `actor_verified`.
- The gate computes actor verification by joining the phase record to the route
  event.
- Claude phase execution is proved separately by executor events.

This is what turns "Claude reviewed this" from a prose claim into an auditable
runtime fact.

## Model Placement Rationale

Layer 2 also required a model-placement discussion. The product goal was not
"use the strongest model everywhere"; it was to match each phase to the model's
strengths and failure modes.

### Codex Strengths

Codex is the right default executor because it is closest to the repository and
tool loop:

- reads and edits files directly
- applies focused patches
- runs tests, lint, and builds
- captures raw command evidence
- iterates through fixup and re-verify loops

### Codex Weaknesses

Codex should not be the only authority on completion:

- self-review can become self-approval
- weak test selection can look like valid proof
- prose summaries can overstate what was verified
- high reasoning effort can overthink vague acceptance criteria
- semantic side effects and hidden coupling need an independent reviewer

Therefore Codex is the writer and mechanical verifier, but not the sole semantic
approval authority.

### Claude Strengths

Claude is useful where ambiguity is high and mechanical verification is weak:

- semantic review
- plan critique
- evidence sufficiency checks
- hidden coupling and side-effect analysis
- stuck diagnosis
- final high-risk signoff

Claude is independent from Codex, so it reduces self-approval risk.

### Claude Weaknesses

Claude should not be used as an unbounded parallel writer in v1:

- simultaneous edits can create ownership races
- packet-only review can hallucinate repo details
- a main Claude response does not prove that the intended phase model ran
- prompt text saying "use Sonnet" does not enforce Sonnet execution

Therefore Claude is normally reviewer/advisor/signoff, not the default writer.

### Tier Placement

| Model tier | Intended use |
| --- | --- |
| GPT-5.5 Codex, xhigh | Main Codex orchestrator, task interpretation, final adjudication |
| GPT-5.3 Codex or high-effort worker | Bounded exploration, test triage, localized implementation work |
| Claude Opus | High-risk plan critique, stuck diagnosis, final signoff, holistic synthesis |
| Claude Sonnet | Default semantic review, medium-risk critique, verification-contract review |
| Claude Haiku | Cheap triage or fast-path screen, deferred from minimum v1 authority |

The resulting shape is:

- Codex main owns execution and evidence.
- Codex workers may handle bounded noisy work.
- Claude main synthesizes and adjudicates on the Claude side.
- Claude phase subagents perform specific review/signoff phases.

## Marker-Driven Subagent Routing

A later requirement refined model placement further: model choice must not be
embedded as prompt prose.

The rejected pattern was:

```yaml
executor_agent: xmux-review
executor_model: sonnet
main_model: opus
```

That is only an instruction. The main model can still answer directly.

The accepted pattern is marker-driven routing:

```text
[xmux-claude-review]
```

Hooks map the marker to the required managed phase executor:

```text
[xmux-claude-review] -> xmux-review -> Sonnet
[xmux-claude-final-signoff] -> xmux-final-signoff -> Opus
[xmux-claude-stuck] -> xmux-stuck -> Opus
```

The prompt body should contain task context, not model metadata. The runtime
registry and hooks enforce which subagent must run, and the workflow gate checks
the resulting executor event.

## Design Evolution From The Discussion

The design moved through these stages:

1. Define explicit routing between Codex, Claude, and other XMux sessions.
2. Separate synthesis mode from raw mode.
3. Reject raw tmux, teammate/MCP, and legacy pane routing as product paths.
4. Add request ids, nonces, hashes, markers, and project-local state.
5. Recognize that implementation completion requires verify and review, not only
   code edits.
6. Treat skills as instructions and runtime gates as enforcement.
7. Add workflow ledger, evidence capture, route events, and gate predicates.
8. Split phase ownership so Codex writes and Claude reviews.
9. Analyze model strengths and route phases to Codex, Sonnet, Opus, or deferred
   Haiku use.
10. Replace prompt-level model metadata with phase markers and hook-enforced
    subagent execution.

## Non-Goals

- XMux is not a general-purpose teammate/MCP router.
- XMux does not make raw tmux prompt injection a supported fallback.
- XMux does not trust an agent's prose claim of completion.
- XMux does not require every model tier in minimum v1.
- XMux does not make Claude a concurrent writer in minimum v1.

## Summary

Layer 1 makes communication explicit, wrapper-first, and auditable. Layer 2 uses
that communication path to make implementation completion evidence-backed and
role-verified. The model placement strategy is a consequence of the same product
goal: Codex executes and proves mechanical facts; Claude reviews, critiques, and
signs off where independent semantic judgment matters.
