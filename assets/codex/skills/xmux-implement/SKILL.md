---
name: xmux-implement
description: "Use only when the user explicitly invokes $xmux-implement as the first token of the prompt."
---

# xmux-implement

Use `$xmux-implement` as the explicit Codex-side trigger for an evidence-gated
implementation workflow.

Do not use this skill for ordinary implementation requests unless the first
token is exactly `$xmux-implement`.

## Workflow Contract

`implement` means complete the implementation loop, not only edit files:

```text
intake -> classify-risk -> scope -> plan -> implement-core -> verify
-> Claude review -> fixup if needed -> verify.attempt++ -> review-recheck
-> finalize gate
```

Codex is the only writer in v1. Claude is used as the independent semantic
reviewer through the XMux Claude harness.

## Required Runtime Commands

Create a run before editing:

```zsh
xmux workflow start --task-ref "<short task ref>" --done-criteria "<criterion>" --json
```

Classify risk with rule-derived triggers. Codex may raise risk, never lower it:

```zsh
xmux workflow classify --run-id "<run_id>" --changed-files <n> --changed-lines <n> --trigger "<trigger>" --json
```

After implementation, record raw verification evidence. Prose-only verification
is not enough:

```zsh
xmux workflow evidence --run-id "<run_id>" --cmd "<command>" --exit-code <code> --summary "<summary>" --output-tail "<tail>" --json
```

Send a Claude review packet after verification. The first-token
`$xmux-implement` is transport consent for this workflow review handoff:

```zsh
xmux claude send --trigger xmux-claude --transport-consent xmux-implement --phase review --title "review:<run_id>" --prompt "<Claude review packet>" --json
```

The `--phase review` option emits the `[xmux-claude-review]` marker. Do not
put executor model or agent metadata in the prompt. Claude hooks map that marker
to the managed `xmux-review` subagent, and the workflow gate requires the
subagent execution event before a Claude-owned review phase can pass.

The Claude-facing review packet must include:

- `run_id`
- task and done criteria
- risk class and fired triggers
- changed files and summary
- verification evidence with command, exit code, summary, and output tail
- review questions focused on semantic correctness, side effects, and evidence
  sufficiency

After Claude responds through `[xmux-claude-response]`, record the review phase
with the request id returned by `xmux claude send`:

```zsh
xmux workflow phase --run-id "<run_id>" --phase review --owner claude --status approved --request-id "<request_id>" --evidence-sufficiency sufficient --json
```

If Claude requests changes, record each blocking finding:

```zsh
xmux workflow finding --run-id "<run_id>" --id "<finding_id>" --severity medium --type request_changes --status open --file "<path>" --line <line> --rationale "<why>" --required-fix "<fix>" --json
```

Then fix, re-verify, and record `review-recheck` through the same review route.

Before declaring completion, run the final gate:

```zsh
xmux workflow gate --run-id "<run_id>" --json
```

If the gate returns `blocked`, continue the workflow or report the blocking
reasons. Do not declare the task complete until the gate passes.

## Claude Phase Executor

- Use `--phase review` for ordinary review. The Claude hook registry maps it to
  `xmux-review`; the subagent definition owns the model choice.
- Use phase tags rather than prompt text to select phase executors.
- Do not use Haiku as authoritative review/signoff in v1.

## Prohibited Paths

Do not use:

- raw `tmux`, `send-keys`, `paste-buffer`, or `load-buffer`
- teammate/MCP routing paths
- legacy `xmux sendPane`
- Claude transport outside XMux commands

All workflow state must go through `xmux workflow ...`. Claude communication
must go through `xmux claude send ...`.
