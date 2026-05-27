#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  ensureCodexShellEnvironment,
  isXmuxOwnedBinPath,
  pathWithXmuxBin,
  xmuxCommandBinForInstallDir,
  removeCodexShellEnvironment,
} = require("../src/codex/setup");

const installDir = "/opt/homebrew/opt/xmux/libexec";
const installBin = `${installDir}/bin`;
const intelInstallDir = "/usr/local/opt/xmux/libexec";
const cellarInstallDir = "/opt/homebrew/Cellar/xmux/1.0.3/libexec";
const cellarCommandBin = "/opt/homebrew/Cellar/xmux/1.0.3/bin";
const staleBetaCellar = "/opt/homebrew/Cellar/xmux-beta/2.0.2-beta.6/libexec/bin";
const staleBetaCellarWrapper = "/opt/homebrew/Cellar/xmux-beta/2.0.2-beta.6/bin";
const staleBetaOpt = "/opt/homebrew/opt/xmux-beta/libexec/bin";
const staleStableCellar = "/opt/homebrew/Cellar/xmux/2.0.1/libexec/bin";
const staleStableCellarWrapper = "/opt/homebrew/Cellar/xmux/2.0.1/bin";
const nodeCellar = "/opt/homebrew/Cellar/node/26.0.0/bin";
const homebrewBin = "/opt/homebrew/bin";
const intelHomebrewBin = "/usr/local/bin";
const localBin = "/Users/example/.local/bin";
const localInstallDir = "/Users/example/xmux";

assert.equal(isXmuxOwnedBinPath(staleBetaCellar, installBin), true, "stale beta Cellar path is XMux-owned");
assert.equal(isXmuxOwnedBinPath(staleBetaCellarWrapper, installBin), true, "stale beta Cellar wrapper path is XMux-owned");
assert.equal(isXmuxOwnedBinPath(staleBetaOpt, installBin), true, "stale beta opt path is XMux-owned");
assert.equal(isXmuxOwnedBinPath(staleStableCellar, installBin), true, "stale stable Cellar path is XMux-owned");
assert.equal(isXmuxOwnedBinPath(staleStableCellarWrapper, installBin), true, "stale stable Cellar wrapper path is XMux-owned");
assert.equal(isXmuxOwnedBinPath(homebrewBin, installBin), false, "Homebrew bin is not XMux-owned");
assert.equal(isXmuxOwnedBinPath(nodeCellar, installBin), false, "non-XMux Cellar path is not XMux-owned");
assert.equal(isXmuxOwnedBinPath(localBin, installBin), false, "user local bin is not XMux-owned");
assert.equal(xmuxCommandBinForInstallDir(installDir), homebrewBin, "Homebrew install uses wrapper bin");
assert.equal(xmuxCommandBinForInstallDir(intelInstallDir), intelHomebrewBin, "Intel Homebrew install uses wrapper bin");
assert.equal(xmuxCommandBinForInstallDir(cellarInstallDir), cellarCommandBin, "Homebrew Cellar install uses keg wrapper bin");
assert.equal(
  xmuxCommandBinForInstallDir(localInstallDir),
  `${localInstallDir}/bin`,
  "non-Homebrew install uses install bin",
);

const mixedPath = [
  staleBetaCellar,
  staleBetaCellarWrapper,
  nodeCellar,
  staleBetaOpt,
  localBin,
  staleStableCellar,
  staleStableCellarWrapper,
  homebrewBin,
].join(":");

assert.equal(
  pathWithXmuxBin(installDir, mixedPath),
  [homebrewBin, nodeCellar, localBin].join(":"),
  "pathWithXmuxBin strips XMux-owned entries and prefers the Homebrew wrapper",
);

assert.equal(
  pathWithXmuxBin(cellarInstallDir, mixedPath),
  [cellarCommandBin, nodeCellar, localBin, homebrewBin].join(":"),
  "pathWithXmuxBin preserves a Cellar keg wrapper when setup runs from a Cellar install",
);

const config = [
  "[shell_environment_policy.set]",
  `PATH = "${mixedPath}"`,
  `XMUX_INSTALL_DIR = "${installDir}"`,
  'TMPDIR = "/tmp"',
  "",
].join("\n");

const refreshedConfig = ensureCodexShellEnvironment(config, installDir);
assert.equal(
  refreshedConfig.includes(`PATH = "${homebrewBin}:${nodeCellar}:${localBin}"`),
  true,
  "ensureCodexShellEnvironment rewrites PATH to the Homebrew wrapper",
);
assert.equal(
  refreshedConfig.includes(`XMUX_INSTALL_DIR = "${installDir}"`),
  true,
  "ensureCodexShellEnvironment preserves the Homebrew libexec install dir",
);
assert.equal(refreshedConfig.includes(installBin), false, "refreshed PATH does not include Homebrew libexec bin");

assert.equal(
  removeCodexShellEnvironment(config, installDir),
  [
    "[shell_environment_policy.set]",
    `PATH = "${nodeCellar}:${localBin}:${homebrewBin}"`,
    'TMPDIR = "/tmp"',
    "",
  ].join("\n"),
  "removeCodexShellEnvironment applies the same XMux-owned filter",
);

console.log("codex setup PATH tests passed");
