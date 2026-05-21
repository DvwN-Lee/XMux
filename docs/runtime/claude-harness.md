Back to [README](../../README.md)

# Claude Harness

Claude is the only Codex communication target in the hook harness model. It is
not managed as an XMux teammate and it does not use MCP.

For recovery and failure analysis, see
[Claude harness troubleshooting](../operations/claude-harness-troubleshooting.md).

## Trigger Model

Codex opens the Claude harness only when the user's prompt starts with:

```text
$xmux-claude
```

Normal mode treats the rest of the prompt as synthesis instructions. Codex builds
a Claude-facing prompt from current context and sends it through
`xmux claude send`.

Raw mode is explicit:

```text
$xmux-claude!
```

## Commands

```bash
xmux claude sessions
xmux claude start --name default
xmux claude ensure-hooks
xmux claude send --trigger xmux-claude --title "<request title>" --prompt "<generated Claude-facing prompt>" --quiet
xmux claude send-codex --trigger xmux-codex --title "<request title>" --prompt "<generated Codex-facing prompt>" --quiet
xmux claude read <request_id>
xmux claude status --to default
xmux claude stop --name default
xmux codex sessions
xmux codex ensure-hooks
xmux codex stop --name <lead-session>
```

`xmux claude send` owns request id generation, nonce generation, prompt hashing,
metadata updates under `<project>/.codex/xmux/claude`, and volatile prompt body
handoff through pane-run memory. It verifies the global Claude skill/hook
integration and ensures the named Claude Code TUI pane exists before sending.
`--title` labels the request in XMux metadata and status output; it is not part
of the pane-visible Claude prompt.

Session state lives in the unified `<project>/.codex/xmux/sessions/`
collection as `codex--<name>.json` and `claude--<name>.json`. These files share
one schema but remain one file per side, preserving single-writer-per-file
ownership.

## Hooks

`xmux codex ensure-hooks` merges XMux hooks into `~/.codex/hooks.json` and
enables Codex hooks in `~/.codex/config.toml`. Global Codex hooks resolve
project-local state from the hook payload `cwd` or the XMux-launched Codex
environment; non-XMux projects are strict no-ops and must not create
`.codex/xmux`.

`xmux claude ensure-hooks` merges XMux hooks into `~/.claude/settings.json`,
installs the global Claude skill at `~/.claude/skills/xmux-codex/SKILL.md`, and
removes the legacy XMux-managed Claude Code theme when it is present. It does
not remove unrelated user hooks, unmanaged skills, or unmanaged themes. Global
hooks resolve project-local state from the Claude hook payload `cwd`; non-XMux
projects are strict no-ops and must not create `.codex/xmux`.

XMux does not install, select, or inject custom Claude or Codex TUI colors. It
does not pass Claude Code theme settings, force truecolor environment variables,
or apply terminal foreground/background styles to the TUI panes. XMux only keeps
tmux chrome styling, including the status bar, copy/drag mode style, neutral
pane separator lines, and provider-colored pane labels, so Codex and Claude Code
render their own default views inside the panes.

- `UserPromptExpansion`: detects `/xmux-codex` as a Claude-side routing
  trigger and supplies synthesis instructions for the command.
- `UserPromptSubmit`: validates `[xmux-codex-request]` and
  `[xmux-codex-response]` markers, and provides fallback trigger context when
  slash expansion is not emitted by the TUI path.
- `Stop`: records the final assistant response only when the session has an
  active inbound XMux request accepted by `[xmux-codex-request]`, then attempts
  marker delivery to the Codex pane harness.

Invalid commands are blocked or no-ops. The marker alone is never trusted.

## Transport

The default backend is an interactive split-pane Claude Code TUI. `xmux claude
send` starts `xmux claude pane-run --name <session>` in the right-side pane when
needed, then sends a visible source-based marker through a state-scoped Unix
socket to the pane runner:

```text
[xmux-codex-request]

<generated Claude-facing prompt>
```

The socket payload carries the prompt body into pane-run memory for hash
verification. The socket path is kept short under `/tmp` and namespaced by the
XMux state root digest. The runner writes to the Claude TUI PTY directly and
submits the marker there.

Claude-originated requests start with `/xmux-codex`. Claude treats that input as
routing intent, synthesizes a Codex-facing prompt, then sends the synthesized
prompt through `xmux claude send-codex --trigger xmux-codex`.

Prompt injection through `tmux load-buffer`, `paste-buffer`, or `send-keys` is
not a valid fallback for the Claude harness.

## Return Path

Codex is also launched under a PTY-owned pane runner. `xmux codex pane-run`
records the active lead session and opens a state-scoped Unix socket. After the
Claude `Stop` hook captures a response, it calls the Codex harness and injects
only a visible response marker into the Codex TUI PTY:

```text
[xmux-claude-response]

<Claude response body>
```

Codex-originated responses to Claude-originated requests return to Claude as:

```text
[xmux-codex-response]

<Codex response body>
```

Codex and Claude hooks validate those markers against pending response metadata
and then let the clean prompt pass through for the peer to process. This is the
direct response channel; metadata and hashes remain the audit path.
