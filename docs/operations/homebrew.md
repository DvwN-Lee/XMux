Back to [README](../../README.md)

# Homebrew Runtime

Homebrew is the primary runtime distribution path for XMux:

```zsh
brew tap DwvN-Lee/xmux
brew install xmux
```

Use the beta formula when validating an unreleased XMux build:

```zsh
brew install xmux-beta
```

The Formula only installs runtime files under Homebrew `libexec`:

```text
$(brew --prefix)/opt/xmux/libexec/
  bin/xmux
  runtime/
    codex/pane-run.py
    claude/pane-run.py
    shell/xmux.zsh
    tmux/tmux.conf
  assets/
    codex/skills/xmux-claude/
    codex/skills/xmux-send/
    claude/skills/xmux-codex/SKILL.md
  src/
    xmux/setup.js
    codex/setup.js
    claude/setup.js
  dist/
    bin/xmux-claude-harness.js
    bin/xmux-codex-harness.js
    claude/
    codex/
  share/zsh/site-functions/_xmux
```

The public `$(brew --prefix)/bin/xmux` wrapper exports:

```text
XMUX_INSTALL_DIR=$(brew --prefix)/opt/xmux/libexec
```

Runtime asset lookups for shell, setup-helper, skills, and Claude/Codex harness
files derive from `XMUX_INSTALL_DIR`.

Project state remains separate from the install:

```text
XMUX_PROJECT_DIR=<project root>
XMUX_STATE_DIR=<project root>/.codex/xmux
```

XMux integration is separate from Formula installation. When XMux is used
through an Agent, the Agent runs setup and doctor before relying on the runtime:

```zsh
xmux setup-xmux
xmux doctor-xmux
```

`xmux setup-xmux` owns only XMux-managed global Codex and Claude changes:
`~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/rules/default.rules`,
`~/.agents/skills/xmux-claude`, `~/.agents/skills/xmux-send`,
`~/.claude/settings.json`, and
`~/.claude/skills/xmux-codex`. It also removes the legacy XMux-managed Claude
Code theme if that theme was previously installed or selected. Runtime state
remains project-local under `<project>/.codex/xmux`.

XMux does not inject custom Codex or Claude Code TUI colors. Runtime tmux chrome
keeps the XMux status bar, copy/drag mode style, neutral pane separator lines,
and provider-colored pane labels, while Codex and Claude Code render their own
default views.

Remove XMux-managed global integration state with:

```zsh
xmux remove-xmux
```

Refresh managed skills and hooks from the installed bundle with:

```zsh
xmux setup-xmux --refresh
```

Do not use legacy skill or hook install commands for the current harness. The
supported public setup surface is `xmux setup-xmux`, `xmux doctor-xmux`, and
`xmux remove-xmux`.

Legacy MCP/team state is reviewed and removed through a separate command:

```zsh
xmux cleanup-legacy --dry-run
xmux cleanup-legacy
```

The cleanup command is intentionally scoped to XMux-owned legacy paths. It can
remove old `~/.codex/skills/xmux-claude/` assets, legacy Codex agent proxy
roles under `~/.codex/agents/xmux_*.toml` when they carry the
`# XMUX_MANAGED_AGENT` marker, obsolete `.agents/skills/xmux-*` provider
symlinks, and old project `teams/` state. It does not remove non-XMux Codex
agents, non-XMux skills, or user plugin registries.

Project archives are preserved by default. Use `--purge-archive` only when the
old logs are no longer needed.
