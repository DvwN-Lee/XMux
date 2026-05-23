Back to [README](../../README.md)

# XMux Skills

XMux carries only the protocol assets required for its Codex/Claude harness
surfaces. Skills are not a separate public install surface in the 2.x model.

Run the single integration command:

```zsh
xmux setup-xmux
```

This refreshes XMux-managed global assets:

```text
~/.agents/skills/xmux-claude/
~/.agents/skills/xmux-send/
~/.claude/skills/xmux-codex/
```

The Codex skill is sourced from the installed bundle:

```text
<XMUX_INSTALL_DIR>/assets/codex/skills/xmux-claude/
<XMUX_INSTALL_DIR>/assets/codex/skills/xmux-send/
```

The Claude skill is sourced from:

```text
<XMUX_INSTALL_DIR>/assets/claude/skills/xmux-codex/SKILL.md
```

Codex skill triggers are explicit-first-token only:

- `$xmux-claude` / `$xmux-claude!` for Claude harness routing.
- `$xmux-send <target> <instruction>` / `$xmux-send! <target> <literal prompt>`
  for Codex-to-Codex sends through `xmux send-pane <target> --json -- ...`.
  Delivered prompts are marked with `[xmux-send-message]` and `delivery:
  one-way`; use `<project>/<session>` for cross-project targets.

Both destinations are protected by `.xmux-managed-skill` marker files. Setup
refuses to overwrite a user-created asset with the same name unless the
destination is already marked as XMux-managed.

Refresh managed assets:

```zsh
xmux setup-xmux --refresh
```

Preview changes without writing:

```zsh
xmux setup-xmux --dry-run
```

Remove XMux-managed global assets:

```zsh
xmux remove-xmux
```

Legacy XMux 1.x skill and Codex agent-proxy locations are not refreshed by
`setup-xmux`. Review and remove them separately:

```zsh
xmux cleanup-legacy --dry-run
xmux cleanup-legacy
```

This cleanup removes only XMux-managed legacy assets, such as the old
`~/.codex/skills/xmux-claude/` install, `.xmux-skills.json`, legacy
`~/.codex/agents/xmux_*.toml` proxy roles with `# XMUX_MANAGED_AGENT`, and
obsolete `.agents/skills/xmux-*` provider symlinks. Non-XMux skills, agents,
and plugin registries are left untouched.

Runtime request and response state is never stored globally. It stays under the
active project:

```text
<project>/.codex/xmux/
```
