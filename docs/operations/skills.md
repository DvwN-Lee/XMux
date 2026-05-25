Back to [README](../../README.md)

# XMux Skills

XMux carries only the protocol assets required for its Codex/Claude harness
surfaces. Skills are installed and refreshed through the main XMux integration
commands.

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

These triggers are also the consent boundary for XMux transport. When a prompt
starts with one of the explicit triggers, the Codex skill may request sandbox
escalation for the single wrapper command needed for that transport:
`$XMUX_INSTALL_DIR/bin/xmux claude send ...` for `$xmux-claude` and
`$XMUX_INSTALL_DIR/bin/xmux send-pane ...` for `$xmux-send`. Without the
explicit first-token trigger, the skill must not request escalation or send by
another route. The generated wrapper command must carry
`XMUX_TRANSPORT_CONSENT` with the matching trigger value; direct wrapper calls
without that consent marker are rejected before transport.

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

Legacy XMux skill and Codex agent-proxy locations are not refreshed by
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
