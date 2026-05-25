# Changelog

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
