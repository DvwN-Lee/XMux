#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertSkillContentUsesConsent(name, trigger, command, skill, agent) {
  for (const [label, content] of [["SKILL.md", skill], ["agents/openai.yaml", agent]]) {
    const unescaped = content.replace(/\\"/g, '"');
    assert.equal(
      unescaped.includes(`--transport-consent ${trigger}`) || unescaped.includes(`--transport-consent '${trigger}'`),
      true,
      `${name} ${label} should carry ${trigger} transport consent as an argv flag`,
    );
    assert.equal(
      unescaped.includes(`xmux ${command}`),
      true,
      `${name} ${label} should call bare xmux ${command}`,
    );
    assert.equal(
      unescaped.includes("XMUX_TRANSPORT_CONSENT="),
      false,
      `${name} ${label} should not put transport consent before the xmux command`,
    );
    assert.equal(
      unescaped.includes("$XMUX_INSTALL_DIR/bin/xmux"),
      false,
      `${name} ${label} should not use the old templated xmux wrapper`,
    );
    assert.equal(
      /(?:^|\s)["']?\/[^"'\s]*\/bin\/xmux["']?\s/.test(unescaped),
      false,
      `${name} ${label} should not use an absolute xmux wrapper`,
    );
  }
}

function assertCodexSkillUsesConsent(name, trigger, command, root) {
  const skill = fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
  const agent = fs.readFileSync(path.join(root, name, "agents", "openai.yaml"), "utf8");
  assertSkillContentUsesConsent(name, trigger, command, skill, agent);
}

const sourceSkillsRoot = path.join(repoRoot, "assets", "codex", "skills");

assertCodexSkillUsesConsent("xmux-claude", "xmux-claude", "claude send", sourceSkillsRoot);
assertCodexSkillUsesConsent("xmux-implement", "xmux-implement", "claude send", sourceSkillsRoot);
assertCodexSkillUsesConsent("xmux-send", "xmux-send", "send-pane", sourceSkillsRoot);

for (const relativePath of [
  "docs/operations/skills.md",
  "docs/operations/debugging.md",
  "docs/runtime/codex-lead.md",
]) {
  const content = read(relativePath);
  assert.equal(
    content.includes("$XMUX_INSTALL_DIR/bin/xmux"),
    false,
    `${relativePath} should document bare xmux commands instead of the old skill wrapper template`,
  );
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-skill-consent-"));
try {
  const fakeHome = path.join(tempRoot, "home");
  const codexHome = path.join(fakeHome, ".codex");
  const setup = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "src", "codex", "setup.js"),
      "--with-skills",
      "--home", codexHome,
      "--skills-dir", sourceSkillsRoot,
      "--xmux-install-dir", repoRoot,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf8",
    },
  );
  assert.equal(
    setup.status,
    0,
    `setup should install consent-gated skills in fake HOME\nstdout:\n${setup.stdout}\nstderr:\n${setup.stderr}`,
  );
  const installedRoot = path.join(fakeHome, ".agents", "skills");
  for (const name of ["xmux-claude", "xmux-implement", "xmux-send"]) {
    assert.equal(
      fs.existsSync(path.join(installedRoot, name, ".xmux-managed-skill")),
      true,
      `${name} installed skill should be XMux-managed`,
    );
  }
  assertCodexSkillUsesConsent("xmux-claude", "xmux-claude", "claude send", installedRoot);
  assertCodexSkillUsesConsent("xmux-implement", "xmux-implement", "claude send", installedRoot);
  assertCodexSkillUsesConsent("xmux-send", "xmux-send", "send-pane", installedRoot);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const claudeCli = read("src/claude/cli.js");
assert.equal(
  claudeCli.includes("opts['transport-consent']"),
  true,
  "xmux claude send should accept transport consent as an argv flag",
);
assert.equal(
  claudeCli.includes("process.env.XMUX_TRANSPORT_CONSENT"),
  true,
  "xmux claude send should keep env transport consent compatibility",
);
assert.equal(
  claudeCli.includes("first-token trigger transport consent"),
  true,
  "xmux claude send should explain the missing first-token consent",
);

const runtimeShell = read("runtime/shell/xmux.zsh");
assert.equal(
  runtimeShell.includes("--transport-consent"),
  true,
  "xmux send-pane should accept transport consent as an argv flag",
);

console.log("codex skill transport consent tests passed");
