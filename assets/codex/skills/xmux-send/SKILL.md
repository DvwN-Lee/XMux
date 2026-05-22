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
3. Send through the single command path:

```zsh
xmux send-pane <target> --json -- "<generated prompt>"
```

For raw mode, send the literal body:

```zsh
xmux send-pane <target> --json -- "<literal prompt>"
```

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
