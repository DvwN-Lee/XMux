Back to [README](../../README.md)

# XMux Codex Lead

XMux starts Codex as the lead process through `xmux codex pane-run`. Claude Code
is the only supported communication target in the hook harness model, and Codex
reaches it only through the `xmux claude ...` entrypoint.

## Runtime Paths

XMux path variables are split by responsibility:

- `XMUX_INSTALL_DIR`: XMux install directory, normally the Homebrew `libexec`
  path at `$(brew --prefix)/opt/xmux/libexec`.
- `XMUX_PROJECT_DIR`: project root where Codex is working.
- `XMUX_STATE_DIR`: project-local runtime state, usually
  `$XMUX_PROJECT_DIR/.codex/xmux`.

Unified session state is stored under:

```text
<project>/.codex/xmux/sessions/
  codex--<name>.json
  claude--<name>.json
```

These files share the `xmux.session.v1` schema and use the `role` field to
distinguish Codex and Claude. Each side writes only its own role file; pair
files containing both sides are intentionally not used.

Claude harness state is stored under:

```text
<project>/.codex/xmux/claude/
  requests/<request_id>.json
  events.jsonl
```

Codex pane harness state is stored under:

```text
<project>/.codex/xmux/codex/
  events.jsonl
```

## Usage

Use the executable XMux entrypoint installed by Homebrew. For beta validation,
install `xmux-beta` instead of `xmux`.

```zsh
brew tap DwvN-Lee/xmux
brew install xmux
```

When an Agent prepares XMux for use, it owns the integration check:

```zsh
xmux setup-xmux
xmux doctor-xmux
```

Start Codex from the target project directory:

```zsh
xmux -n refactor
```

Inside Codex, Claude work must be explicitly triggered by the user:

```text
$xmux-claude 지금까지 작업한 사항을 정리해서 Claude에게 분석 요청
```

Codex treats the text after `$xmux-claude` as synthesis intent. It builds a
Claude-facing prompt and sends it through:

```zsh
xmux claude send --trigger xmux-claude --title "<request title>" --prompt "<generated Claude-facing prompt>" --quiet
```

`--title` labels the request in XMux metadata and status output; it is not part
of the pane-visible Claude prompt.

`xmux claude send` verifies the global Claude hook/skill integration, creates
the right-side Claude Code TUI pane when needed, and then injects a visible source-based
request marker through the pane runner:

```text
[xmux-codex-request]

<generated Claude-facing prompt>
```

Request IDs, nonces, hashes, and correlation metadata are kept in XMux
JSON/session state rather than shown in the pane.

Raw forwarding is allowed only through the explicit bang trigger:

```text
$xmux-claude! Send this exact prompt to Claude.
```

## Architecture

The Claude harness uses three gates:

1. The Codex skill only activates when the first token is `$xmux-claude` or
   `$xmux-claude!`.
2. `xmux claude send` requires `--trigger xmux-claude` or
   `--trigger xmux-claude!`, then creates request metadata, nonce, and prompt
   hash before invoking the configured non-paste transport backend.
3. Claude Code hooks validate `[xmux-codex-request]` against active
   project-local request metadata before accepting the visible prompt body.

The pane-visible command contains the Claude-facing prompt. Request IDs,
nonces, hashes, and correlation metadata stay in XMux JSON/session state:

```text
[xmux-codex-request]

<Claude-facing prompt>
```

`UserPromptSubmit` validates the active request, nonce, session binding, and
prompt hash against the volatile in-memory body. `Stop` records response
metadata only when the session has an active request accepted through
`[xmux-codex-request]`, then injects a Claude response marker back into the
active Codex TUI:

```text
[xmux-claude-response]

<Claude response body>
```

Codex `UserPromptSubmit` hooks validate that marker against pending response
metadata, clear the pending response, and let the clean prompt pass through for
Codex to process. Invalid commands are blocked or ignored without response
delivery.

## Transport Policy

The default implementation uses interactive split-pane TUIs for both sides.
XMux may use tmux to create, tag, and focus panes, but prompt transport goes
through pane runners, state-scoped Unix sockets, and direct PTY writes:

- `xmux codex pane-run` owns the Codex TUI PTY.
- `xmux claude pane-run` owns the Claude Code TUI PTY.

If a socket transport backend is unavailable, the command fails loudly or records
a delivery failure instead of falling back to pane paste.

The Claude harness must not use:

- MCP tools or `write_to_lead`
- teammate/team/provider routing
- `xmux sendPane`
- raw `tmux`
- `tmux load-buffer`, `paste-buffer`, or `send-keys` for prompt injection

Legacy teammate commands are disabled at the `xmux` dispatch layer in this
branch. They are not valid communication paths for Codex-to-Claude work.
