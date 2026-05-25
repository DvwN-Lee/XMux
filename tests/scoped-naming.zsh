#!/usr/bin/env zsh
set -eu

ROOT="${0:A:h:h}"
source "$ROOT/runtime/shell/xmux.zsh"

fail() {
  print -ru2 -- "FAIL: $*"
  exit 1
}

expect_eq() {
  local got="$1" want="$2" label="$3"
  [[ "$got" == "$want" ]] || fail "$label: got '$got', want '$want'"
}

resolve_for() {
  XMUX_PROJECT_DIR="$1"
  XMUX_STATE_DIR="$XMUX_PROJECT_DIR/.codex/xmux"
  _xmux_resolve_start_name "$2"
}

resolve_for "$ROOT/.codex/agent-runs/scoped-naming/test" dev
expect_eq "$_XMUX_RESOLVED_RAW_NAME" "dev" "raw name"
expect_eq "$_XMUX_RESOLVED_DISPLAY_NAME" "test/dev" "display name for test"
first_internal="$_XMUX_RESOLVED_SESSION_NAME"

resolve_for "$ROOT/.codex/agent-runs/scoped-naming/test-1" dev
expect_eq "$_XMUX_RESOLVED_DISPLAY_NAME" "test-1/dev" "display name for test-1"
second_internal="$_XMUX_RESOLVED_SESSION_NAME"

[[ "$first_internal" != "$second_internal" ]] || fail "internal names should differ across projects"

for invalid in "a--b" "a/b" "a:b" "a b"; do
  if _xmux_validate_session_name "$invalid" 2>/dev/null; then
    fail "invalid display name accepted: $invalid"
  fi
done

resolve_for "$ROOT/.codex/agent-runs/scoped-naming/my-long-project-name" pane.name_1
expect_eq "$_XMUX_RESOLVED_RAW_NAME" "pane.name_1" "raw name with dot and underscore"
[[ "$_XMUX_RESOLVED_DISPLAY_NAME" == my-long-proj/pane.name_1 ]] || fail "project slug should be capped in display name"

XMUX_PROJECT_DIR="$ROOT/.codex/agent-runs/send-pane/current"
XMUX_STATE_DIR="$XMUX_PROJECT_DIR/.codex/xmux"

_xmux_require_tmux() {
  return 0
}

tmux() {
  case "$1:$2:$3" in
    list-sessions:-F:#S)
      print -r -- "xmux-scoped-wrong-project"
      return 0
      ;;
  esac
  return 1
}

_xmux_current_tmux_session() {
  print -r -- "${TEST_CURRENT_TMUX_SESSION:-}"
}

_xmux_tmux_has_session() {
  case "$1" in
    raw-unmanaged|raw-wrong-project) return 0 ;;
    *) return 1 ;;
  esac
}

_xmux_tmux_session_option() {
  case "$1:$2" in
    raw-unmanaged:@xmux-managed) print -r -- "0" ;;
    raw-wrong-project:@xmux-managed) print -r -- "1" ;;
    raw-wrong-project:@xmux-project-dir) print -r -- "$ROOT/.codex/agent-runs/send-pane/other-project" ;;
    raw-wrong-project:@xmux-display-name) print -r -- "other-project/raw-wrong-project" ;;
    xmux-scoped-wrong-project:@xmux-managed) print -r -- "1" ;;
    xmux-scoped-wrong-project:@xmux-raw-name) print -r -- "scoped-wrong-project" ;;
    xmux-scoped-wrong-project:@xmux-project-dir) print -r -- "$ROOT/.codex/agent-runs/send-pane/scoped-other-project" ;;
    xmux-scoped-wrong-project:@xmux-display-name) print -r -- "scoped-other-project/scoped-wrong-project" ;;
    *) print -r -- "" ;;
  esac
}

_xmux_resolve_existing_session() {
  case "$1" in
    other)
      typeset -g _XMUX_RESOLVED_RAW_NAME="other"
      typeset -g _XMUX_RESOLVED_DISPLAY_NAME="XMux/other"
      typeset -g _XMUX_RESOLVED_SESSION_NAME="xmux-other"
      typeset -g _XMUX_RESOLVED_PROJECT_DIR="$ROOT/.codex/agent-runs/send-pane/other"
      return 0
      ;;
    current)
      typeset -g _XMUX_RESOLVED_RAW_NAME="current"
      typeset -g _XMUX_RESOLVED_DISPLAY_NAME="XMux/current"
      typeset -g _XMUX_RESOLVED_SESSION_NAME="xmux-current"
      typeset -g _XMUX_RESOLVED_PROJECT_DIR="$XMUX_PROJECT_DIR"
      return 0
      ;;
  esac
  return 1
}

_xmux_cmd_codex_harness() {
  print -r -- "PROJECT=$XMUX_PROJECT_DIR"
  print -r -- "STATE=$XMUX_STATE_DIR"
  print -r -- "ORIGIN=$XMUX_CODEX_SEND_ORIGIN"
  print -r -- "ARGS=$*"
}

expect_contains() {
  local got="$1" want="$2" label="$3"
  [[ "$got" == *"$want"* ]] || fail "$label: expected '$got' to contain '$want'"
}

if _xmux_cmd_send_pane other -- "hello world" >/dev/null 2>&1; then
  fail "send-pane should require XMux trigger transport consent"
fi

export XMUX_TRANSPORT_CONSENT=xmux-send

out="$(_xmux_cmd_send_pane other --clear --no-enter -- "hello world")"
expect_contains "$out" "PROJECT=$ROOT/.codex/agent-runs/send-pane/other" "target project rewrite"
expect_contains "$out" "STATE=$ROOT/.codex/agent-runs/send-pane/other/.codex/xmux" "target state rewrite"
expect_contains "$out" "ORIGIN=send-pane" "origin"
expect_contains "$out" "ARGS=send --to other --origin send-pane --clear --no-enter --prompt hello world" "codex send args"

out="$(_xmux_cmd_send_pane --to other --prompt "explicit text")"
expect_contains "$out" "ARGS=send --to other --origin send-pane --prompt explicit text" "explicit form args"

out="$(_xmux_cmd_send_pane --to other --json --prompt "json text")"
expect_contains "$out" "ARGS=send --to other --origin send-pane --json --prompt json text" "json passthrough args"

out="$(print -rn -- "stdin text" | _xmux_cmd_send_pane --to other --stdin)"
expect_contains "$out" "ARGS=send --to other --origin send-pane --stdin" "stdin args"

if TMUX_PANE="%1" XMUX_CODEX_SESSION_NAME="current" TEST_CURRENT_TMUX_SESSION="xmux-current" _xmux_cmd_send_pane current -- "self" >/dev/null 2>&1; then
  fail "self-send should require --force"
fi

out="$(TMUX_PANE="%1" XMUX_CODEX_SESSION_NAME="current" TEST_CURRENT_TMUX_SESSION="xmux-current" _xmux_cmd_send_pane current --force -- "self")"
expect_contains "$out" "ARGS=send --to current --origin send-pane --force --prompt self" "forced self-send args"

if _xmux_cmd_send_pane missing -- "hello" >/dev/null 2>&1; then
  fail "missing target should fail"
fi

if out="$(_xmux_cmd_send_pane --to missing --json --prompt "hello" 2>/dev/null)"; then
  fail "missing target with --json should fail"
fi
expect_contains "$out" "\"ok\":false" "json error ok flag"
expect_contains "$out" "\"status\":\"failed\"" "json error status"
expect_contains "$out" "\"error\":\"XMux Codex session 'missing' was not found in this project.\"" "json error message"

if out="$(_xmux_cmd_send_pane --to raw-unmanaged --json --prompt "hello" 2>/dev/null)"; then
  fail "unmanaged tmux target with --json should fail"
fi
expect_contains "$out" "\"error\":\"tmux session 'raw-unmanaged' exists but is not managed by XMux.\"" "unmanaged tmux diagnostic"

if out="$(_xmux_cmd_send_pane --to raw-wrong-project --json --prompt "hello" 2>/dev/null)"; then
  fail "wrong project target with --json should fail"
fi
expect_contains "$out" "\"error\":\"XMux session 'other-project/raw-wrong-project' belongs to project '$ROOT/.codex/agent-runs/send-pane/other-project'.\"" "wrong project diagnostic"

if out="$(_xmux_cmd_send_pane --to scoped-wrong-project --json --prompt "hello" 2>/dev/null)"; then
  fail "scoped wrong project target with --json should fail"
fi
expect_contains "$out" "\"error\":\"XMux session 'scoped-other-project/scoped-wrong-project' belongs to project '$ROOT/.codex/agent-runs/send-pane/scoped-other-project'.\"" "scoped raw-name wrong project diagnostic"

print -r -- "scoped naming tests passed"
