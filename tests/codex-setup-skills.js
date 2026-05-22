#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "src", "codex", "setup.js");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-codex-skills-"));
const fakeHome = path.join(tempRoot, "home");
const codexHome = path.join(fakeHome, ".codex");
const sourceRoot = path.join(tempRoot, "skills-source");

function makeSkill(name) {
  const skillDir = path.join(sourceRoot, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
}

makeSkill("xmux-claude");
makeSkill("xmux-send");
makeSkill("xmux-extra");

function runSetup(extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--with-skills",
      "--home", codexHome,
      "--skills-dir", sourceRoot,
      "--xmux-install-dir", repoRoot,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: fakeHome,
      },
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `setup should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const first = runSetup();
assert.equal(first.stdout.includes("skills: xmux-claude"), true, "first install should report installed skills");

const skillsRoot = path.join(fakeHome, ".agents", "skills");
assert.deepEqual(
  fs.readdirSync(skillsRoot).sort(),
  ["xmux-claude", "xmux-send"],
  "only allowlisted XMux skills should be installed",
);
for (const name of ["xmux-claude", "xmux-send"]) {
  const skillDir = path.join(skillsRoot, name);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), true, `${name} should have SKILL.md`);
  assert.equal(
    fs.existsSync(path.join(skillDir, ".xmux-managed-skill")),
    true,
    `${name} should be marked as XMux-managed`,
  );
}
assert.equal(fs.existsSync(path.join(skillsRoot, "xmux-extra")), false, "non-public XMux skills are ignored");

const refreshed = runSetup(["--refresh"]);
assert.equal(
  refreshed.stdout.includes("skills: xmux-claude, xmux-send"),
  true,
  "refresh should reinstall both public XMux skills",
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("codex setup skill tests passed");
