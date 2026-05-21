# Changelog

## 2.0.3-beta.4 - 2026-05-22

- Delayed the Claude pane Enter key after bracketed paste injection so current
  Claude Code TUI versions submit XMux requests instead of leaving them staged
  in the input box.
- Preserved the `XMUX_CLAUDE_ENTER_DELAY` override while keeping the shorter
  delay for non-bracketed prompt injection.

## 2.0.3-beta.3 - 2026-05-21

- Moved Claude and Codex session records into a unified
  `.codex/xmux/sessions/<role>--<name>.json` collection while keeping each side
  as a single-writer file.
- Added migration and legacy mirror support so existing per-role session files
  continue to work during setup and cleanup.
- Hardened Codex hook pending-session resolution so duplicate response or
  request titles across active sessions are treated as ambiguous instead of
  routing to the newest pending session.
- Preserved failed legacy session migration inputs during `cleanup-legacy`
  instead of deleting unreadable or invalid files.
- Removed `--prompt-file` from Claude/Codex prompt input surfaces and updated
  docs, completion, and tests around the supported `--prompt`/`--stdin` paths.

## 2.0.3-beta.2 - 2026-05-21

- Persisted Claude pane-run exits back to session state so natural Claude TUI
  exits no longer leave `active: true` zombie sessions behind.
- Preserved pane-run signal exits separately from numeric exit codes and kept
  pane/socket audit fields while adding exit markers for stale runtime cleanup.
- Guarded pane-run cleanup against Stop hook races, already-terminal requests,
  missing request files, and stale launch IDs from previous pane processes.
- Cleared prior exit markers when a Claude pane starts again so active session
  status does not report stale shutdown metadata.

## 2.0.3-beta.1 - 2026-05-21

- Fixed `xmux-claude` split-pane bootstrap when Codex invokes tools without a
  live `TMUX_PANE` environment by falling back to the active XMux Codex session
  state.
- Marked stale Claude pane sessions at status time when the recorded tmux pane
  or pane-run socket no longer exists, so recovery can start a fresh right-side
  Claude pane.
- Stripped stale XMux stable and beta Homebrew `libexec/bin` paths from Codex
  shell policy updates after upgrades or formula switches.
- Added diagnostics for duplicated Codex hooks and relative plugin-cache hook
  commands that can shadow XMux-managed global hooks.
- Documented the Homebrew runtime boundary and the Agent-owned setup/doctor
  flow for beta validation.

## 2.0.1 - 2026-05-15

- Replaced public setup commands with the single `xmux setup-xmux`,
  `xmux doctor-xmux`, and `xmux remove-xmux` integration surface.
- Moved Claude hook and `xmux-codex` skill installation to global
  `~/.claude/settings.json` and `~/.claude/skills/xmux-codex`, while keeping
  runtime request state project-local under `.codex/xmux`.
- Added a first-pass `xmux claude ...` hook harness path with project-local
  Claude session, request, prompt, and response state.
- Added split-pane Claude Code TUI transport through `xmux claude pane-run`,
  using a state-scoped Unix socket and PTY writes instead of tmux paste
  commands.
- Reworked the public `xmux-claude` skill to require explicit `$xmux-claude`
  or `$xmux-claude!` triggers and route only through `xmux claude send`.
- Replaced the Claude protocol template with a hook/envelope protocol that does
  not require `write_to_lead`.
- Disabled user-reachable legacy teammate and pane-injection commands in the
  `xmux` dispatcher for this harness path.
- Changed Codex setup to remove legacy `xmux_lead` MCP config and install only
  shell integration, command rules, and the Claude skill surface.
- Documented the Claude harness model and prohibited MCP, teammate, and pane
  paste communication paths for Codex-to-Claude requests.
- Added Claude harness troubleshooting docs for split-pane TUI, socket
  transport, hooks, request state, and recovery.
- Fixed Codex pane discovery from tool-shell invocations so Claude responses
  route back to the active XMux Codex session instead of a stale inherited
  session name.
- Fixed stale Codex session routing for `/xmux-codex` Claude-to-Codex cycles
  after session restarts or Homebrew upgrades.
- Cleared Claude outbound request state when Codex-to-Claude response delivery
  fails, preventing stale active-cycle errors from blocking later requests.

## 1.3.0 - 2026-05-10

XMux 1.3.0 stabilizes the SRP distribution baseline. Homebrew owns the XMux
terminal runtime and setup helpers, npm owns MCP lead/bridge/mailbox execution,
and GitHub owns source, documentation, public skill source, and release
artifacts.

### New Features

- Added explicit public Codex skill management with `xmux install-skills` and
  `xmux remove-skills`.
- Added copy-based skill installation from Homebrew-installed public skill
  sources under `share/xmux/skills`.
- Added explicit GitHub release skill fetch support through
  `xmux install-skills --from-github --ref <tag>`.

### Improvements

- Made `xmux setup-codex` prepare a versioned npm package cache for MCP
  execution.
- Configured Codex MCP commands to run cached package binaries directly.
- Kept public skills opt-in and copy-installed; XMux does not symlink public
  skills into Codex.
- Clarified the distribution boundary between Homebrew, npm, GitHub, and public
  skills.

### Bug Fixes

- Fixed MCP startup reliability for `xmux_lead` and provider bridges.
- Prevented stale npm package cache reuse by validating the cached
  `xmux-bridge` version against the active XMux release.
- Improved `xmux doctor-codex` so it verifies actual MCP initialize readiness
  instead of only checking configuration text.

### Documentation

- Reworked active release notes around the 1.3.0 distribution baseline.
- Archived pre-1.3 implementation and hotfix history outside the active
  changelog.
- Clarified that public skills are optional copy-installed shortcuts.
- Clarified that runtime operation must not depend on checkout paths.

### Upgrade Notes

After upgrading, run:

```zsh
brew update
brew reinstall dwvn-lee/xmux/xmux
xmux setup-codex
xmux doctor-codex
```

Expected checks:

```text
xmux 1.3.0
[OK] xmux_lead MCP initialize probe succeeded
[OK] mcp package cache: ... (1.3.0)
```

Restart Codex after setup so the MCP client reloads the updated configuration.
