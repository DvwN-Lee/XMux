# Changelog

## 1.0.3 - 2026-05-27

- Fixed Homebrew Codex PATH setup so `xmux setup-xmux --refresh` keeps
  `/opt/homebrew/bin` as the command path while preserving
  `XMUX_INSTALL_DIR=/opt/homebrew/opt/xmux/libexec`.
- Removed stale XMux Homebrew `libexec/bin` entries from regenerated Codex
  shell PATH values to avoid shadowing the Homebrew wrapper.

## 1.0.2 - 2026-05-27

- Added the `xmux-implement` workflow ledger, evidence capture, risk
  classification, route-event provenance, and completion gate.
- Added phase markers such as `[xmux-claude-review]` and executor-event
  verification so Claude-owned phases require the configured subagent, not only
  a main Claude response.
- Added managed Claude phase agents including `xmux-review`,
  `xmux-plan-critique`, `xmux-verification-contract`, `xmux-final-signoff`, and
  `xmux-stuck`.
- Added workflow CLI commands under `xmux workflow`.

## 1.0.1 - 2026-05-26

- Fixed Homebrew Codex doctor checks so the scoped XMux command rule is matched
  against the configured Homebrew wrapper path instead of the bare `xmux`
  command.
- Reinstalled Codex skills now use the configured XMux wrapper path and doctor
  reports stale managed skills that need `xmux setup-xmux --refresh`.
- Added the Codex `xmux-workspace` permission profile so XMux skill transport
  can run inside the sandbox with only the active tmux Unix socket allowlisted.
- Changed Codex skills and transport commands to pass first-token consent with
  `--transport-consent`, keeping the absolute XMux wrapper as the policy prefix.

## 1.0.0 - 2026-05-24

Initial public release of XMux.

- Added explicit Codex-to-Claude-to-Codex communication through
  `$xmux-claude`.
- Added explicit Claude-to-Codex-to-Claude communication through
  `/xmux-codex`.
- Added XMux-to-XMux session messaging through `$xmux-send` and
  `xmux send-pane`.
- Added `xmux setup-xmux`, `xmux doctor-xmux`, and `xmux remove-xmux` for
  XMux-managed Codex and Claude integration.
- Kept runtime state project-local under `.codex/xmux`.
