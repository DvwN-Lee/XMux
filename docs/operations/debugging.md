Back to [README](../../README.md)

# XMux Debugging

XMux operation is wrapper-first. For the Claude hook harness, use
`xmux claude ...` and project-local request state for communication checks.
For the detailed pane/socket/hook failure matrix, see
[Claude harness troubleshooting](claude-harness-troubleshooting.md).

## Default Checks

Run wrappers through the executable XMux entrypoint. For Codex automation,
prefer `xmux <subcommand>` from the Codex shell policy PATH installed by
`xmux setup-xmux`. If that wrapper is unavailable, use
`$XMUX_INSTALL_DIR/bin/xmux`.

Useful read-only checks:

```zsh
xmux claude sessions
xmux claude status --to default
xmux claude read <request_id>
xmux codex sessions
xmux codex status --to <lead-session>
xmux sessions
xmux paneInfo <target>
xmux doctor --log-lines 0
```

Run them from the target project cwd, or set `XMUX_PROJECT_DIR` and
`XMUX_STATE_DIR`, so state resolves to the correct project.

## Communication Checks

Use a bounded real Claude check:

```zsh
xmux claude send --trigger xmux-claude --title "Plan validation" --prompt "Ask Claude to validate the current plan." --quiet
```

`xmux claude send` ensures XMux-managed hooks and the split-pane Claude TUI
session before sending `[xmux-codex-request]` plus the generated Claude-facing
prompt.
If Codex was launched through the current `xmux`, the Claude `Stop` hook sends
`[xmux-claude-response]` plus the Claude response body back through the Codex
pane harness; Codex hooks validate pending response metadata internally before
letting the clean response prompt pass through.

Inspect generated state under:

```text
.codex/xmux/claude/requests/
.codex/xmux/claude/events.jsonl
.codex/xmux/sessions/
.codex/xmux/codex/events.jsonl
```

For Codex-to-Codex operator checks, use `xmux send-pane` (socket-backed via
`xmux codex send`):

```zsh
xmux send-pane <session> -- "diagnostic prompt"
xmux send-pane <project>/<session> --clear -- "replace prompt and send"
xmux send-pane --to <session> --stdin
```

`xmux send-pane` targets only XMux-managed Codex sessions and blocks self-send
or busy targets unless `--force` is passed.

## Failure Modes

- `transport_unavailable`: the split-pane Claude TUI transport could not accept
  the marker prompt. Check `socket_path`, the pane id, and `events.jsonl`.
- `timeout`: no response was recorded before the wait deadline. The active
  request is cleared so the session is not permanently blocked.
- `codex_delivery=failed`: Claude responded, but the Codex pane harness socket
  was unavailable. Inspect request metadata and `.codex/xmux/codex` events.
- `failed`: the backend exited non-zero. Check the request JSON for `stderr`.
- Hook no-op event: the marker did not match active metadata, nonce, session,
  prompt hash, or response state.

## Prohibited Paths

Do not use raw pane injection to verify Claude communication. The following are
invalid for Codex-to-Claude work:

- `xmux sendPane`
- raw `tmux`
- `tmux load-buffer`, `paste-buffer`, or `send-keys`
- MCP request tools such as `send_to_teammate` or `write_to_lead`
- teammate recovery commands

Those paths bypass request ids, nonce validation, and hook state. `xmux
send-pane` is for Codex-to-Codex debugging only and is not a Claude transport
substitute.

## Reporting

When reporting a debug session, include:

- Command used: `xmux claude send`, `status`, or `read`.
- Request id and session name.
- Request status from the JSON state.
- Any hook no-op or backend error from `events.jsonl` or request JSON.
