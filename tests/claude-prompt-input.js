#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { main: claudeMain } = require("../src/claude/cli");
const { main: codexMain, sendPromptToSession } = require("../src/codex/cli");
const { writeUnifiedSession } = require("../src/xmux/session-state");

function nowTs() {
  return new Date().toISOString();
}

function writeBusySession(root, socketPath, busyField) {
  const session = {
    schema: "xmux.codex.session.v1",
    name: "target",
    active: true,
    pane: "%9",
    socket_path: socketPath,
    updated_at: nowTs(),
  };
  if (busyField === "active_request") {
    session.active_request = "req-active";
  } else if (busyField === "pending_request") {
    session.pending_request = {
      request_id: "req-pending",
      set_at: nowTs(),
    };
  } else if (busyField === "pending_response") {
    session.pending_response = {
      request_id: "req-pending-response",
      set_at: nowTs(),
    };
  }
  writeUnifiedSession("codex", session, root);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-prompt-input-"));
const promptFile = path.join(tempRoot, "prompt.md");
fs.writeFileSync(promptFile, "hello\n", "utf8");

const originalStateDir = process.env.XMUX_STATE_DIR;
const originalConsent = process.env.XMUX_TRANSPORT_CONSENT;
const originalError = console.error;
const errors = [];

process.env.XMUX_STATE_DIR = tempRoot;
console.error = (message) => errors.push(String(message));

claudeMain([
  "send",
  "--trigger",
  "xmux-claude",
  "--prompt",
  "hello",
]).then((code) => {
  assert.equal(code, 1);
  assert.equal(errors.some((message) => message.includes("first-token trigger transport consent")), true);
  errors.length = 0;
  process.env.XMUX_TRANSPORT_CONSENT = "xmux-claude";
  return claudeMain([
  "send",
  "--trigger",
  "xmux-claude",
  "--prompt-file",
  promptFile,
  "--dry-run",
  ]);
}).then((code) => {
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
}).then(async () => {
  const socketPath = path.join(tempRoot, "codex-target.sock");
  const eventsFile = path.join(tempRoot, "codex", "events.jsonl");
  const originalCreateConnection = net.createConnection;
  try {
    for (const busyField of ["active_request", "pending_request", "pending_response"]) {
      writeBusySession(tempRoot, socketPath, busyField);
      fs.writeFileSync(socketPath, "", "utf8");
      const response = await sendPromptToSession({
        root: tempRoot,
        name: "target",
        prompt: "hello",
      });
      assert.equal(response.ok, false, `${busyField} should reject non-forced send`);
      assert.equal(response.status, "peer_busy", `${busyField} should return peer_busy`);
      assert.equal(response.error.includes("--force"), true, `${busyField} should describe force override`);
      fs.unlinkSync(socketPath);
    }

    writeBusySession(tempRoot, socketPath, "active_request");
    fs.writeFileSync(socketPath, "", "utf8");
    let seenPayload = {};
    net.createConnection = () => {
      const socket = new EventEmitter();
      socket.setEncoding = () => {};
      socket.destroy = () => {};
      socket.write = (chunk) => {
        const line = String(chunk || "").split("\n")[0];
        seenPayload = JSON.parse(line || "{}");
        process.nextTick(() => {
          socket.emit("data", JSON.stringify({ ok: true, status: "sent" }));
          socket.emit("end");
        });
      };
      process.nextTick(() => socket.emit("connect"));
      return socket;
    };

    const forced = await sendPromptToSession({
      root: tempRoot,
      name: "target",
      prompt: "hello force",
      clear: true,
      enter: false,
      force: true,
      origin: "send-pane",
    });
    assert.equal(forced.ok, true, "forced send should bypass peer_busy");
    assert.equal(forced.status, "sent");
    assert.equal(seenPayload.type, "prompt");
    assert.equal(seenPayload.prompt, "hello force");
    assert.equal(seenPayload.clear, true);
    assert.equal(seenPayload.enter, false);
    fs.unlinkSync(socketPath);

    const events = fs.readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const injected = events.find((entry) => entry.event === "codex.prompt.injected");
    assert.ok(injected, "codex.prompt.injected should be recorded");
    assert.equal(injected.data.session, "target");
    assert.equal(injected.data.origin, "send-pane");
    assert.equal(injected.data.forced, true);
  } finally {
    net.createConnection = originalCreateConnection;
  }
}).finally(() => {
  console.error = originalError;
  if (originalStateDir === undefined) delete process.env.XMUX_STATE_DIR;
  else process.env.XMUX_STATE_DIR = originalStateDir;
  if (originalConsent === undefined) delete process.env.XMUX_TRANSPORT_CONSENT;
  else process.env.XMUX_TRANSPORT_CONSENT = originalConsent;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}).then(() => {
  console.log("prompt input tests passed");
}).catch((error) => {
  console.error = originalError;
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
