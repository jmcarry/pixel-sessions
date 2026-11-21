import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const actions = fileURLToPath(new URL("../mods/files-md-tools/file_actions.py", import.meta.url));
const historyHelper = new URL("../mods/history-tools/history.py", import.meta.url);
const historyView = new URL("../mods/history-tools/main.js", import.meta.url);

test("file mutations preserve existing files, reject invalid paths, and unlink only the chosen file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-file-actions-"));
  const run = (...args) => spawnSync("python3", [actions, ...args], { encoding: "utf8", timeout: 5000 });
  try {
    const src = join(dir, "01 '雪'.txt"), dst = join(dir, "02 space.txt");
    writeFileSync(src, "source");
    writeFileSync(dst, "keep");
    for (const name of ["../escape", "02 space.txt"]) {
      const error = run("rename", src, name);
      assert.equal(error.status, 1);
      assert.equal(readFileSync(src, "utf8"), "source");
      assert.equal(readFileSync(dst, "utf8"), "keep");
    }
    const rename = run("rename", src, "03 new.txt");
    assert.equal(rename.status, 0, rename.stderr);
    assert.equal(existsSync(src), false);
    const renamed = join(dir, "03 new.txt");
    assert.equal(readFileSync(renamed, "utf8"), "source");
    assert.equal(run("delete", dir).status, 1);
    assert.equal(run("delete", renamed).status, 0);
    assert.equal(existsSync(renamed), false);
    assert.equal(readFileSync(dst, "utf8"), "keep");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI parser uses configured Codex and Claude stores on the executing machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-history-"));
  const codex = join(dir, "custom-codex"), claude = join(dir, "custom-claude");
  const stamp = "2026-11-20T10:00:00Z";
  const script = readFileSync(historyHelper, "utf8");
  const fixture = (path, records) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  };
  const run = (...args) => {
    const result = spawnSync("python3", ["-c", script, ...args], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const cf = join(codex, "sessions/2026/11/20/demo.jsonl");
    const af = join(claude, "projects/demo/test-claude.jsonl");
    fixture(cf, [
      { type: "session_meta", payload: { id: "test-codex", cwd: dir, timestamp: stamp } },
      { type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: "Codex 雪" } },
    ]);
    fixture(af, [{ type: "user", timestamp: stamp, cwd: dir, message: { content: "Claude 雪" } }]);
    const extra = join(dir, ".claude-profiles/team");
    fixture(join(extra, "projects/demo/team-claude.jsonl"),
      [{ type: "user", timestamp: stamp, cwd: dir, message: { content: "Team 雪" } }]);
    fixture(join(codex, "session_index.jsonl"), [{ id: "test-codex", thread_name: "Fixture title" }]);
    const yanick = join(dir, ".codex-yanick");
    fixture(join(yanick, "sessions/2026/11/20/yanick.jsonl"), [
      { type: "session_meta", payload: { id: "test-codex", cwd: dir, timestamp: stamp } },
      { type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: "Yanick 雪" } },
    ]);
    fixture(join(yanick, "session_index.jsonl"), [{ id: "test-codex", thread_name: "Yanick title" }]);
    const items = run("list");
    assert.deepEqual(items.map(row => row.agent).sort(), ["claude", "claude", "codex", "codex"]);
    assert.equal(items.find(row => row.profile === realpathSync(codex)).title, "Fixture title");
    assert.equal(items.find(row => row.profile === realpathSync(yanick)).title, "Yanick title");
    assert.equal(items.find(row => row.id === "team-claude").profile, realpathSync(extra));
    for (const item of items) {
      const opened = run("show", item.agent, item.file);
      assert.equal(opened.messages[0].role, "user");
      assert.match(opened.messages[0].text, /雪/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("History lists AGY workspaces and opens a bounded summary from the read-only index", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-agy-"));
  const script = readFileSync(historyHelper, "utf8");
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
  const run = (body, ...args) => {
    const result = spawnSync("python3", ["-c", body, ...args], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    const folder = join(dir, "测试 project");
    run(`import os, sqlite3, sys
from pathlib import Path
p = Path.home() / ".gemini/antigravity-cli/conversation_summaries.db"
p.parent.mkdir(parents=True)
with sqlite3.connect(p) as db:
    db.execute("create table conversation_summaries(conversation_id, title, step_count, last_modified_time, workspace_uris, parent_conversation_id, killed, preview)")
    db.executemany("insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?, ?)", [
        ("valid", "Fixture project", 5, "2026-11-20 01:02:03+00:00", sys.argv[1], "", 0, "x" * 10000),
        ("child", "Child", 3, "2026-11-20 01:02:03+00:00", sys.argv[1], "valid", 0, ""),
        ("deleted", "Deleted", 3, "2026-11-20 01:02:03+00:00", sys.argv[1], "", 1, ""),
    ])`, JSON.stringify([pathToFileURL(folder).href]));
    const db = join(dir, ".gemini/antigravity-cli/conversation_summaries.db");
    const before = readFileSync(db);
    const rows = JSON.parse(run(script, "list"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, "agy");
    assert.equal(rows[0].cwd, folder);
    assert.equal(rows[0].steps, 5);
    const view = JSON.parse(run(script, "show", "agy", rows[0].file));
    assert.equal(view.summaryOnly, true);
    assert.equal(view.summary.length <= 6000, true);
    const deletion = spawnSync("python3", ["-c", script, "trash", "agy", rows[0].file, rows[0].id, "fixture"], { env });
    assert.equal(deletion.status, 1);
    assert.deepEqual(readFileSync(db), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Session Trash moves only verified, unchanged transcripts and preserves them for recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-session-trash-"));
  const script = readFileSync(historyHelper, "utf8");
  const pi = join(dir, ".pi/agent/sessions");
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "",
    PI_CODING_AGENT_SESSION_DIR: pi };
  const stamp = "2026-11-20T01:02:03Z";
  const fixture = (path, rows) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return path;
  };
  const run = (...args) => spawnSync("python3", ["-c", script, ...args], { env, encoding: "utf8", timeout: 5000 });
  const read = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    fixture(join(dir, ".claude/projects/demo/claude.jsonl"), [
      { type: "user", timestamp: stamp, cwd: dir, message: { content: "Test Claude" } },
    ]);
    fixture(join(dir, ".codex/sessions/2026/11/20/codex.jsonl"), [
      { type: "session_meta", payload: { id: "test-codex", cwd: dir, timestamp: stamp } },
      { type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: "Test Codex" } },
    ]);
    fixture(join(pi, "nested/pi.jsonl"), [
      { type: "session", id: "test-pi", cwd: dir, timestamp: stamp },
      { type: "message", timestamp: stamp, message: { role: "user", content: "Test Pi" } },
    ]);
    const rows = read("list");
    assert.equal(rows.length, 3);
    const codex = rows.find(row => row.agent === "codex");
    const foreign = fixture(join(dir, "unmanaged.jsonl"), [{ type: "user", message: { content: "Keep" } }]);
    assert.equal(run("trash", "codex", foreign, codex.id, codex.revision).status, 1);
    assert.equal(run("trash", "codex", codex.file, "wrong-id", codex.revision).status, 1);
    appendFileSync(codex.file, "\n");
    assert.equal(run("trash", "codex", codex.file, codex.id, codex.revision).status, 1);
    assert.equal(existsSync(codex.file), true);
    assert.equal(existsSync(foreign), true);

    const recover = [];
    for (const row of read("list")) {
      const bytes = readFileSync(row.file);
      const { trash } = read("trash", row.agent, row.file, row.id, row.revision);
      assert.match(trash, /\.pixel-sessions-trash/);
      assert.equal(existsSync(row.file), false);
      assert.deepEqual(readFileSync(trash), bytes);
      recover.push([trash, row.file]);
    }
    assert.equal(read("list").length, 0);
    for (const [trash, file] of recover) renameSync(trash, file);
    assert.equal(read("list").length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("History waits for confirmation and moves the selected session on its owning host", async () => {
  const calls = [], tasks = [];
  const implementation = readFileSync(historyView, "utf8")
    .replace(/^import .*;$/gm, "").replace("export default class", "class") + "\nHistory";
  const History = vm.runInNewContext(implementation, {
    View: class {}, checking: () => false, readTextFile: async () => "helper", appHome: () => "/app",
    exec: async (command, argv, options) => {
      calls.push({ command, argv, options });
      return { code: 0, stdout: '{"trash":"/recovery/transcript.jsonl"}' };
    },
  });
  const session = { agent: "claude", id: "id", file: "/transcript.jsonl", revision: "revision", machine: "owning-host" };
  const view = new History();
  view.machine = "viewed-host"; // A host switch must never redirect the action.
  view.sessions = [session];
  const cx = { spawn: task => tasks.push(task(cx)), notify() {} };
  view.requestDelete(session, cx);
  assert.equal(calls.length, 0);
  view.confirmDelete(cx);
  view.confirmDelete(cx);
  await Promise.all(tasks);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, "owning-host");
  assert.deepEqual([...calls[0].argv], ["-c", "helper", "trash", "claude", "/transcript.jsonl", "id", "revision"]);
  assert.equal(view.trashed.path, "/recovery/transcript.jsonl");
  assert.equal(view.pendingDelete, null);
});

test("History ignores old host responses and resumes sessions on the owning machine", async () => {
  const calls = [], args = [], waits = new Map(), tasks = [];
  const spaces = [
    { id: "local-space", machine: null, folder: "/same", tabs: [] },
    { id: "remote-space", machine: "example-host", folder: "/same", active: true, tabs: [] },
  ];
  const implementation = readFileSync(historyView, "utf8")
    .replace(/^import .*;$/gm, "").replace("export default class", "class") + "\nHistory";
  const History = vm.runInNewContext(implementation, {
    View: class {}, checking: () => false, spaces: () => spaces, focused: () => null, panes: () => [],
    run: (name, options) => calls.push({ name, ...options }), readTextFile: async () => "helper", appHome: () => "/app",
    exec: async (command, argv, options) => {
      args.push({ command, argv, options });
      if (command === "git") return { code: 1, stdout: "" };
      if (argv.includes("show")) return { code: 0, stdout: '{"messages":[{"text":"remote"}]}' };
      return new Promise(resolve => waits.set(options.on, resolve));
    },
  });
  const cx = { spawn: task => tasks.push(task(cx)), notify() {} };
  const view = new History();
  view.syncRoot(cx);
  await new Promise(setImmediate);
  assert.equal(args.find(call => call.command === "git").options.on, "example-host");
  assert.deepEqual([...args.find(call => call.command === "python3").argv], ["-c", "helper", "list"]);
  view.chooseHost(null, cx);
  assert.equal(view.scope, "all");
  waits.get(null)({ code: 0, stdout: '[{"agent":"codex","id":"local","cwd":"/same"}]' });
  waits.get("example-host")({ code: 0, stdout: '[{"agent":"claude","id":"remote"}]' });
  await Promise.all(tasks);
  assert.equal(view.sessions[0].id, "local");
  view.chooseHost(undefined, cx);
  assert.equal(view.scope, "here");
  await new Promise(setImmediate);
  waits.get("example-host")({ code: 0, stdout: '[{"agent":"claude","id":"remote","cwd":"/elsewhere"}]' });
  await Promise.all(tasks);
  // A host selected by name shows all its sessions, even in an active space
  // whose project directory differs from the recorded session.
  view.query = "";
  assert.equal(view.visible().length, 0);
  view.chooseHost("example-host", cx);
  assert.equal(view.visible().length, 1);
  const remote = { agent: "claude", id: "remote", machine: "example-host", cwd: "/same", file: "/fixture" };
  view.show(remote, cx);
  await tasks.at(-1);
  assert.equal(args.at(-1).options.on, "example-host");
  assert.equal(view.transcript.messages[0].text, "remote");
  view.resume(remote);
  view.resume({ agent: "codex", id: "local", machine: null, cwd: "/same" });
  view.resume({ ...remote, machine: "other-host" });
  assert.equal(calls[0].space, "remote-space");
  assert.equal(calls[1].space, "local-space");
  assert.equal(calls[2].name, "space.new");
  assert.equal(calls[2].machine, "other-host");
  view.scope = "here";
  const agy = { agent: "agy", id: "conversation", machine: "example-host", cwd: "/another", workspaces: ["/another", "/same"], title: "AGY" };
  view.sessions = [agy];
  assert.equal(view.visible().length, 1);
  view.resume(agy);
  assert.deepEqual([...calls[3].argv], ["agy", "--conversation", "conversation"]);
  assert.equal(calls[3].folder, "/same");
  view.resume({ ...remote, profile: "/profiles/claudy" });
  assert.deepEqual([...calls[4].argv].slice(-2), ["/profiles/claudy", "remote"]);
  view.launchers = { claude: { "/profiles/claudy": "claudy" }, agy: "agydot" };
  view.resume({ ...remote, machine: null, profile: "/profiles/claudy", id: "session with spaces" });
  assert.deepEqual([...calls[5].argv], ["/bin/zsh", "-lic", 'claudy "$@"', "herdr-history", "--resume", "session with spaces"]);
  view.resume({ ...agy, machine: null });
  assert.deepEqual([...calls[6].argv], ["/bin/zsh", "-lic", 'agydot "$@"', "herdr-history", "--conversation", "conversation"]);
  view.resume(agy);
  assert.deepEqual([...calls[7].argv], ["agy", "--conversation", "conversation"]);
  const yanick = { agent: "codex", id: "yanick-session", profile: "/custom/.codex-yanick", cwd: "/same" };
  view.scope = "all";
  view.sessions = [agy, yanick];
  view.query = "codex-yanick";
  assert.deepEqual([...view.visible()], [yanick]);
  view.resume(yanick);
  assert.match(calls[8].argv[2], /"CODEX_HOME".*--no-daemon/);
  assert.deepEqual([...calls[8].argv].slice(-2), ["/custom/.codex-yanick", "yanick-session"]);
});
