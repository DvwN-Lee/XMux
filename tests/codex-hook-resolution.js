#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseResponseMarker,
  resolvePendingRequestSession,
  resolvePendingResponseSession,
} = require("../src/codex/cli");
const { writeUnifiedSession } = require("../src/xmux/session-state");

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmux-codex-hook-resolution-"));
const requestsDir = path.join(tempRoot, "claude", "requests");
const previousSessionName = process.env.XMUX_CODEX_SESSION_NAME;
const previousTeam = process.env.XMUX_TEAM;

try {
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "old",
    active: true,
    pending_response: {
      request_id: "req-old",
      response_nonce: "a".repeat(32),
      response_sha256: sha256("OLD"),
      title: "OLD",
      set_at: "2026-05-21T00:00:00.000Z",
    },
  }, tempRoot);
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "test",
    active: true,
    pending_response: {
      request_id: "req-target",
      response_nonce: "b".repeat(32),
      response_sha256: sha256("TARGET"),
      title: "TARGET",
      set_at: "2026-05-21T00:01:00.000Z",
    },
  }, tempRoot);
  writeJson(path.join(requestsDir, "req-old.json"), {
    request_id: "req-old",
    status: "responded",
    response_title: "OLD",
  });
  writeJson(path.join(requestsDir, "req-target.json"), {
    request_id: "req-target",
    status: "responded",
    response_title: "TARGET",
  });

  delete process.env.XMUX_CODEX_SESSION_NAME;
  delete process.env.XMUX_TEAM;
  assert.equal(resolvePendingResponseSession({ title: "TARGET" }, tempRoot).name, "test");

  const multilineResponse = parseResponseMarker({
    prompt: "[xmux-claude-response]\n\nTARGET\n\n---\n\n## Details\n\nbody text",
  });
  assert.equal(multilineResponse.title, "TARGET");
  assert.equal(multilineResponse.body, "TARGET\n\n---\n\n## Details\n\nbody text");
  assert.equal(
    resolvePendingResponseSession(multilineResponse, tempRoot).name,
    "test",
    "multi-line response markers should match by first response line, not whole body",
  );

  process.env.XMUX_CODEX_SESSION_NAME = "old";
  assert.equal(
    resolvePendingResponseSession({ title: "TARGET" }, tempRoot).name,
    "test",
    "marker title should override a mismatched inherited session env",
  );

  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "dup-a",
    active: true,
    pending_response: {
      request_id: "req-dup-a",
      response_nonce: "d".repeat(32),
      response_sha256: sha256("DUPLICATE TITLE"),
      title: "DUPLICATE TITLE",
      set_at: "2026-05-21T00:03:00.000Z",
    },
  }, tempRoot);
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "dup-b",
    active: true,
    pending_response: {
      request_id: "req-dup-b",
      response_nonce: "e".repeat(32),
      response_sha256: sha256("DUPLICATE TITLE"),
      title: "DUPLICATE TITLE",
      set_at: "2026-05-21T00:04:00.000Z",
    },
  }, tempRoot);
  writeJson(path.join(requestsDir, "req-dup-a.json"), {
    request_id: "req-dup-a",
    status: "responded",
    response_title: "DUPLICATE TITLE",
  });
  writeJson(path.join(requestsDir, "req-dup-b.json"), {
    request_id: "req-dup-b",
    status: "responded",
    response_title: "DUPLICATE TITLE",
  });

  delete process.env.XMUX_CODEX_SESSION_NAME;
  delete process.env.XMUX_TEAM;
  assert.equal(
    resolvePendingResponseSession({ title: "DUPLICATE TITLE" }, tempRoot),
    null,
    "duplicate response title matches across sessions should be rejected as ambiguous",
  );

  process.env.XMUX_CODEX_SESSION_NAME = "dup-a";
  assert.equal(
    resolvePendingResponseSession({ title: "DUPLICATE TITLE" }, tempRoot).name,
    "dup-a",
    "matching env session should remain authoritative when response titles are duplicated",
  );

  const body = "Please inspect unified session state.";
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "requester",
    active: true,
    pending_request: {
      request_id: "req-request",
      nonce: "c".repeat(32),
      prompt_sha256: sha256(body),
      title: "Please inspect unified session state.",
      set_at: "2026-05-21T00:02:00.000Z",
    },
  }, tempRoot);
  writeJson(path.join(requestsDir, "req-request.json"), {
    request_id: "req-request",
    status: "sent",
    title: "Please inspect unified session state.",
    prompt_sha256: sha256(body),
  });
  assert.equal(
    resolvePendingRequestSession(
      { prompt: `[xmux-claude-request]\n\n${body}` },
      { title: "Please inspect unified session state." },
      tempRoot,
    ).name,
    "requester",
  );

  const duplicateBody = "Please inspect duplicate request handling.";
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "request-dup-a",
    active: true,
    pending_request: {
      request_id: "req-request-dup-a",
      nonce: "f".repeat(32),
      prompt_sha256: sha256(duplicateBody),
      title: "Duplicate request",
      set_at: "2026-05-21T00:05:00.000Z",
    },
  }, tempRoot);
  writeUnifiedSession("codex", {
    schema: "xmux.codex.session.v1",
    name: "request-dup-b",
    active: true,
    pending_request: {
      request_id: "req-request-dup-b",
      nonce: "g".repeat(32),
      prompt_sha256: sha256(duplicateBody),
      title: "Duplicate request",
      set_at: "2026-05-21T00:06:00.000Z",
    },
  }, tempRoot);
  writeJson(path.join(requestsDir, "req-request-dup-a.json"), {
    request_id: "req-request-dup-a",
    status: "sent",
    title: "Duplicate request",
    prompt_sha256: sha256(duplicateBody),
  });
  writeJson(path.join(requestsDir, "req-request-dup-b.json"), {
    request_id: "req-request-dup-b",
    status: "sent",
    title: "Duplicate request",
    prompt_sha256: sha256(duplicateBody),
  });

  delete process.env.XMUX_CODEX_SESSION_NAME;
  delete process.env.XMUX_TEAM;
  assert.equal(
    resolvePendingRequestSession(
      { prompt: `[xmux-claude-request]\n\n${duplicateBody}` },
      { title: "Duplicate request" },
      tempRoot,
    ),
    null,
    "duplicate request title/body matches across sessions should be rejected as ambiguous",
  );

  process.env.XMUX_CODEX_SESSION_NAME = "request-dup-a";
  assert.equal(
    resolvePendingRequestSession(
      { prompt: `[xmux-claude-request]\n\n${duplicateBody}` },
      { title: "Duplicate request" },
      tempRoot,
    ).name,
    "request-dup-a",
    "matching env session should remain authoritative when request matches are duplicated",
  );
} finally {
  if (previousSessionName === undefined) delete process.env.XMUX_CODEX_SESSION_NAME;
  else process.env.XMUX_CODEX_SESSION_NAME = previousSessionName;
  if (previousTeam === undefined) delete process.env.XMUX_TEAM;
  else process.env.XMUX_TEAM = previousTeam;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("codex hook resolution tests passed");
