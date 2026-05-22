#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "src", "xmux", "setup.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-setup-cleanup-skills-"));
const fakeHome = path.join(tempRoot, "home");
const codexHome = path.join(tempRoot, "codex-home");
const project = path.join(tempRoot, "project");
const skillsRoot = path.join(fakeHome, ".agents", "skills");

function makeManagedSkill(name) {
  const skillDir = path.join(skillsRoot, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  fs.writeFileSync(path.join(skillDir, ".xmux-managed-skill"), "test\n", "utf8");
}

try {
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  makeManagedSkill("xmux-claude");
  makeManagedSkill("xmux-send");
  makeManagedSkill("xmux-obsolete");

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--cleanup-legacy",
      "--dry-run",
      "--home", codexHome,
      "--project", project,
      "--xmux-install-dir", repoRoot,
    ],
    {
      cwd: project,
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
    `cleanup dry-run should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stdout.includes("xmux-obsolete"), true, "obsolete managed skill should be cleanup candidate");
  assert.equal(result.stdout.includes("xmux-send"), false, "current xmux-send skill should not be cleanup candidate");
  assert.equal(result.stdout.includes("xmux-claude"), false, "current xmux-claude skill should not be cleanup candidate");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("xmux setup cleanup skill tests passed");
