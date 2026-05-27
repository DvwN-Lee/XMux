---
name: xmux-claude
description: "Use only when the user explicitly invokes $xmux-claude or $xmux-claude! as the first token of the prompt."
---

# xmux-claude

Use `$xmux-claude` as the explicit Codex-side trigger for the XMux Claude harness.

Do not use this skill for general requests to "ask Claude" unless the user typed
`$xmux-claude` or `$xmux-claude!` as the first token of the prompt.

## Trigger Grammar

- `$xmux-claude <instruction>`: synthesis mode. Treat the user text as routing
  and synthesis instructions. Build a Claude-facing prompt from the current
  task context, relevant evidence, and the specific question Claude should
  answer.
- `$xmux-claude! <literal prompt>`: raw mode. Forward the literal prompt body
  as the Claude-facing prompt after XMux records verified request state.

If neither trigger is the first token, do not scan Claude sessions, install
hooks, start Claude, or send any prompt.

## Transport Consent

The explicit first-token trigger is the user's consent for the single XMux
Claude transport operation in that turn. Run the exact `xmux claude send ...`
command produced from that trigger. `xmux setup-xmux` configures the Codex
shell PATH so the bare `xmux` command resolves inside the configured sandbox.
`--transport-consent` carries the first-token consent without a leading shell
environment assignment, so Codex policy can match the command prefix.

If the user did not start the prompt with `$xmux-claude` or `$xmux-claude!`, do
not run Claude transport. Report that the explicit trigger is required instead
of sending through another path.

## Workflow

1. Parse only the explicit trigger and mode.
2. In synthesis mode, create a structured Claude-facing prompt. Do not forward
   the user's trigger text verbatim.
3. Send the generated prompt through the single XMux entrypoint:

```zsh
xmux claude send --trigger xmux-claude --transport-consent xmux-claude --title "<short request title>" --prompt "<generated Claude-facing prompt>" --quiet
```

`xmux claude send` installs hooks and ensures the split-pane Claude Code TUI
session before it injects the actual Claude-facing prompt into the Claude pane:

```text
[xmux-codex-request]

<generated Claude-facing prompt>
```

Request IDs, nonces, and hashes stay in XMux metadata and pane-run memory.
`--title` is a short request label for XMux metadata and status output only; it
is not used as the visible Claude prompt. The Claude hook validates the active
request state and verifies the visible prompt body against the volatile
in-memory body. XMux does not persist the prompt body in its JSON state.

For raw mode, use the explicit raw trigger:

```zsh
xmux claude send --trigger 'xmux-claude!' --transport-consent 'xmux-claude!' --raw --title "<short request title>" --prompt "<literal Claude-facing prompt>" --quiet
```

4. After `xmux claude send` succeeds, do not wait, read, summarize, or confirm
   the Claude response in the current Codex turn. End the turn. The Claude
   `Stop` hook will deliver the response back into the Codex pane as a new
   prompt that starts with:

```text
[xmux-claude-response]

<Claude response body>
```

The Codex hook validates the pending response metadata internally, then lets
the clean `[xmux-claude-response]` prompt pass through for Codex to process. If
direct delivery is unavailable, report the delivery failure instead of
inventing a response.

## Prohibited Paths

Do not use:

- `spawn_agent`
- `send_to_teammate`, `wait_teammate_response`, or `read_teammate_response`
- `xmux teammateAdd`, `xmux ensure --bridge`, or `xmux bridgeStatus`
- `xmux sendPane`
- raw `tmux`, `paste-buffer`, `load-buffer`, or `send-keys`

Claude communication must go through `xmux claude ...` only.
