# XMux

XMux is a project that enables communication between Codex and Claude. The user
starts Codex through `xmux`, then uses explicit XMux triggers when Codex and
Claude, or two XMux sessions, should exchange work.

## Features

- `Codex -> Claude -> Codex`: ask Claude from a Codex session with
  `$xmux-claude`.
- `Claude -> Codex -> Claude`: ask Codex from Claude with `/xmux-codex`.
- `XMux -> XMux`: send work to another XMux session with `$xmux-send` or
  `xmux send-pane`.

## Install

```bash
brew tap DwvN-Lee/xmux
brew install xmux
```

Configure XMux-managed Codex and Claude integration:

```bash
xmux setup-xmux
xmux doctor-xmux
```

## Usage

Start Codex from the target project:

```bash
xmux -n refactor
```

XMux displays sessions as `<project>/<name>`, for example `api/refactor`.
Attach to or stop an existing session with:

```bash
xmux attach refactor
xmux stop refactor
```

Ask Claude from Codex:

```text
$xmux-claude 지금까지 작업한 사항을 정리해서 Claude에게 분석 요청
```

Ask Codex from Claude:

```text
/xmux-codex 현재 접근 방식의 리스크를 Codex에게 검토 요청
```

Send work to another XMux session:

```text
$xmux-send review Ask this session to focus on reproducing the failing test.
$xmux-send! api/review Send this exact prompt body to the target session.
```

Targets may be a session name in the current project or `<project>/<session>`
for cross-project routing.

## Runtime State

XMux keeps request and response state project-local under:

```text
<project>/.codex/xmux/
```

Remove XMux-managed global integration state with:

```bash
xmux remove-xmux
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
