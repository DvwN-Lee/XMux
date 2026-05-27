#!/usr/bin/env zsh
set -euo pipefail

repo_root="${0:A:h:h}"
if [[ -x /opt/homebrew/bin/tmux ]]; then
  path=(/opt/homebrew/bin $path)
  export PATH
fi
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/xmux-e2e.XXXXXXXXXX")"
temp_root="${temp_root:A}"
project_dir="$temp_root/xmux-e2e-project"
home_dir="$temp_root/home"
bin_dir="$temp_root/bin"
done_log="$temp_root/done.jsonl"
final_done="$temp_root/final.done"
codex_accepted="$temp_root/codex-accepted-claude-response.done"
session_started=0

cleanup() {
  if [[ "$session_started" == "1" ]]; then
    HOME="$home_dir" \
    XMUX_INSTALL_DIR="$repo_root" \
    XMUX_PROJECT_DIR="$project_dir" \
    "$repo_root/bin/xmux" stop e2e >/dev/null 2>&1 || true
  fi
  tmux set-environment -gu XMUX_CLAUDE_TUI_CMD >/dev/null 2>&1 || true
  if [[ "${XMUX_E2E_KEEP:-0}" != "1" ]]; then
    rm -rf "$temp_root"
  else
    print -u2 "preserved e2e temp root: $temp_root"
  fi
}
trap cleanup EXIT

print_debug() {
  print -u2 -- "---- e2e temp root ----"
  print -u2 -- "$temp_root"
  print -u2 -- "---- e2e done log ----"
  [[ -f "$done_log" ]] && cat "$done_log" >&2 || print -u2 -- "(missing)"
  print -u2 -- "---- e2e state files ----"
  find "$project_dir/.codex/xmux" -maxdepth 4 -type f -print 2>/dev/null >&2 || true
  print -u2 -- "---- e2e tmux panes ----"
  tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}	#{pane_id}	#{@xmux-project-dir}	#{pane_current_command}' 2>/dev/null | while IFS=$'\t' read -r target pane project command; do
    if [[ "$project" == "$project_dir" ]]; then
      print -u2 -- "-- pane $target $pane $command --"
      tmux capture-pane -pt "$pane" -S -120 2>/dev/null >&2 || true
    fi
  done
}

mkdir -p "$project_dir" "$home_dir" "$bin_dir"
mkdir -p "$project_dir/.git"

cat > "$bin_dir/fake-codex.py" <<'PY'
#!/usr/bin/env python3
import json
import os
import select
import shlex
import subprocess
import sys
import time

if len(sys.argv) != 8:
    sys.exit(9)

XMUX = sys.argv[1]
DONE = sys.argv[2]
FINAL_DONE = sys.argv[3]
ACCEPTED = sys.argv[4]
FAKE_CLAUDE = sys.argv[5]
CLAUDE_REPLY = sys.argv[6]
CODEX_REPLY = sys.argv[7]
PROJECT = os.environ["XMUX_PROJECT_DIR"]


def append(event, **fields):
    with open(DONE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, **fields}, ensure_ascii=True) + "\n")


def run_xmux(args, payload=None, timeout=20):
    env = os.environ.copy()
    result = subprocess.run(
        [XMUX, *args],
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=env,
    )
    append(
        "xmux-command",
        command=" ".join(args),
        status=result.returncode,
        stdout=result.stdout.strip(),
        stderr=result.stderr.strip(),
    )
    return result


def has_block_decision(result):
    try:
        return json.loads(result.stdout).get("decision") == "block"
    except Exception:
        return False


def normalize(text):
    return (
        text.replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
        .replace("\x15", "")
        .replace("\r", "\n")
    )


def extract_prompt(buffer, marker):
    start = buffer.find(marker)
    if start < 0:
        return "", buffer
    tail = buffer[start:]
    marker_names = ["[xmux-claude-response]", "[xmux-claude-request]", "[xmux-claude-review]", "[xmux-codex-request]", "[xmux-codex-response]"]
    ends = [tail.find(item, len(marker)) for item in marker_names if tail.find(item, len(marker)) > 0]
    end = min(ends) if ends else len(tail)
    return tail[:end].strip(), tail[end:]


version = run_xmux(["--version"], timeout=10)
if version.returncode != 0 or "xmux 1.0.4" not in version.stdout:
    sys.exit(10)

claude_cmd = " ".join(shlex.quote(item) for item in [FAKE_CLAUDE, XMUX, DONE, FINAL_DONE, ACCEPTED, CLAUDE_REPLY, CODEX_REPLY])
tmux_env = subprocess.run(
    ["tmux", "set-environment", "-g", "XMUX_CLAUDE_TUI_CMD", claude_cmd],
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=10,
)
append("tmux-set-claude-cmd", status=tmux_env.returncode, stdout=tmux_env.stdout.strip(), stderr=tmux_env.stderr.strip())
if tmux_env.returncode != 0:
    sys.exit(16)

send = run_xmux(
    [
        "claude",
        "send",
        "--to",
        "e2e",
        "--trigger",
        "xmux-claude",
        "--transport-consent",
        "xmux-claude",
        "--title",
        "E2E Codex to Claude",
        "--phase",
        "review",
        "--prompt",
        "CLAUDE_E2E_REQUEST: reply with HOOK-PONG-1.0.4",
        "--wait",
        "--timeout",
        "30",
        "--json",
    ],
    timeout=60,
)
if send.returncode != 0:
    sys.exit(11)

buffer = ""
accepted_claude_response = False
answered_claude_request = False
deadline = time.time() + 90

while time.time() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.2)
    if ready:
        chunk = os.read(sys.stdin.fileno(), 8192).decode("utf-8", errors="replace")
        buffer = normalize(buffer + chunk)

    if not accepted_claude_response and "[xmux-claude-response]" in buffer and CLAUDE_REPLY in buffer:
        prompt, buffer = extract_prompt(buffer, "[xmux-claude-response]")
        result = run_xmux(["codex", "hook", "user-prompt"], {"prompt": prompt, "cwd": PROJECT})
        if result.returncode != 0:
            sys.exit(12)
        with open(ACCEPTED, "w", encoding="utf-8") as handle:
            handle.write("ok\n")
        append("codex-accepted-claude-response", prompt=prompt)
        accepted_claude_response = True

    if not answered_claude_request and "[xmux-claude-request]" in buffer and "CODEX_E2E_REQUEST" in buffer:
        prompt, buffer = extract_prompt(buffer, "[xmux-claude-request]")
        accepted = run_xmux(["codex", "hook", "user-prompt"], {"prompt": prompt, "cwd": PROJECT})
        if accepted.returncode != 0:
            sys.exit(13)
        stopped = run_xmux(["codex", "hook", "stop"], {"last_assistant_message": CODEX_REPLY, "cwd": PROJECT})
        if stopped.returncode != 0:
            sys.exit(14)
        append("codex-answered-claude-request", prompt=prompt)
        answered_claude_request = True

    if accepted_claude_response and answered_claude_request:
        sys.exit(0)

append("codex-timeout", buffer=buffer[-2000:])
sys.exit(15)
PY

cat > "$bin_dir/fake-claude.py" <<'PY'
#!/usr/bin/env python3
import json
import os
import select
import subprocess
import sys
import time

if len(sys.argv) != 7:
    sys.exit(19)

XMUX = sys.argv[1]
DONE = sys.argv[2]
FINAL_DONE = sys.argv[3]
CODEX_ACCEPTED = sys.argv[4]
CLAUDE_REPLY = sys.argv[5]
CODEX_REPLY = sys.argv[6]
PROJECT = os.environ["XMUX_PROJECT_DIR"]


def append(event, **fields):
    with open(DONE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, **fields}, ensure_ascii=True) + "\n")


def run_xmux(args, payload=None, timeout=20):
    result = subprocess.run(
        [XMUX, *args],
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=os.environ.copy(),
    )
    append(
        "xmux-command",
        command=" ".join(args),
        status=result.returncode,
        stdout=result.stdout.strip(),
        stderr=result.stderr.strip(),
    )
    return result


def has_block_decision(result):
    try:
        return json.loads(result.stdout).get("decision") == "block"
    except Exception:
        return False


def normalize(text):
    return (
        text.replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
        .replace("\x15", "")
        .replace("\r", "\n")
    )


def extract_prompt(buffer, marker):
    start = buffer.find(marker)
    if start < 0:
        return "", buffer
    tail = buffer[start:]
    marker_names = ["[xmux-claude-review]", "[xmux-codex-request]", "[xmux-codex-response]", "[xmux-claude-request]", "[xmux-claude-response]"]
    ends = [tail.find(item, len(marker)) for item in marker_names if tail.find(item, len(marker)) > 0]
    end = min(ends) if ends else len(tail)
    return tail[:end].strip(), tail[end:]


started = run_xmux(
    ["claude", "hook", "session-start"],
    {
        "source": "startup",
        "cwd": PROJECT,
        "session_id": "fake-claude-session",
        "model": "fake-claude",
    },
)
if started.returncode != 0:
    sys.exit(20)

buffer = ""
answered_codex_request = False
sent_codex_request = False
accepted_codex_response = False
deadline = time.time() + 90

while time.time() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.2)
    if ready:
        chunk = os.read(sys.stdin.fileno(), 8192).decode("utf-8", errors="replace")
        buffer = normalize(buffer + chunk)

    if not answered_codex_request and "[xmux-claude-review]" in buffer and "CLAUDE_E2E_REQUEST" in buffer:
        prompt, buffer = extract_prompt(buffer, "[xmux-claude-review]")
        accepted = run_xmux(["claude", "hook", "user-prompt"], {"prompt": prompt, "cwd": PROJECT})
        if accepted.returncode != 0:
            sys.exit(21)
        direct_stop = run_xmux(["claude", "hook", "stop"], {"last_assistant_message": "direct main response should be blocked", "cwd": PROJECT})
        if direct_stop.returncode != 0 or not has_block_decision(direct_stop):
            sys.exit(26)
        wrong_agent = run_xmux(["claude", "hook", "pre-tool-use"], {
            "tool_name": "Agent",
            "tool_input": {"agent_type": "not-xmux-review"},
            "cwd": PROJECT,
        })
        if wrong_agent.returncode != 0 or not has_block_decision(wrong_agent):
            sys.exit(27)
        right_agent = run_xmux(["claude", "hook", "pre-tool-use"], {
            "tool_name": "Agent",
            "tool_input": {"agent_type": "xmux-review"},
            "cwd": PROJECT,
        })
        if right_agent.returncode != 0 or has_block_decision(right_agent):
            sys.exit(28)
        subagent = run_xmux(["claude", "hook", "subagent-stop"], {
            "agent_type": "xmux-review",
            "transcript_path": "",
            "cwd": PROJECT,
        })
        if subagent.returncode != 0:
            sys.exit(29)
        stopped = run_xmux(["claude", "hook", "stop"], {"last_assistant_message": CLAUDE_REPLY, "cwd": PROJECT})
        if stopped.returncode != 0:
            sys.exit(22)
        append("claude-answered-codex-request", prompt=prompt)
        answered_codex_request = True

    if answered_codex_request and not sent_codex_request and os.path.exists(CODEX_ACCEPTED):
        sent = run_xmux(
            [
                "claude",
                "send-codex",
                "--trigger",
                "xmux-codex",
                "--from",
                "e2e",
                "--to",
                "e2e",
                "--title",
                "E2E Claude to Codex",
                "--prompt",
                "CODEX_E2E_REQUEST: reply with CODEX-PONG-1.0.4",
                "--json",
            ],
            timeout=30,
        )
        if sent.returncode != 0:
            sys.exit(23)
        sent_codex_request = True

    if sent_codex_request and not accepted_codex_response and "[xmux-codex-response]" in buffer and CODEX_REPLY in buffer:
        prompt, buffer = extract_prompt(buffer, "[xmux-codex-response]")
        accepted = run_xmux(["claude", "hook", "user-prompt"], {"prompt": prompt, "cwd": PROJECT})
        if accepted.returncode != 0:
            sys.exit(24)
        with open(FINAL_DONE, "w", encoding="utf-8") as handle:
            handle.write("ok\n")
        append("claude-accepted-codex-response", prompt=prompt)
        accepted_codex_response = True
        sys.exit(0)

append("claude-timeout", buffer=buffer[-2000:])
sys.exit(25)
PY

chmod +x "$bin_dir/fake-codex.py" "$bin_dir/fake-claude.py"

version_output="$(
  HOME="$home_dir" \
  XMUX_INSTALL_DIR="$repo_root" \
  XMUX_PROJECT_DIR="$project_dir" \
  "$repo_root/bin/xmux" --version
)"
[[ "$version_output" == "xmux 1.0.4" ]] || {
  print -u2 "expected xmux 1.0.4, got: $version_output"
  exit 1
}

(
  cd "$project_dir"
  HOME="$home_dir" \
  XMUX_INSTALL_DIR="$repo_root" \
  XMUX_PROJECT_DIR="$project_dir" \
  XMUX_STATE_DIR="$project_dir/.codex/xmux" \
  "$repo_root/bin/xmux" -n e2e --codex-bin "$bin_dir/fake-codex.py" -- \
    "$repo_root/bin/xmux" \
    "$done_log" \
    "$final_done" \
    "$codex_accepted" \
    "$bin_dir/fake-claude.py" \
    "HOOK-PONG-1.0.4" \
    "CODEX-PONG-1.0.4"
)
session_started=1

session_version=""
for _ in {1..80}; do
  while IFS=$'\t' read -r _session project version; do
    if [[ "$project" == "$project_dir" ]]; then
      session_version="$version"
      break
    fi
  done < <(tmux list-sessions -F '#{session_name}	#{@xmux-project-dir}	#{@xmux-version}' 2>/dev/null || true)
  [[ "$session_version" == "1.0.4" ]] && break
  sleep 0.25
done
[[ "$session_version" == "1.0.4" ]] || {
  print -u2 "expected tmux @xmux-version 1.0.4, got: ${session_version:-missing}"
  print_debug
  exit 1
}

for _ in {1..160}; do
  [[ -f "$final_done" ]] && break
  sleep 0.25
done

[[ -f "$final_done" ]] || {
  print -u2 "timed out waiting for Codex-Claude e2e completion"
  print_debug
  exit 1
}

node - "$project_dir/.codex/xmux" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const requestsDir = path.join(root, "claude", "requests");
const requests = fs.readdirSync(requestsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(requestsDir, name), "utf8")));

const codexToClaude = requests.find((item) => item.direction === "codex_to_claude");
const claudeToCodex = requests.find((item) => item.direction === "claude_to_codex");

assert.ok(codexToClaude, "codex_to_claude request should exist");
assert.equal(codexToClaude.status, "responded");
assert.equal(codexToClaude.codex_delivery, "sent");
assert.ok(codexToClaude.codex_response_accepted_at, "Codex should accept Claude response");
assert.equal(codexToClaude.phase, "review");
assert.equal(codexToClaude.phase_marker, "[xmux-claude-review]");
assert.equal(codexToClaude.required_executor_agent, "xmux-review");
assert.ok(codexToClaude.executor_event_ref, "phase request should record executor event ref");

assert.ok(claudeToCodex, "claude_to_codex request should exist");
assert.equal(claudeToCodex.status, "closed");
assert.equal(claudeToCodex.codex_delivery, "sent");
assert.equal(claudeToCodex.claude_delivery, "sent");
assert.ok(claudeToCodex.claude_response_accepted_at, "Claude should accept Codex response");

const claudeEvents = fs.readFileSync(path.join(root, "claude", "events.jsonl"), "utf8");
const codexEvents = fs.readFileSync(path.join(root, "codex", "events.jsonl"), "utf8");
const routeEventsPath = path.join(root, "workflows", "route-events.jsonl");
assert.ok(fs.existsSync(routeEventsPath), "route event log should exist");
const routeEvents = fs.readFileSync(routeEventsPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const codexToClaudeRoute = routeEvents.find((item) => (
  item.event_id === codexToClaude.codex_to_claude_route_event_id
  && item.request_id === codexToClaude.request_id
  && item.from_lineage === "codex"
  && item.to_lineage === "claude"
  && item.marker_valid === true
));
const claudeToCodexRoute = routeEvents.find((item) => (
  item.event_id === claudeToCodex.claude_to_codex_route_event_id
  && item.request_id === claudeToCodex.request_id
  && item.from_lineage === "claude"
  && item.to_lineage === "codex"
  && item.marker_valid === true
));
assert.ok(codexToClaudeRoute, "Codex-to-Claude accepted marker should produce a route event");
assert.ok(claudeToCodexRoute, "Claude-to-Codex accepted marker should produce a route event");
assert.equal(codexToClaudeRoute.prompt_hash, codexToClaude.prompt_sha256);
assert.equal(claudeToCodexRoute.prompt_hash, claudeToCodex.prompt_sha256);
assert.equal(codexToClaudeRoute.phase_marker, "[xmux-claude-review]");
assert.equal(codexToClaudeRoute.phase, "review");
const executorEventsPath = path.join(root, "workflows", "executor-events.jsonl");
assert.ok(fs.existsSync(executorEventsPath), "executor event log should exist");
const executorEvents = fs.readFileSync(executorEventsPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const reviewExecutor = executorEvents.find((item) => (
  item.event_id === codexToClaude.executor_event_ref
  && item.request_id === codexToClaude.request_id
  && item.agent_name === "xmux-review"
  && item.phase_marker === "[xmux-claude-review]"
  && item.event === "stop"
));
assert.ok(reviewExecutor, "review phase should have a verified xmux-review subagent stop event");
for (const event of [
  "claude.request.prepared",
  "claude.hook.xmux_codex.accepted",
  "claude.hook.phase_executor.blocked",
  "claude.hook.subagent_stop.recorded",
  "claude.hook.stop.blocked",
  "claude.response.codex_delivered",
  "claude.codex_request.delivered",
  "claude.hook.codex_response.accepted",
]) {
  assert.ok(claudeEvents.includes(event), `missing Claude event ${event}`);
}
for (const event of [
  "codex.hook.claude_response.accepted",
  "codex.hook.claude_request.pass_through",
  "codex.response.claude_delivered",
]) {
  assert.ok(codexEvents.includes(event), `missing Codex event ${event}`);
}
NODE

print "codex claude e2e tests passed"
