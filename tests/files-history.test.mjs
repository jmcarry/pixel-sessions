import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
    fixture(join(codex, "session_index.jsonl"), [{ id: "test-codex", thread_name: "Fixture title" }]);
    const items = run("list");
    assert.deepEqual(items.map(row => row.agent).sort(), ["claude", "codex"]);
    assert.equal(items.find(row => row.agent === "codex").title, "Fixture title");
    for (const item of items) {
      const opened = run("show", item.agent, item.file);
      assert.equal(opened.messages[0].role, "user");
      assert.match(opened.messages[0].text, /雪/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
});
