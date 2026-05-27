---
name: xmux-send
description: "Use only when the user explicitly invokes $xmux-send or $xmux-send! as the first token of the prompt."
---

# xmux-send

Use `$xmux-send` as the explicit Codex-side trigger for sending prompts to
another XMux-managed Codex session through `xmux send-pane`.

Do not use this skill for general requests to message another session unless
the first token is `$xmux-send` or `$xmux-send!`.

## Trigger Grammar

- `$xmux-send <target> <instruction>`: synthesis mode. Treat the body as
  routing and synthesis instructions. Build a target-facing prompt from current
  task context and the user instruction.
- `$xmux-send! <target> <literal prompt>`: raw mode. Forward the literal body
  without synthesis.

If neither trigger is the first token, do not send anything.

## Transport Consent

The explicit first-token trigger is the user's consent for the single XMux
Codex-to-Codex transport operation in that turn. Run the exact
`xmux send-pane ...` command produced from that trigger. `xmux setup-xmux`
configures the Codex shell PATH so the bare `xmux` command resolves inside the
configured sandbox. `--transport-consent` carries the first-token consent
without a leading shell environment assignment, so Codex policy can match the
command prefix.

If the user did not start the prompt with `$xmux-send` or `$xmux-send!`, do not
run Codex-to-Codex transport. Report that the explicit trigger is required
instead of sending through another path.

## Target Rules

- Require an explicit target before sending.
- If the target is missing or ambiguous, do not send and ask for a clearer
  target.
- Mention cross-project target syntax as `<project>/<session>` when
  clarification is needed.

## Workflow

1. Parse trigger mode, target, and body.
2. In synthesis mode, generate a target-facing prompt instead of forwarding the
   trigger text verbatim.
3. Always wrap the target-visible prompt in a one-way XMux send envelope before
   delivery. The first line must be exactly `[xmux-send-message]` so the target
   pane can distinguish this from a direct user prompt.

For synthesis mode, send this full marked prompt:

```text
[xmux-send-message]

source: $xmux-send
mode: synthesis
delivery: one-way
target: <target>

<generated target-facing prompt>
```

For raw mode, send this full marked prompt:

```text
[xmux-send-message]

source: $xmux-send!
mode: raw
delivery: one-way
target: <target>

<literal prompt body>
```

Then send through the single command path:

```zsh
xmux send-pane --to <target> --prompt "<full marked prompt>" --transport-consent xmux-send --json
```

Use `--transport-consent 'xmux-send!'` for raw mode.

4. Add `--force` only when the user explicitly asks to force an override for
   self-send or a busy target.
5. Do not wait, read, summarize, or confirm target responses in the same turn.
   If the command fails, report only the delivery failure.

## Prohibited Paths

Do not use:

- raw `tmux`, `send-keys`, `paste-buffer`, or `load-buffer`
- legacy `xmux sendPane`
- teammate/MCP routing paths
- Claude transport commands such as `xmux claude send`

Codex-to-Codex sends for this skill must go through `xmux send-pane` only.
