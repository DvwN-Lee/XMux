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
const tmuxSocket = "/private/tmp/tmux-501/default";

function makeSkill(name) {
  const skillDir = path.join(sourceRoot, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
}

makeSkill("xmux-claude");
makeSkill("xmux-implement");
makeSkill("xmux-send");
makeSkill("xmux-extra");

fs.mkdirSync(path.join(codexHome, "rules"), { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "rules", "default.rules"),
  [
    "# XMux wrapper. XMux skills still control operation scope.",
    'prefix_rule(pattern=["xmux"], decision="allow")',
    "",
  ].join("\n"),
  "utf8",
);

function runSetup(extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--with-skills",
      "--with-codex-permissions",
      "--home", codexHome,
      "--skills-dir", sourceRoot,
      "--tmux-socket", tmuxSocket,
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

function runDoctor(extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--doctor",
      "--home", codexHome,
      "--skills-dir", sourceRoot,
      "--tmux-socket", tmuxSocket,
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
}

const first = runSetup();
assert.equal(first.stdout.includes("skills: xmux-claude"), true, "first install should report installed skills");
assert.equal(first.stdout.includes("xmux-implement"), true, "first install should include xmux-implement");
const rulesFile = path.join(codexHome, "rules", "default.rules");
const rulesContent = fs.readFileSync(rulesFile, "utf8");
assert.equal(
  rulesContent.includes(`prefix_rule(pattern=[${JSON.stringify(path.join(repoRoot, "bin", "xmux"))}], decision="allow")`),
  true,
  "setup should allow only the configured XMux wrapper path",
);
assert.equal(
  rulesContent.includes('prefix_rule(pattern=["xmux"], decision="allow")'),
  false,
  "setup should remove legacy bare xmux allow rules",
);
const configContent = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
assert.equal(configContent.includes('sandbox_mode = "workspace-write"'), false, "setup should not keep legacy sandbox_mode");
assert.equal(configContent.includes('default_permissions = "xmux-workspace"'), true, "setup should select XMux permission profile");
assert.equal(configContent.includes(`[permissions.xmux-workspace.network.unix_sockets]\n"${tmuxSocket}" = "allow"`), true, "setup should allow the tmux socket");

const skillsRoot = path.join(fakeHome, ".agents", "skills");
assert.deepEqual(
  fs.readdirSync(skillsRoot).sort(),
  ["xmux-claude", "xmux-implement", "xmux-send"],
  "only allowlisted XMux skills should be installed",
);
for (const name of ["xmux-claude", "xmux-implement", "xmux-send"]) {
  const skillDir = path.join(skillsRoot, name);
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), true, `${name} should have SKILL.md`);
  assert.equal(
    fs.existsSync(path.join(skillDir, ".xmux-managed-skill")),
    true,
    `${name} should be marked as XMux-managed`,
  );
}
assert.equal(fs.existsSync(path.join(skillsRoot, "xmux-extra")), false, "non-public XMux skills are ignored");

fs.writeFileSync(path.join(skillsRoot, "xmux-claude", "SKILL.md"), "# stale xmux-claude\n", "utf8");
const staleDoctor = runDoctor();
assert.equal(staleDoctor.status, 1, "doctor should fail when an installed managed skill is stale");
assert.equal(
  staleDoctor.stdout.includes("stale XMux Codex skills: xmux-claude"),
  true,
  "doctor should report the stale managed skill",
);

const refreshed = runSetup(["--refresh"]);
assert.equal(
  refreshed.stdout.includes("skills: xmux-claude, xmux-implement, xmux-send"),
  true,
  "refresh should reinstall public XMux skills",
);
assert.equal(
  runDoctor().stdout.includes("stale XMux Codex skills"),
  false,
  "doctor should stop reporting stale skills after refresh reinstalls them",
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("codex setup skill tests passed");
