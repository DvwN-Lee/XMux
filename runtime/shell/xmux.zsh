# runtime/shell/xmux.zsh - XMux Codex-Claude hook harness shell layer.
#
# Source this file from zsh, then run:
#   xmux [-n <session>] [-- <codex args...>]

if [[ -n "$ZSH_VERSION" ]]; then
  _XMUX_SOURCED_DIR="${${(%):-%x}:A:h}"
else
  _XMUX_SOURCED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
fi

_XMUX_SOURCE_INSTALL_DIR="$_XMUX_SOURCED_DIR"
if [[ "${_XMUX_SOURCE_INSTALL_DIR:t}" == "shell" && "${_XMUX_SOURCE_INSTALL_DIR:h:t}" == "runtime" ]]; then
  _XMUX_SOURCE_INSTALL_DIR="${_XMUX_SOURCE_INSTALL_DIR:h:h}"
fi

if [[ -n "${XMUX_INSTALL_DIR:-}" ]]; then
  XMUX_INSTALL_DIR="${XMUX_INSTALL_DIR:a}"
else
  XMUX_INSTALL_DIR="$_XMUX_SOURCE_INSTALL_DIR"
fi
export XMUX_INSTALL_DIR

if [[ -n "${XMUX_PROJECT_DIR:-}" ]]; then
  XMUX_PROJECT_DIR_EXPLICIT=1
  XMUX_PROJECT_DIR="${XMUX_PROJECT_DIR:A}"
else
  XMUX_PROJECT_DIR_EXPLICIT=0
fi

if [[ -n "${XMUX_STATE_DIR:-}" ]]; then
  XMUX_STATE_DIR_EXPLICIT=1
  XMUX_STATE_DIR="${XMUX_STATE_DIR:A}"
else
  XMUX_STATE_DIR_EXPLICIT=0
fi

XMUX_VERSION="2.0.3-beta.3"

_xmux_project_root() {
  local dir="${1:-$PWD}"
  dir="${dir:A}"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -e "$dir/.git" ]]; then
      print -r -- "$dir"
      return 0
    fi
    dir="${dir:h}"
  done
  print -r -- "${1:-$PWD}"
}

_xmux_refresh_paths() {
  if [[ "${XMUX_PROJECT_DIR_EXPLICIT:-0}" == "0" ]]; then
    XMUX_PROJECT_DIR="$(_xmux_project_root "$PWD")"
    export XMUX_PROJECT_DIR
  fi
  if [[ "${XMUX_STATE_DIR_EXPLICIT:-0}" == "0" ]]; then
    XMUX_STATE_DIR="$XMUX_PROJECT_DIR/.codex/xmux"
    export XMUX_STATE_DIR
  fi
  unset XMUX_DIR XMUX_HOME 2>/dev/null || true
}

_xmux_refresh_home() {
  _xmux_refresh_paths
}

_xmux_refresh_paths

_xmux_q() {
  printf '%q' "$1"
}

_xmux_print_version() {
  print -r -- "xmux $XMUX_VERSION"
}

_xmux_user_usage() {
  cat <<'EOF'
Usage:
  xmux -n <session> [--codex-bin <path>] [-- <codex args...>]
  xmux attach <session>
  xmux stop <session>
  xmux sessions
  xmux claude <args...>
  xmux codex <args...>
  xmux setup-xmux [--with-skills|--without-skills] [--refresh] [--dry-run] [--without-codex] [--without-claude]
  xmux cleanup-legacy [--dry-run] [--purge-archive] [--force]
  xmux doctor-xmux [--quiet|--json] [--without-codex] [--without-claude]
  xmux remove-xmux [--with-skills|--without-skills] [--dry-run] [--without-codex] [--without-claude]
  xmux --version

Session display names are <project>/<session>; use only the <session> part with -n, attach, and stop inside that project.
EOF
}

_xmux_require_tmux() {
  command -v tmux >/dev/null 2>&1 || {
    echo "error: tmux is required." >&2
    return 1
  }
}

_xmux_validate_session_name() {
  local name="$1"
  if ! _xmux_is_strict_display "$name"; then
    echo "error: invalid xmux session name '$name'." >&2
    return 1
  fi
}

_xmux_validate_session_lookup() {
  local name="$1"
  if [[ -z "$name" || "$name" == *:* ]]; then
    echo "error: invalid xmux session name '$name'." >&2
    return 1
  fi
}

_xmux_is_strict_display() {
  local name="$1"
  [[ -n "$name" && "$name" != *:* && "$name" != */* && "$name" != *--* && "$name" != *[!A-Za-z0-9._-]* ]]
}

_xmux_slug_component() {
  local raw="${1:-}" fallback="${2:-xmux}" max="${3:-24}" slug
  slug="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]._-' '-')"
  while [[ "$slug" == *--* ]]; do
    slug="${slug//--/-}"
  done
  [[ -n "$slug" ]] || slug="$fallback"
  if (( ${#slug} > max )); then
    slug="${slug[1,$max]}"
  fi
  print -r -- "$slug"
}

_xmux_short_hash() {
  local value="$1" hash
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$value" | shasum -a 1 2>/dev/null)"
  elif command -v sha1sum >/dev/null 2>&1; then
    hash="$(printf '%s' "$value" | sha1sum 2>/dev/null)"
  else
    hash="$(printf '%s' "$value" | cksum 2>/dev/null)"
    hash="${hash%% *}"
    hash="$(printf '%08x' "$hash" 2>/dev/null)"
  fi
  hash="${hash%% *}"
  [[ -n "$hash" ]] || hash="000000"
  print -r -- "${hash[1,6]}"
}

_xmux_default_session_name() {
  _xmux_slug_component "$(basename "$XMUX_PROJECT_DIR")" default 24
}

_xmux_resolve_start_name() {
  local raw="${1:-}" project_slug display_slug project_hash
  [[ -n "$raw" ]] || raw="$(_xmux_default_session_name)"
  _xmux_validate_session_name "$raw" || return 1

  project_slug="$(_xmux_slug_component "$(basename "$XMUX_PROJECT_DIR")" project 12)"
  display_slug="$(_xmux_slug_component "$raw" session 24)"
  project_hash="$(_xmux_short_hash "$XMUX_PROJECT_DIR")"

  typeset -g _XMUX_RESOLVED_RAW_NAME="$raw"
  typeset -g _XMUX_RESOLVED_DISPLAY_NAME="${project_slug}/${raw}"
  typeset -g _XMUX_RESOLVED_SESSION_NAME="xmux-${project_slug}--${project_hash}--${display_slug}"
  typeset -g _XMUX_RESOLVED_PROJECT_DIR="$XMUX_PROJECT_DIR"
  typeset -g _XMUX_RESOLVED_PROJECT_SLUG="$project_slug"
}

# `=name` forces tmux to match the session name literally instead of by prefix.
_xmux_tmux_session_target() {
  print -r -- "=$1"
}

# `=name:` targets session options; the trailing colon avoids window lookup.
_xmux_tmux_option_target() {
  print -r -- "=$1:"
}

_xmux_tmux_has_session() {
  local session="$1"
  tmux has-session -t "$(_xmux_tmux_session_target "$session")" 2>/dev/null
}

_xmux_tmux_session_option() {
  local session="$1" option="$2"
  tmux show-option -qv -t "$(_xmux_tmux_option_target "$session")" "$option" 2>/dev/null
}

_xmux_set_resolved_from_tmux() {
  local session="$1" fallback_raw="${2:-$1}" raw display project_dir
  raw="$(_xmux_tmux_session_option "$session" @xmux-raw-name)"
  [[ -n "$raw" ]] || raw="$fallback_raw"
  project_dir="$(_xmux_tmux_session_option "$session" @xmux-project-dir)"
  [[ -n "$project_dir" ]] || project_dir="$XMUX_PROJECT_DIR"
  display="$(_xmux_tmux_session_option "$session" @xmux-display-name)"
  [[ -n "$display" ]] || display="$(_xmux_slug_component "$(basename "$project_dir")" project 12)/$raw"
  typeset -g _XMUX_RESOLVED_RAW_NAME="$raw"
  typeset -g _XMUX_RESOLVED_DISPLAY_NAME="$display"
  typeset -g _XMUX_RESOLVED_SESSION_NAME="$session"
  typeset -g _XMUX_RESOLVED_PROJECT_DIR="$project_dir"
  typeset -g _XMUX_RESOLVED_PROJECT_SLUG="${display:h}"
}

_xmux_find_session_by_display() {
  local wanted="$1" session display managed
  local -a sessions
  sessions=(${(f)"$(tmux list-sessions -F '#S' 2>/dev/null)"})
  for session in "${sessions[@]}"; do
    managed="$(_xmux_tmux_session_option "$session" @xmux-managed)"
    [[ "$managed" == "1" ]] || continue
    display="$(_xmux_tmux_session_option "$session" @xmux-display-name)"
    if [[ "$display" == "$wanted" ]]; then
      _xmux_set_resolved_from_tmux "$session" "${wanted:t}"
      return 0
    fi
  done
  return 1
}

_xmux_resolve_existing_session() {
  local query="$1" managed project_dir
  _xmux_validate_session_lookup "$query" || return 1

  if [[ "$query" == */* ]]; then
    _xmux_find_session_by_display "$query"
    return $?
  fi

  if _xmux_is_strict_display "$query"; then
    _xmux_resolve_start_name "$query" || return 1
    if _xmux_tmux_has_session "$_XMUX_RESOLVED_SESSION_NAME"; then
      return 0
    fi
  fi

  if _xmux_tmux_has_session "$query"; then
    managed="$(_xmux_tmux_session_option "$query" @xmux-managed)"
    project_dir="$(_xmux_tmux_session_option "$query" @xmux-project-dir)"
    if [[ "$managed" == "1" && ( -z "$project_dir" || "$project_dir" == "$XMUX_PROJECT_DIR" ) ]]; then
      _xmux_set_resolved_from_tmux "$query" "$query"
      return 0
    fi
  fi

  _xmux_find_session_by_display "$query"
}

_xmux_legacy_raw_session_exists_for_project() {
  local raw="$1" managed project_dir
  _xmux_tmux_has_session "$raw" || return 1
  managed="$(_xmux_tmux_session_option "$raw" @xmux-managed)"
  project_dir="$(_xmux_tmux_session_option "$raw" @xmux-project-dir)"
  [[ "$managed" == "1" && ( -z "$project_dir" || "$project_dir" == "$XMUX_PROJECT_DIR" ) ]]
}

_xmux_provider_separator_color() {
  case "$1" in
    claude) print -r -- "#D97757" ;;
    codex|*) print -r -- "#10A37F" ;;
  esac
}

_xmux_apply_drag_mode_theme_bindings() {
  local codex_accent claude_accent bg condition claude_chrome codex_chrome
  codex_accent="$(_xmux_provider_separator_color codex)"
  claude_accent="$(_xmux_provider_separator_color claude)"
  bg="#0E0F12"
  condition='#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}}'
  claude_chrome="select-pane -t = ; set-window-option -t = mode-style bg=${claude_accent},fg=${bg} ; set-option -t = pane-active-border-style fg=${claude_accent},bold"
  codex_chrome="select-pane -t = ; set-window-option -t = mode-style bg=${codex_accent},fg=${bg} ; set-option -t = pane-active-border-style fg=${codex_accent},bold"

  tmux bind-key -T root MouseDown1Pane \
    if-shell -F -t = "$condition" "${claude_chrome} ; send-keys -M" "${codex_chrome} ; send-keys -M" 2>/dev/null || true
  tmux bind-key -T root MouseDrag1Pane \
    if-shell -F -t = "$condition" "${claude_chrome} ; copy-mode -M" "${codex_chrome} ; copy-mode -M" 2>/dev/null || true

  tmux bind-key -T copy-mode MouseDown1Pane \
    if-shell -F -t = "$condition" "$claude_chrome" "$codex_chrome" 2>/dev/null || true
  tmux bind-key -T copy-mode MouseDrag1Pane \
    if-shell -F -t = "1" "select-pane -t = ; send-keys -X begin-selection" 2>/dev/null || true
  tmux bind-key -T copy-mode-vi MouseDown1Pane \
    if-shell -F -t = "$condition" "$claude_chrome" "$codex_chrome" 2>/dev/null || true
  tmux bind-key -T copy-mode-vi MouseDrag1Pane \
    if-shell -F -t = "1" "select-pane -t = ; send-keys -X begin-selection" 2>/dev/null || true
}

_xmux_status_label() {
  local label="$1"
  label="${label//[[:cntrl:]]/ }"
  label="${label//\#/##}"
  print -r -- "$label"
}

_xmux_current_tmux_session() {
  [[ -n "${TMUX_PANE:-}" ]] || return 1
  tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null
}

_xmux_apply_session_theme() {
  local session="$1" label="${2:-$1}"
  [[ -n "$session" ]] || return 0
  local accent bg surface chip_bg fg muted dim safe_label target border_format
  accent="$(_xmux_provider_separator_color codex)"
  bg="#0E0F12"
  surface="#15171C"
  chip_bg="#252A31"
  fg="#F5F7FA"
  muted="#9EA1AA"
  dim="#5C6068"
  border_format=' #{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#{?#{@xmux-claude-progress},#{@xmux-claude-progress} ,✳ },#{?#{m/r:^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏],#{pane_title}},#{=1:pane_title} ,}}#{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#[fg=#D97757]#[bold]claude #[default],#[fg=#10A37F]#[bold]codex #[default]}'
  safe_label="$(_xmux_status_label "$label")"
  target="$(_xmux_tmux_option_target "$session")"

  tmux set-option -t "$target" status on 2>/dev/null || true
  tmux set-option -t "$target" status-position bottom 2>/dev/null || true
  tmux set-option -t "$target" status-style "bg=${bg},fg=${fg}" 2>/dev/null || true
  tmux set-option -t "$target" status-left-length 120 2>/dev/null || true
  tmux set-option -t "$target" status-right-length 45 2>/dev/null || true
  tmux set-option -t "$target" status-left "#[bg=${accent},fg=${bg},bold] XMux #[bg=${chip_bg},fg=${fg},nobold] ${safe_label} #[bg=${surface},fg=${muted}] #W " 2>/dev/null || true
  tmux set-option -t "$target" status-right "#[bg=${surface},fg=${muted}] xmux ${XMUX_VERSION} #[bg=${chip_bg},fg=${fg}] %H:%M " 2>/dev/null || true
  tmux set-option -t "$target" window-status-format "" 2>/dev/null || true
  tmux set-option -t "$target" window-status-current-format "" 2>/dev/null || true
  tmux set-option -t "$target" window-status-separator "" 2>/dev/null || true
  tmux set-window-option -t "$target" window-style default 2>/dev/null || true
  tmux set-window-option -t "$target" window-active-style default 2>/dev/null || true
  tmux set-option -t "$target" pane-border-style "fg=${surface}" 2>/dev/null || true
  tmux set-option -t "$target" pane-border-status top 2>/dev/null || true
  tmux set-option -t "$target" pane-border-format "$border_format" 2>/dev/null || true
  tmux set-option -t "$target" pane-active-border-style "fg=$(_xmux_provider_separator_color codex),bold" 2>/dev/null || true
  tmux set-option -t "$target" message-style "bg=${accent},fg=${bg},bold" 2>/dev/null || true
  tmux set-option -t "$target" message-command-style "bg=${chip_bg},fg=${fg}" 2>/dev/null || true
  tmux set-window-option -t "$target" mode-style "bg=${accent},fg=${bg}" 2>/dev/null || true
  _xmux_apply_drag_mode_theme_bindings
  tmux set-option -t "$target" @xmux-version "$XMUX_VERSION" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-theme-accent "$accent" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-theme-muted "$muted" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-theme-dim "$dim" 2>/dev/null || true
}

_xmux_apply_pane_theme() {
  local pane="$1" provider="${2:-codex}" label="${3:-$provider}"
  [[ -n "$pane" ]] || return 0
  local accent safe_label border_format
  accent="$(_xmux_provider_separator_color "$provider")"
  border_format=' #{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#{?#{@xmux-claude-progress},#{@xmux-claude-progress} ,✳ },#{?#{m/r:^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏],#{pane_title}},#{=1:pane_title} ,}}#{?#{||:#{==:#{@xmux-provider},claude},#{m:claude:*,#{@xmux-agent}}},#[fg=#D97757]#[bold]claude #[default],#[fg=#10A37F]#[bold]codex #[default]}'
  safe_label="$(_xmux_status_label "$provider")"
  if (( ${#safe_label} > 24 )); then
    safe_label="${safe_label[1,21]}..."
  fi
  tmux select-pane -t "$pane" -T "$safe_label" 2>/dev/null || true
  tmux set-option -pt "$pane" @xmux-provider "$provider" 2>/dev/null || true
  tmux select-pane -t "$pane" -P default 2>/dev/null || true
  tmux set-option -pt "$pane" @xmux-provider-accent "$accent" 2>/dev/null || true
  tmux set-option -p -t "$pane" -u @xmux-provider-bg 2>/dev/null || true
  tmux set-option -p -t "$pane" -u @xmux-claude-progress 2>/dev/null || true
  tmux set-option -p -t "$pane" -u @xmux-claude-progress-token 2>/dev/null || true
  tmux set-option -pt "$pane" pane-border-style "fg=#15171C" 2>/dev/null || true
  tmux set-option -pt "$pane" pane-border-status top 2>/dev/null || true
  tmux set-option -pt "$pane" pane-border-format "$border_format" 2>/dev/null || true
}

_xmux_harness_cli_path() {
  local kind="$1" candidate
  for candidate in \
      "$XMUX_INSTALL_DIR/dist/bin/xmux-${kind}-harness.js" \
      "$XMUX_INSTALL_DIR/src/${kind}/cli.js"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    print -r -- "$candidate"
    return 0
  done
  return 1
}

_xmux_cmd_claude_harness() {
  local script name arg
  script="$(_xmux_harness_cli_path claude)" || {
    echo "error: missing Claude harness CLI under $XMUX_INSTALL_DIR." >&2
    return 1
  }
  if [[ "${1:-}" == "pane-run" && -n "${TMUX_PANE:-}" ]]; then
    name="default"
    local -a xmux_args
    xmux_args=("$@")
    local idx=1
    while (( idx <= ${#xmux_args[@]} )); do
      arg="${xmux_args[$idx]}"
      case "$arg" in
        --name)
          if (( idx + 1 <= ${#xmux_args[@]} )); then
            name="${xmux_args[$((idx + 1))]}"
          fi
          break
          ;;
        --name=*)
          name="${arg#--name=}"
          break
          ;;
      esac
      (( idx++ ))
    done
    _xmux_apply_pane_theme "$TMUX_PANE" claude "claude:${name}"
  fi
  XMUX_INSTALL_DIR="$XMUX_INSTALL_DIR" \
    XMUX_PROJECT_DIR="$XMUX_PROJECT_DIR" \
    XMUX_STATE_DIR="$XMUX_STATE_DIR" \
    node "$script" "$@"
}

_xmux_cmd_codex_harness() {
  local script
  script="$(_xmux_harness_cli_path codex)" || {
    echo "error: missing Codex harness CLI under $XMUX_INSTALL_DIR." >&2
    return 1
  }
  XMUX_INSTALL_DIR="$XMUX_INSTALL_DIR" \
    XMUX_PROJECT_DIR="$XMUX_PROJECT_DIR" \
    XMUX_STATE_DIR="$XMUX_STATE_DIR" \
    node "$script" "$@"
}

_xmux_setup_script_path() {
  local candidate
  for candidate in \
      "$XMUX_INSTALL_DIR/dist/xmux/setup.js" \
      "$XMUX_INSTALL_DIR/src/xmux/setup.js"; do
    [[ -f "$candidate" ]] || continue
    print -r -- "$candidate"
    return 0
  done
  return 1
}

_xmux_run_setup_script() {
  local script
  script="$(_xmux_setup_script_path)" || {
    echo "error: missing XMux setup script under $XMUX_INSTALL_DIR." >&2
    return 1
  }
  XMUX_INSTALL_DIR="$XMUX_INSTALL_DIR" node "$script" --xmux-install-dir "$XMUX_INSTALL_DIR" "$@"
}

_xmux_cmd_setup_xmux() {
  _xmux_run_setup_script "$@"
}

_xmux_cmd_doctor_xmux() {
  _xmux_run_setup_script --doctor "$@"
}

_xmux_cmd_remove_xmux() {
  _xmux_run_setup_script --remove "$@"
}

_xmux_cmd_cleanup_legacy() {
  _xmux_run_setup_script --cleanup-legacy "$@"
}

_xmux_codex_home_env_name() {
  if [[ -n "${CODEX_HOME:-}" ]]; then
    print -r -- "CODEX_HOME"
  else
    print -r -- "CODEX_HOME"
  fi
}

_xmux_run_codex_lead() {
  local name="${XMUX_CODEX_SESSION_NAME:-default}"
  local codex_bin="${XMUX_CODEX_TUI_CMD:-codex}"
  local script tmux_session
  local -a args
  script="$(_xmux_harness_cli_path codex)" || {
    echo "[xmux] error: missing Codex pane harness." >&2
    return 1
  }
  if [[ -n "${TMUX_PANE:-}" ]]; then
    tmux_session="$(_xmux_current_tmux_session || true)"
    if [[ -n "$tmux_session" ]]; then
      local display_name
      display_name="$(_xmux_tmux_session_option "$tmux_session" @xmux-display-name)"
      [[ -n "$display_name" ]] || display_name="$tmux_session"
      _xmux_apply_session_theme "$tmux_session" "$display_name"
    fi
    tmux set-option -pt "$TMUX_PANE" @xmux-codex-session "$name" 2>/dev/null || true
    _xmux_apply_pane_theme "$TMUX_PANE" codex "codex:${name}"
  fi
  args=(pane-run --name "$name" --codex-cmd "$codex_bin")
  if [[ $# -gt 0 ]]; then
    args+=(-- "$@")
  fi
  env -u CODEX_HOME -u XMUX_DIR -u XMUX_HOME \
    XMUX_INSTALL_DIR="$XMUX_INSTALL_DIR" \
    XMUX_PROJECT_DIR="$XMUX_PROJECT_DIR" \
    XMUX_STATE_DIR="$XMUX_STATE_DIR" \
    XMUX_CODEX_SESSION_NAME="$name" \
    node "$script" "${args[@]}"
}

_xmux_build_codex_command() {
  local name="$1" codex_bin="$2"
  shift 2
  local wrapper cmd arg
  wrapper='source "$XMUX_INSTALL_DIR/runtime/shell/xmux.zsh"; _xmux_run_codex_lead "$@"'
  cmd="exec env -u CODEX_HOME -u XMUX_DIR -u XMUX_HOME XMUX_INSTALL_DIR=$(_xmux_q "$XMUX_INSTALL_DIR") XMUX_PROJECT_DIR=$(_xmux_q "$XMUX_PROJECT_DIR") XMUX_STATE_DIR=$(_xmux_q "$XMUX_STATE_DIR") XMUX_CODEX_SESSION_NAME=$(_xmux_q "$name") XMUX_CODEX_TUI_CMD=$(_xmux_q "$codex_bin") zsh -lc $(_xmux_q "$wrapper") xmux-lead"
  for arg in "$@"; do
    cmd+=" $(_xmux_q "$arg")"
  done
  print -r -- "$cmd"
}

_xmux_start() {
  _xmux_refresh_paths
  local requested_name="" codex_bin="${XMUX_CODEX_TUI_CMD:-codex}" arg
  local -a codex_args
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      -n|--name)
        [[ $# -ge 2 ]] || { echo "error: $arg requires a session name." >&2; return 1; }
        requested_name="$2"
        shift 2
        ;;
      --codex-bin)
        [[ $# -ge 2 ]] || { echo "error: --codex-bin requires a path." >&2; return 1; }
        codex_bin="$2"
        shift 2
        ;;
      --claude|--gemini|--copilot|-T|--team|--with)
        echo "error: legacy teammate startup is removed. Start Codex with xmux, then use \$xmux-claude or /xmux-codex." >&2
        return 1
        ;;
      --)
        shift
        codex_args+=("$@")
        break
        ;;
      -h|--help)
        _xmux_user_usage
        return 0
        ;;
      *)
        codex_args+=("$arg")
        shift
        ;;
    esac
  done

  _xmux_resolve_start_name "$requested_name" || return 1
  local session_name="$_XMUX_RESOLVED_SESSION_NAME"
  local raw_name="$_XMUX_RESOLVED_RAW_NAME"
  local display_name="$_XMUX_RESOLVED_DISPLAY_NAME"
  local project_slug="$_XMUX_RESOLVED_PROJECT_SLUG"
  _xmux_require_tmux || return 1
  command -v "${codex_bin%% *}" >/dev/null 2>&1 || {
    echo "error: codex command not found: ${codex_bin%% *}" >&2
    return 1
  }

  if [[ -n "${TMUX:-}" && -t 0 && -t 1 ]]; then
    XMUX_CODEX_SESSION_NAME="$raw_name" XMUX_CODEX_TUI_CMD="$codex_bin" _xmux_run_codex_lead "${codex_args[@]}"
    return $?
  fi

  if _xmux_tmux_has_session "$session_name" || _xmux_legacy_raw_session_exists_for_project "$raw_name"; then
    echo "error: session '$raw_name' already exists in project '$project_slug'." >&2
    echo "       attach: xmux attach $raw_name" >&2
    echo "       stop:   xmux stop $raw_name" >&2
    echo "       new:    xmux -n <name>" >&2
    return 1
  fi

  local codex_cmd window_name
  codex_cmd="$(_xmux_build_codex_command "$raw_name" "$codex_bin" "${codex_args[@]}")"
  window_name="$(basename "$XMUX_PROJECT_DIR")"
  tmux new-session -d -s "$session_name" -n "$window_name" -c "$XMUX_PROJECT_DIR" "$codex_cmd" || {
    echo "error: failed to create tmux session '$raw_name'." >&2
    return 1
  }
  local target
  target="$(_xmux_tmux_option_target "$session_name")"
  tmux set-option -t "$target" @xmux-managed 1 2>/dev/null || true
  tmux set-option -t "$target" @xmux-version "$XMUX_VERSION" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-project-dir "$XMUX_PROJECT_DIR" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-display-name "$display_name" 2>/dev/null || true
  tmux set-option -t "$target" @xmux-raw-name "$raw_name" 2>/dev/null || true
  _xmux_apply_session_theme "$session_name" "$display_name"

  if [[ -t 0 && -t 1 ]]; then
    tmux attach-session -t "$(_xmux_tmux_session_target "$session_name")"
  else
    echo "[xmux] session created session:$display_name detached:true"
  fi
}

_xmux_cmd_attach() {
  local query="${1:-}"
  [[ -n "$query" ]] || { echo "error: attach requires a session name." >&2; return 1; }
  _xmux_require_tmux || return 1
  if ! _xmux_resolve_existing_session "$query"; then
    if _xmux_tmux_has_session "$query" && [[ "$(_xmux_tmux_session_option "$query" @xmux-managed)" != "1" ]]; then
      echo "error: session '$query' is not owned by XMux." >&2
      echo "       use tmux directly: tmux attach -t $query" >&2
      return 1
    fi
    echo "error: session '$query' does not exist." >&2
    return 1
  fi
  _xmux_apply_session_theme "$_XMUX_RESOLVED_SESSION_NAME" "$_XMUX_RESOLVED_DISPLAY_NAME"
  tmux attach-session -t "$(_xmux_tmux_session_target "$_XMUX_RESOLVED_SESSION_NAME")"
}

_xmux_cmd_stop() {
  local query="${1:-}"
  [[ -n "$query" ]] || {
    echo "error: stop requires a session name." >&2
    echo "       usage: xmux stop <session>" >&2
    return 1
  }
  shift || true
  if [[ $# -gt 0 ]]; then
    echo "error: stop accepts only one session name." >&2
    echo "       usage: xmux stop <session>" >&2
    return 1
  fi
  _xmux_require_tmux || return 1
  if ! _xmux_resolve_existing_session "$query"; then
    if _xmux_tmux_has_session "$query" && [[ "$(_xmux_tmux_session_option "$query" @xmux-managed)" != "1" ]]; then
      echo "error: session '$query' is not owned by XMux." >&2
      echo "       use tmux directly: tmux kill-session -t $query" >&2
      return 1
    fi
    echo "error: session '$query' does not exist." >&2
    return 1
  fi
  local session_name="$_XMUX_RESOLVED_SESSION_NAME"
  local raw_name="$_XMUX_RESOLVED_RAW_NAME"
  local display_name="$_XMUX_RESOLVED_DISPLAY_NAME"
  local project_dir="$_XMUX_RESOLVED_PROJECT_DIR"
  tmux kill-session -t "$(_xmux_tmux_session_target "$session_name")" || {
    echo "error: failed to stop session '$display_name'." >&2
    return 1
  }
  if [[ -n "$project_dir" ]]; then
    XMUX_PROJECT_DIR="$project_dir" XMUX_STATE_DIR="$project_dir/.codex/xmux" _xmux_cmd_codex_harness stop --name "$raw_name" >/dev/null 2>&1 || true
  else
    _xmux_cmd_codex_harness stop --name "$raw_name" >/dev/null 2>&1 || true
  fi
  echo "[xmux] stopped session '$display_name'"
}

_xmux_cmd_sessions() {
  _xmux_require_tmux || return 1
  local session managed display project_dir
  local -a sessions
  sessions=(${(f)"$(tmux list-sessions -F '#S' 2>/dev/null)"})
  for session in "${sessions[@]}"; do
    managed="$(_xmux_tmux_session_option "$session" @xmux-managed)"
    [[ "$managed" == "1" ]] || continue
    project_dir="$(_xmux_tmux_session_option "$session" @xmux-project-dir)"
    [[ "$project_dir" == "$XMUX_PROJECT_DIR" ]] || continue
    display="$(_xmux_tmux_session_option "$session" @xmux-display-name)"
    [[ -n "$display" ]] || display="$session"
    print -r -- "$display"
  done
}

_xmux_legacy_removed() {
  echo "error: $1 was removed in XMux 2.x. Use the Codex-Claude hook harness through \$xmux-claude and /xmux-codex." >&2
  return 1
}

xmux-claude() {
  _xmux_legacy_removed "xmux-claude teammate command"
}

xmux-gemini() {
  _xmux_legacy_removed "xmux-gemini teammate command"
}

xmux-copilot() {
  _xmux_legacy_removed "xmux-copilot teammate command"
}

xmux() {
  _xmux_refresh_paths
  local cmd="${1:-}"
  case "$cmd" in
    -V|--version|version)
      _xmux_print_version
      ;;
    ""|-*)
      _xmux_start "$@"
      ;;
    start)
      shift
      _xmux_start "$@"
      ;;
    attach)
      shift
      _xmux_cmd_attach "$@"
      ;;
    stop)
      shift
      _xmux_cmd_stop "$@"
      ;;
    sessions)
      shift
      _xmux_cmd_sessions "$@"
      ;;
    claude)
      shift
      _xmux_cmd_claude_harness "$@"
      ;;
    codex|xmux-codex)
      shift
      _xmux_cmd_codex_harness "$@"
      ;;
    setup-xmux)
      shift
      _xmux_cmd_setup_xmux "$@"
      ;;
    doctor-xmux)
      shift
      _xmux_cmd_doctor_xmux "$@"
      ;;
    cleanup-legacy)
      shift
      _xmux_cmd_cleanup_legacy "$@"
      ;;
    remove-xmux)
      shift
      _xmux_cmd_remove_xmux "$@"
      ;;
    teamCreate|teammateAdd|teamStatus|teammateStatus|teammateShutdown|teamShutdown|teammates|bridgeStatus|ensure|recover|sendPane|shutdown|doctor|gemini|copilot|codex-worker)
      _xmux_legacy_removed "xmux $cmd"
      ;;
    help|-h|--help)
      _xmux_user_usage
      ;;
    *)
      echo "error: unknown xmux command '$cmd'." >&2
      _xmux_user_usage
      return 1
      ;;
  esac
}
