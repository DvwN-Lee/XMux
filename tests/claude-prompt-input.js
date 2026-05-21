#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { main: claudeMain } = require("../src/claude/cli");
const { main: codexMain } = require("../src/codex/cli");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-prompt-input-"));
const promptFile = path.join(tempRoot, "prompt.md");
fs.writeFileSync(promptFile, "hello\n", "utf8");

const originalStateDir = process.env.XMUX_STATE_DIR;
const originalError = console.error;
const errors = [];

process.env.XMUX_STATE_DIR = tempRoot;
console.error = (message) => errors.push(String(message));

claudeMain([
  "send",
  "--trigger",
  "xmux-claude",
  "--prompt-file",
  promptFile,
  "--dry-run",
]).then((code) => {
  assert.equal(code, 1);
  assert.equal(errors.some((message) => message.includes("provide --prompt or --stdin")), true);
  errors.length = 0;
  return codexMain([
    "send",
    "--prompt-file",
    promptFile,
  ]);
}).then((code) => {
  assert.equal(code, 1);
  assert.equal(errors.some((message) => message.includes("provide --prompt or --stdin")), true);
}).finally(() => {
  console.error = originalError;
  if (originalStateDir === undefined) delete process.env.XMUX_STATE_DIR;
  else process.env.XMUX_STATE_DIR = originalStateDir;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}).then(() => {
  console.log("prompt input tests passed");
}).catch((error) => {
  console.error = originalError;
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
