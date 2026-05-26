# Changelog

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
