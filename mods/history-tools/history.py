#!/usr/bin/env python3
# Modified for Pixel Sessions; see THIRD_PARTY_NOTICES.md for provenance and license scope.
"""Indexes, reads and moves coding-agent sessions to Session Trash.

  history.py list            -> JSON array of sessions, newest first
  history.py show AGENT REF  -> JSON array of messages for one session
  history.py trash AGENT REF ID REVISION -> recovery path for a moved transcript

Sources: Claude Code, Codex and Pi (jsonl files). Per-file results are cached
by (mtime, size) so a refresh only re-reads transcripts that changed.
"""
from contextlib import closing
import glob
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
from urllib.parse import unquote, urlsplit

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "herdr-history-tools", "index.json")
DEFAULT_CODEX_DIR = os.path.realpath(os.path.join(HOME, ".codex"))
CODEX_DIR = os.path.expanduser(os.environ.get("CODEX_HOME") or DEFAULT_CODEX_DIR)
DEFAULT_CLAUDE_DIR = os.path.realpath(os.path.join(HOME, ".claude"))
CLAUDE_DIR = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or DEFAULT_CLAUDE_DIR)
AGY_DB = Path(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db")
CACHE_VERSION = 6
TITLE_MAX = 160
TEXT_MAX = 6000
SHOW_MAX = 400
SESSION_TRASH = ".pixel-sessions-trash"


def clip(text, n):
    text = " ".join(str(text).split()) if n <= TITLE_MAX else str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


def ms(ts):
    """ISO-8601 string or epoch number -> epoch milliseconds."""
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e12 else ts * 1000)
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def user_text(text):
    """Remove known injected context while preserving the person's prompt."""
    if not isinstance(text, str):
        return ""
    t = text.strip()
    context = r"^<(environment_context|user_instructions|turn_aborted|system-reminder|local-command-caveat)(?:\s[^>]*)?>[\s\S]*?</\1>\s*"
    while True:
        cleaned = re.sub(context, "", t, count=1).strip()
        if cleaned == t:
            break
        t = cleaned
    if t.startswith(("# AGENTS.md", "Caveat:", "[Request interrupted")):
        return ""
    return t


def noise(text):
    return not user_text(text)


def jsonl(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def text_of(content, roles=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type", "text") in roles and isinstance(p.get("text"), str))
    return ""


def tool_line(name, args):
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return f"{name} {clip(args, 200)}"
    if isinstance(args, dict):
        for k in ("command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"):
            if args.get(k):
                v = args[k]
                return f"{name} · {clip(' '.join(v) if isinstance(v, list) else v, 200)}"
    return name


# ---------- Claude Code ----------

def claude_index(path):
    title = ai_title = first = cwd = None
    created = updated = 0
    turns = 0
    sid = os.path.splitext(os.path.basename(path))[0]
    for d in jsonl(path):
        t = d.get("type")
        if t == "ai-title":
            ai_title = d.get("aiTitle") or ai_title
        elif t in ("custom-title", "summary"):
            title = d.get("customTitle") or d.get("summary") or title
        elif t == "workspace-directories" and not cwd:
            cwd = (d.get("directories") or [None])[0]
        elif t in ("user", "assistant"):
            if d.get("isSidechain"):
                continue
            cwd = cwd or d.get("cwd")
            ts = ms(d.get("timestamp"))
            if ts:
                created = created or ts
                updated = max(updated, ts)
            if t == "user" and not d.get("isMeta"):
                text = user_text(text_of((d.get("message") or {}).get("content"), ("text",)))
                if text:
                    turns += 1
                    first = first or text
    if not turns:
        return None
    return {"agent": "claude", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns,
            "title": clip(title or ai_title or first, TITLE_MAX)}


def claude_show(path):
    out = []
    for d in jsonl(path):
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
            continue
        content = (d.get("message") or {}).get("content")
        ts = ms(d.get("timestamp"))
        if t == "user":
            text = user_text(text_of(content, ("text",)))
            if text:
                out.append({"role": "user", "text": text, "time": ts})
            continue
        if isinstance(content, str):
            out.append({"role": t, "text": content, "time": ts})
            continue
        for p in content or []:
            if not isinstance(p, dict):
                continue
            k = p.get("type")
            if k == "text" and p.get("text"):
                out.append({"role": t, "text": p["text"], "time": ts})
            elif k == "tool_use":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("input")), "time": ts})
    return out


# ---------- Codex ----------

def codex_items(path):
    for d in jsonl(path):
        p = d.get("payload") or {}
        yield d, p


def codex_index(path):
    sid = cwd = first = None
    created = updated = turns = 0
    native_user = False
    legacy_first, legacy_turns = None, 0
    for d, p in codex_items(path):
        ts = ms(d.get("timestamp"))
        if d.get("type") == "session_meta":
            src = p.get("source")
            if isinstance(src, dict) and "subagent" in src:
                return None  # reviewer/sub-agent threads, not a conversation
            sid = p.get("id") or p.get("session_id")
            cwd = p.get("cwd")
            created = ms(p.get("timestamp")) or ts
        if ts:
            updated = max(updated, ts)
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            native_user = True
            text = user_text(text_of(p.get("content")))
            if text:
                turns += 1
                first = first or text
        elif d.get("type") == "event_msg" and p.get("type") == "user_message":
            text = user_text(p.get("message"))
            if text:
                legacy_turns += 1
                legacy_first = legacy_first or text
    if not native_user:
        turns, first = legacy_turns, legacy_first
    if not sid or not turns:
        return None
    return {"agent": "codex", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(first, TITLE_MAX)}


def codex_show(path):
    out = []
    native_user = False
    for d, p in codex_items(path):
        if d.get("type") == "event_msg" and p.get("type") == "user_message":
            text = user_text(p.get("message"))
            if text:
                out.append((True, {"role": "user", "text": text, "time": ms(d.get("timestamp"))}))
        if d.get("type") != "response_item":
            continue
        ts = ms(d.get("timestamp"))
        k = p.get("type")
        if k == "message" and p.get("role") in ("user", "assistant"):
            text = text_of(p.get("content"))
            if p["role"] == "user":
                native_user = True
                text = user_text(text)
            if text:
                out.append((False, {"role": p["role"], "text": text, "time": ts}))
        elif k in ("function_call", "custom_tool_call", "local_shell_call"):
            out.append((False, {"role": "tool", "time": ts,
                        "text": tool_line(p.get("name") or "shell", p.get("arguments") or p.get("input") or p.get("action"))}))
    return [message for legacy, message in out if not (legacy and native_user)]


def codex_titles(profile):
    names = {}
    path = os.path.join(profile, "session_index.jsonl")
    if os.path.exists(path):
        for d in jsonl(path):
            if d.get("id") and d.get("thread_name"):
                names[d["id"]] = d["thread_name"]
    return names


# ---------- Pi ----------

def pi_index(path):
    sid = cwd = title = first = None
    created = updated = turns = 0
    for d in jsonl(path):
        ts = ms(d.get("timestamp"))
        updated = max(updated, ts)
        if d.get("type") == "session":
            sid, cwd, created = d.get("id"), d.get("cwd"), ts
        elif d.get("type") == "session_info":
            title = d.get("name")
        elif d.get("type") == "message":
            m = d.get("message") or {}
            if m.get("role") == "user":
                text = user_text(text_of(m.get("content")))
                if text:
                    turns += 1
                    first = first or text
    if not sid or not turns:
        return None
    return {"agent": "pi", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(title or first, TITLE_MAX)}


def pi_show(path):
    out = []
    for d in jsonl(path):
        if d.get("type") != "message":
            continue
        m = d.get("message") or {}
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        ts = ms(d.get("timestamp") or m.get("timestamp"))
        content = m.get("content")
        if role == "user":
            text = user_text(text_of(content))
            if text:
                out.append({"role": "user", "text": text, "time": ts})
            continue
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        # Match the other readers: show visible text and tool calls, omitting
        # thinking, images and tool results that would duplicate the call list.
        for p in content or []:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "text" and p.get("text"):
                out.append({"role": role, "text": p["text"], "time": ts})
            elif role == "assistant" and p.get("type") == "toolCall":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("arguments")), "time": ts})
    return out


# ---------- driver ----------

def file_sources():
    directories = [CLAUDE_DIR, DEFAULT_CLAUDE_DIR]
    directories.extend(sorted(glob.glob(os.path.join(HOME, ".claude-profiles", "*"))))
    seen = set()
    for directory in directories:
        profile = os.path.realpath(directory)
        if profile in seen:
            continue
        seen.add(profile)
        for f in glob.glob(os.path.join(profile, "projects", "*", "*.jsonl")):
            yield "claude", f, profile
    homes = [CODEX_DIR, DEFAULT_CODEX_DIR]
    homes.extend(sorted(glob.glob(os.path.join(HOME, ".codex-*"))))
    seen_stores = set()
    for directory in homes:
        profile = os.path.realpath(directory)
        store = os.path.realpath(os.path.join(profile, "sessions"))
        if store in seen_stores or not os.path.isdir(store):
            continue
        seen_stores.add(store)
        for f in glob.glob(os.path.join(store, "*", "*", "*", "*.jsonl")):
            yield "codex", f, profile
    pi_home = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(HOME, ".pi", "agent"))
    pi_sessions = os.path.expanduser(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or os.path.join(pi_home, "sessions"))
    for f in glob.glob(os.path.join(pi_sessions, "**", "*.jsonl"), recursive=True):
        if SESSION_TRASH not in Path(os.path.relpath(f, pi_sessions)).parts:
            yield "pi", f, None


def agy_rows(sql, params=()):
    # The CLI owns this database. Open it read-only, including while agy is live.
    if not AGY_DB.is_file():
        return []
    try:
        with closing(sqlite3.connect(AGY_DB.as_uri() + "?mode=ro", uri=True, timeout=0.5)) as db:
            return db.execute(sql, params).fetchall()
    except sqlite3.Error:  # a CLI upgrade or a locked index must not hide other agents
        return []


def agy_workspaces(workspace_uris):
    try:
        uris = json.loads(workspace_uris)
    except (TypeError, ValueError):
        return []
    paths = []
    for uri in uris if isinstance(uris, list) else []:
        if not isinstance(uri, str):
            continue
        try:
            parsed = urlsplit(uri)
        except ValueError:
            continue
        if parsed.scheme != "file" or parsed.hostname not in (None, "localhost"):
            continue
        path = unquote(parsed.path)
        if os.name == "nt" and re.match(r"^/[a-zA-Z]:/", path):
            path = path[1:]
        if os.path.isabs(path) and "\0" not in path and path not in paths:
            paths.append(path)
    return paths


def agy_list():
    rows = agy_rows("""
        SELECT conversation_id, title, step_count, last_modified_time, workspace_uris
        FROM conversation_summaries
        WHERE COALESCE(parent_conversation_id, '') = ''
          AND COALESCE(killed, 0) = 0
        ORDER BY last_modified_time DESC
        LIMIT 500
    """)
    sessions = []
    for sid, title, steps, updated, uris in rows:
        if not sid or not steps:
            continue
        paths = agy_workspaces(uris)
        sessions.append({"agent": "agy", "id": sid, "file": sid, "title": clip(title or "Antigravity session", TITLE_MAX),
                         "cwd": paths[0] if paths else None, "workspaces": paths,
                         "updated": ms(updated), "created": 0, "steps": steps})
    return sessions


def agy_show(sid):
    rows = agy_rows("SELECT preview FROM conversation_summaries WHERE conversation_id = ?", (sid,))
    return {"summary": clip(rows[0][0], TEXT_MAX) if rows and rows[0][0] else "",
            "summaryOnly": True, "total": 0, "messages": []}


def index_file(agent, path):
    if agent == "claude":
        return claude_index(path)
    if agent == "codex":
        return codex_index(path)
    if agent == "pi":
        return pi_index(path)
    return None


def revision(info):
    # Keep nanoseconds and inode numbers exact across the JSON/JS boundary.
    return f"{info.st_dev}:{info.st_ino}:{info.st_mtime_ns}:{info.st_size}"


def trash_session(agent, ref, sid, expected):
    if agent not in ("claude", "codex", "pi") or not any(
        owner == agent and file == ref for owner, file, _ in file_sources()
    ):
        raise ValueError("This is not a recognized session on this host. Refresh History and try again.")
    source = Path(ref)
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Only regular session files can be moved to Session Trash.")
    if revision(info) != expected:
        raise ValueError("The session file changed. Close the session and refresh History before deleting it.")
    session = index_file(agent, ref)
    if not session or session["id"] != sid:
        raise ValueError("The file no longer matches the selected session. Refresh History and try again.")

    # Store the unmodified transcript on the same host and volume. A private
    # subdirectory makes the destination unique while keeping the original name.
    trash = source.parent / SESSION_TRASH
    trash.mkdir(mode=0o700, exist_ok=True)
    if not stat.S_ISDIR(trash.lstat().st_mode):
        raise ValueError("Session Trash must be a real directory.")
    slot = Path(tempfile.mkdtemp(dir=trash))
    destination = slot / source.name
    try:
        if revision(source.lstat()) != expected:
            raise ValueError("The session file changed. Close the session and refresh History before deleting it.")
        source.rename(destination)
    except (OSError, ValueError):
        slot.rmdir()
        raise
    return {"trash": str(destination)}


def cmd_list():
    try:
        with open(CACHE) as f:
            cache = json.load(f)
        if cache.get("v") != CACHE_VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    files = cache.get("files", {})
    fresh, sessions = {}, []
    for agent, path, profile in file_sources():
        try:
            st = os.stat(path)
        except OSError:
            continue
        stamp = [int(st.st_mtime * 1000), st.st_size]
        hit = files.get(path)
        if hit and hit.get("stamp") == stamp:
            entry = hit.get("session")
        else:
            try:
                entry = index_file(agent, path)
                default = {"claude": DEFAULT_CLAUDE_DIR, "codex": DEFAULT_CODEX_DIR}.get(agent)
                if entry and profile and profile != default:
                    entry["profile"] = profile
            except Exception:  # one unreadable transcript never hides the rest
                entry = None
        fresh[path] = {"stamp": stamp, "session": entry}
        if entry:
            sessions.append({**entry, "revision": revision(st)})
    tmp = None
    try:
        cache_dir = os.path.dirname(CACHE)
        os.makedirs(cache_dir, mode=0o700, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cache_dir, delete=False) as f:
            tmp = f.name
            json.dump({"v": CACHE_VERSION, "files": fresh}, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    titles = {}
    for s in sessions:
        if s["agent"] != "codex":
            continue
        profile = s.get("profile", DEFAULT_CODEX_DIR)
        if profile not in titles:
            titles[profile] = codex_titles(profile)
        if s["id"] in titles[profile]:
            s["title"] = clip(titles[profile][s["id"]], TITLE_MAX)
    sessions.extend(agy_list())
    sessions.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return sessions


def cmd_show(agent, ref):
    if agent == "agy":
        return agy_show(ref)
    if agent == "claude":
        msgs = claude_show(ref)
    elif agent == "codex":
        msgs = codex_show(ref)
    elif agent == "pi":
        msgs = pi_show(ref)
    else:
        msgs = []
    # Merge consecutive tool lines so a long tool burst reads as one block.
    merged = []
    for m in msgs:
        m["text"] = clip(m["text"].strip(), TEXT_MAX)
        if not m["text"]:
            continue
        if merged and m["role"] == "tool" and merged[-1]["role"] == "tool":
            if len(merged[-1]["text"]) < TEXT_MAX:
                merged[-1]["text"] = clip(merged[-1]["text"] + "\n" + m["text"], TEXT_MAX)
        else:
            merged.append(m)
    total = len(merged)
    return {"total": total, "messages": merged[-SHOW_MAX:]}


def main():
    args = sys.argv[1:]
    if args[:1] == ["list"]:
        result = cmd_list()
    elif args[:1] == ["show"] and len(args) == 3:
        result = cmd_show(args[1], args[2])
    elif args[:1] == ["trash"] and len(args) == 5:
        try:
            result = trash_session(*args[1:])
        except (OSError, ValueError) as error:
            print(error, file=sys.stderr)
            sys.exit(1)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


if __name__ == "__main__":
    main()
