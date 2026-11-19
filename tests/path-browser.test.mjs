import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function evalMod(name, file, result, globals) {
  const code = readFileSync(new URL(`../mods/${name}/${file}`, import.meta.url), "utf8");
  return vm.runInNewContext(code.replace(/^import .*;$/gm, "").replace(/^export (default )?/gm, "") + "\n" + result,
    { View: class {}, ...globals });
}

test("path resolver uses host argv, accepts literal Unicode paths and rejects files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-folder-"));
  const child = "目录 'literal'";
  const calls = [];
  const resolve = evalMod("files-md-tools", "browse-path.js", "resolveDirectory", {
    exec: (program, argv, options) => {
      calls.push({ program, argv, options });
      const r = spawnSync(program, argv, { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  });
  try {
    mkdirSync(join(root, child));
    writeFileSync(join(root, "not a directory"), "fixture");
    assert.equal(await resolve(child, root, "owning-host"), realpathSync(join(root, child)));
    assert.equal(calls[0].options.on, "owning-host");
    assert.equal(calls[0].argv.at(-2), child);
    assert.equal(await resolve("~", null, null), realpathSync(root));
    await assert.rejects(resolve("not a directory", root, null));
    await assert.rejects(resolve("  ", root, null), /Enter a folder path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shortcut splits the focused pane, terminal menu splits the clicked pane", () => {
  const panes = () => [{ pane: "local-pane", cwd: "/local", tab: "t1" }, { pane: "remote-pane", cwd: "/remote", tab: "t2" }];
  const spaces = () => [{ id: "local", tabs: [{ id: "t1" }] }, { id: "remote", machine: "host", tabs: [{ id: "t2" }] }];
  const calls = [];
  const Tabs = evalMod("tabs-tools", "main.js", "Tabs", {
    panes, spaces, focused: () => ({ pane: "local-pane", space: "local" }), run: (...args) => calls.push(args),
  });
  new Tabs().openFilesPath();
  assert.equal(calls[0][0], "pane.split");
  assert.equal(calls[0][1].pane, "local-pane");
  assert.equal(calls[0][1].props.base, "/local");
  assert.equal(calls[0][1].props.on, null);
  const menu = evalMod("terminal-menu-tools", "main.js", "items", { panes, spaces, terminals: () => [] });
  const rows = menu({ pane: "remote-pane", terminal: "term" });
  assert.equal(rows[0][0], "New Files…");
  assert.equal(rows[0][3].pane, "remote-pane");
  assert.equal(rows[0][3].mod, "files-md-tools");
  assert.equal(rows[0][3].props.on, "host");
  assert.equal(rows[0][3].props.base, "/remote");
  assert.ok(rows.some(row => row[2] === "pane.close"));
});

test("independent Files panes keep their selected root across terminal cwd changes and bad submissions", async () => {
  const Files = evalMod("files-md-tools", "main.js", "Files", {
    checking: () => false,
    resolveDirectory: async (path, base) => {
      if (path === "missing") throw Error("Folder not found");
      return base + "/" + path;
    },
  });
  const jobs = [];
  const cx = { spawn: task => jobs.push(task(cx)), notify() {} };
  let value = "new";
  const pane = new Files();
  pane.browser = { cwd: "/original", base: "/original", on: "remote", space: "space" };
  pane.pathInput = { value: () => value, set_value: v => { value = v; } };
  pane.handle = { focus() {} };
  pane.refresh = () => {};
  pane.goToPath(cx);
  await jobs.shift();
  assert.equal(pane.location().cwd, "/original/new");
  assert.equal(pane.location().on, "remote");
  value = "missing";
  pane.goToPath(cx);
  await jobs.shift();
  assert.equal(pane.location().cwd, "/original/new");
  assert.match(pane.pathError, /Folder not found/);
});
