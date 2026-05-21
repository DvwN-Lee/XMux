#!/usr/bin/env python3
import argparse
import errno
import hashlib
import json
import os
import pty
import select
import shlex
import signal
import socket
import sys
import termios
import time
import tty
import fcntl
import struct

BODY_TTL_SECONDS = float(os.environ.get("XMUX_BODY_TTL_SECONDS", "120"))
BODY_MAX_BYTES = int(os.environ.get("XMUX_BODY_MAX_BYTES", "1048576"))
BODY_TOTAL_MAX_BYTES = int(os.environ.get("XMUX_BODY_TOTAL_MAX_BYTES", "10485760"))


def parse_args():
    parser = argparse.ArgumentParser(description="XMux Claude TUI pane runner")
    parser.add_argument("--name", required=True)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--launch-id", default=os.environ.get("XMUX_CLAUDE_LAUNCH_ID", ""))
    parser.add_argument("--claude-cmd", default=os.environ.get("XMUX_CLAUDE_TUI_CMD", "claude"))
    return parser.parse_args()


def resize_pty(fd):
    if not sys.stdin.isatty():
        return
    try:
        packed = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        pass


def write_json_line(conn, payload):
    conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))


def canonical_body(value):
    return str(value or "").rstrip()


def body_hash(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def body_bytes(body):
    return len(body.encode("utf-8"))


def cleanup_pending(pending):
    now = time.time()
    for key, item in list(pending.items()):
        if float(item.get("expires_at", 0)) <= now:
            del pending[key]

    total = sum(int(item.get("bytes", 0)) for item in pending.values())
    if total <= BODY_TOTAL_MAX_BYTES:
        return

    oldest = sorted(pending.items(), key=lambda pair: float(pair[1].get("created_at", 0)))
    for key, item in oldest:
        if total <= BODY_TOTAL_MAX_BYTES:
            break
        total -= int(item.get("bytes", 0))
        del pending[key]


def store_body(pending, request_id, nonce, body, digest):
    cleanup_pending(pending)
    request_id = str(request_id or "").strip()
    nonce = str(nonce or "").strip()
    digest = str(digest or "").strip()
    body = canonical_body(body)
    size = body_bytes(body)

    if not request_id:
        return {"ok": False, "error": "missing request_id"}
    if not nonce:
        return {"ok": False, "error": "missing nonce"}
    if not body:
        return {"ok": False, "error": "missing body"}
    if size > BODY_MAX_BYTES:
        return {"ok": False, "error": f"body exceeds {BODY_MAX_BYTES} bytes"}
    if body_hash(body) != digest:
        return {"ok": False, "error": "body sha256 mismatch"}

    pending[request_id] = {
        "nonce": nonce,
        "body": body,
        "sha256": digest,
        "bytes": size,
        "created_at": time.time(),
        "expires_at": time.time() + BODY_TTL_SECONDS,
        "retrieved_at": None,
    }
    return {"ok": True, "bytes": size}


def retrieve_body(pending, request_id, nonce):
    cleanup_pending(pending)
    request_id = str(request_id or "").strip()
    nonce = str(nonce or "").strip()
    item = pending.get(request_id)
    if not item:
        return {"ok": False, "error": "body not found"}
    if item.get("nonce") != nonce:
        return {"ok": False, "error": "nonce mismatch"}
    item["retrieved_at"] = time.time()
    item["expires_at"] = time.time() + BODY_TTL_SECONDS
    return {
        "ok": True,
        "body": item.get("body", ""),
        "sha256": item.get("sha256", ""),
        "bytes": item.get("bytes", 0),
    }


def release_body(pending, request_id, nonce):
    request_id = str(request_id or "").strip()
    nonce = str(nonce or "").strip()
    item = pending.get(request_id)
    if not item:
        return {"ok": True, "released": False}
    if item.get("nonce") != nonce:
        return {"ok": False, "error": "nonce mismatch"}
    del pending[request_id]
    return {"ok": True, "released": True}


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view[:4096])
            if written == 0:
                select.select([], [fd], [])
                continue
            view = view[written:]
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                select.select([], [fd], [])
                continue
            raise


def inject_prompt(master_fd, message):
    prompt = str(message.get("prompt", ""))
    if message.get("clear", False):
        write_all(master_fd, b"\x15")
        time.sleep(float(os.environ.get("XMUX_CLAUDE_CLEAR_DELAY", "0.05")))
    if not prompt:
        return
    data = prompt.encode("utf-8")
    if message.get("bracketed_paste", True):
        write_all(master_fd, b"\x1b[200~")
        write_all(master_fd, data)
        write_all(master_fd, b"\x1b[201~")
    else:
        write_all(master_fd, data)
    if message.get("enter", True):
        default_enter_delay = "0.20" if message.get("bracketed_paste", True) else "0.12"
        time.sleep(float(os.environ.get("XMUX_CLAUDE_ENTER_DELAY", default_enter_delay)))
        write_all(master_fd, b"\r")


def visible_request_prompt(message):
    prompt = str(message.get("prompt", "") or "")
    if prompt:
        return prompt
    title = str(message.get("title", "") or "").strip()
    if title:
        return f"[xmux-codex-request]\n\n{title}"
    return "[xmux-codex-request]"


def visible_response_prompt(message):
    prompt = str(message.get("prompt", "") or "")
    if prompt:
        return prompt
    title = str(message.get("title", "") or "").strip()
    if title:
        return f"[xmux-codex-response]\n\n{title}"
    return "[xmux-codex-response]"


def read_message(conn):
    chunks = []
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    raw = b"".join(chunks).split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
    if not raw:
        return {}
    return json.loads(raw)


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.socket), exist_ok=True)
    try:
        os.unlink(args.socket)
    except FileNotFoundError:
        pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(16)
    server.setblocking(False)
    pending_bodies = {}

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(args.project_dir)
        env = os.environ.copy()
        env["XMUX_CLAUDE_SESSION_NAME"] = args.name
        env["XMUX_CLAUDE_SOCKET"] = args.socket
        env["XMUX_CLAUDE_LAUNCH_ID"] = args.launch_id
        env["XMUX_PROJECT_DIR"] = args.project_dir
        env["XMUX_STATE_DIR"] = args.state_dir
        command = shlex.split(args.claude_cmd)
        os.execvpe(command[0], command, env)

    resize_pty(master_fd)
    old_term = None
    stdin_fd = sys.stdin.fileno()
    if sys.stdin.isatty():
        old_term = termios.tcgetattr(stdin_fd)
        tty.setraw(stdin_fd)

    def handle_winch(_signum, _frame):
        resize_pty(master_fd)

    signal.signal(signal.SIGWINCH, handle_winch)

    try:
        while True:
            read_fds = [master_fd, server]
            if sys.stdin.isatty():
                read_fds.append(stdin_fd)
            ready, _, _ = select.select(read_fds, [], [])
            if master_fd in ready:
                try:
                    data = os.read(master_fd, 8192)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if sys.stdin.isatty() and stdin_fd in ready:
                data = os.read(stdin_fd, 8192)
                if not data:
                    break
                os.write(master_fd, data)
            if server in ready:
                conn, _ = server.accept()
                conn.setblocking(True)
                with conn:
                    try:
                        message = read_message(conn)
                        if message.get("type") == "ping":
                            write_json_line(conn, {"ok": True})
                        elif message.get("type") == "inject_request":
                            result = store_body(
                                pending_bodies,
                                message.get("request_id"),
                                message.get("nonce"),
                                message.get("body"),
                                message.get("sha256"),
                            )
                            if not result.get("ok"):
                                write_json_line(conn, result)
                                continue
                            message["prompt"] = visible_request_prompt(message)
                            write_json_line(conn, result)
                            conn.close()
                            try:
                                inject_prompt(master_fd, message)
                            except Exception as inject_error:
                                print(f"[xmux-claude pane-run] request injection failed: {inject_error}", file=sys.stderr)
                        elif message.get("type") == "inject_response":
                            result = store_body(
                                pending_bodies,
                                message.get("request_id"),
                                message.get("response_nonce"),
                                message.get("body"),
                                message.get("sha256"),
                            )
                            if not result.get("ok"):
                                write_json_line(conn, result)
                                continue
                            message["prompt"] = visible_response_prompt(message)
                            write_json_line(conn, result)
                            conn.close()
                            try:
                                inject_prompt(master_fd, message)
                            except Exception as inject_error:
                                print(f"[xmux-claude pane-run] response injection failed: {inject_error}", file=sys.stderr)
                        elif message.get("type") == "retrieve_request_body":
                            write_json_line(
                                conn,
                                retrieve_body(
                                    pending_bodies,
                                    message.get("request_id"),
                                    message.get("nonce"),
                                ),
                            )
                        elif message.get("type") == "release_request_body":
                            write_json_line(
                                conn,
                                release_body(
                                    pending_bodies,
                                    message.get("request_id"),
                                    message.get("nonce"),
                                ),
                            )
                        elif message.get("type") == "retrieve_response_body":
                            write_json_line(
                                conn,
                                retrieve_body(
                                    pending_bodies,
                                    message.get("request_id"),
                                    message.get("response_nonce"),
                                ),
                            )
                        elif message.get("type") == "release_response_body":
                            write_json_line(
                                conn,
                                release_body(
                                    pending_bodies,
                                    message.get("request_id"),
                                    message.get("response_nonce"),
                                ),
                            )
                        elif message.get("type") == "prompt":
                            write_json_line(conn, {"ok": True})
                            conn.close()
                            try:
                                inject_prompt(master_fd, message)
                            except Exception as inject_error:
                                print(f"[xmux-claude pane-run] prompt injection failed: {inject_error}", file=sys.stderr)
                        else:
                            write_json_line(conn, {"ok": False, "error": "unknown message type"})
                    except Exception as error:
                        write_json_line(conn, {"ok": False, "error": str(error)})
    finally:
        if old_term is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_term)
        try:
            os.unlink(args.socket)
        except FileNotFoundError:
            pass
        try:
            os.kill(child_pid, signal.SIGHUP)
        except OSError:
            pass


if __name__ == "__main__":
    main()
