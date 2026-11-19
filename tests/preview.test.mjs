import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const previewDir = new URL("../mods/md-preview-tools/", import.meta.url);
const source = (name) => readFileSync(new URL(name, previewDir), "utf8");
const fileHelper = fileURLToPath(new URL("file_preview.py", previewDir));

function loadView(code, className, globals) {
  return vm.runInNewContext(
    code.replace(/^import .*;$/gm, "").replace("export default class", "class") + "\n" + className,
    { View: class {}, ...globals },
  );
}

function fileBrowser() {
  const state = new Map(), commands = [], jobs = [];
  const panes = [{ tab: "tab", pane: "terminal", terminal: "t", focused: true, cwd: "/demo" }];
  const focus = { tab: "tab", pane: "terminal", cwd: "/demo" };
  const cx = {
    focus_handle: () => ({ focus() {}, is_focused: () => true }), notify() {},
    timer: { after: (_, callback) => jobs.push(callback) }, spawn() {},
  };
  const Files = loadView(readFileSync(new URL("../mods/files-md-tools/main.js", import.meta.url), "utf8"), "Files", {
    checking: () => true, props: () => ({}), FILE_CHANGE: "files-change",
    ScrollHandle: { new: () => ({}) }, panes: () => panes, focused: () => focus,
    spaces: () => [{ active: true, id: "space" }], shared: (key) => state.get(key),
    setShared: (key, value) => state.set(key, value), run: (name, args) => commands.push({ name, args }),
  });
  const view = new Files();
  view.init({}, cx);
  view.root = "/demo";
  view.context = {};
  return { view, state, commands, jobs, panes, cx };
}

test("Markdown and images reuse the same right split during rapid selection", () => {
  const { view, state, commands, panes, cx } = fileBrowser();
  for (const path of ["readme.md", "photo.jpg"]) view.choose({ path, entry: {} }, cx);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "pane.split");
  assert.equal(commands[0].args.direction, "right");
  assert.equal(commands[0].args.pane, "terminal");
  panes.push({ tab: "tab", pane: "preview", mod: "md-preview-tools" });
  view.choose({ path: "next.png", entry: {} }, cx);
  assert.equal(commands.length, 1);
  assert.equal(state.get("md-preview-tools.selection:tab").file, "/demo/next.png");
});

test("click and keyboard selection route plain text, code, and binary files to Preview", () => {
  const { view, state, commands, jobs, cx } = fileBrowser();
  view.choose({ path: ".env.example", entry: {} }, cx);
  assert.equal(commands[0]?.name, "pane.split", "click opens the split, even for an unknown extension");
  view.entries.set("", [{ name: ".env.example" }, { name: "script.js" }, { name: "archive.bin" }]);
  const down = { key: "down", modifiers: {} };
  cx.stop_propagation = () => {};
  view.keyDown(down, cx);
  view.keyDown(down, cx);
  for (const callback of jobs) callback(cx);
  assert.equal(state.get("md-preview-tools.selection:tab").file, "/demo/archive.bin");
  assert.equal(commands.length, 1);
  assert.ok(!view.file, "the Files tree stays visible");
});

test("preview load burst stays serial, skips superseded files, and discards results on close", async () => {
  const starts = [], completions = [], workers = [];
  let active = 0, peak = 0;
  const pending = (file) => {
    starts.push(file);
    peak = Math.max(peak, ++active);
    return new Promise((resolve) => completions.push(() => {
      --active;
      resolve({ path: file, width: 1, height: 1 });
    }));
  };
  const Preview = loadView(source("main.js"), "MarkdownPreview", {
    props: () => ({}), checking: () => true, isImagePath: () => true, prepareImage: pending,
  });
  const cx = { spawn: (task) => workers.push(task(cx)), notify() {}, timer: {} };
  const view = new Preview();
  view.init({}, cx);
  const started = performance.now();
  for (let i = 0; i < 500; i++) {
    view.file = `image-${i}.png`;
    view.load(cx);
  }
  const queuedMs = performance.now() - started;
  assert.ok(queuedMs < 1500, `500 selections took ${queuedMs.toFixed(1)} ms`);
  assert.deepEqual(starts, ["image-0.png"]);
  completions.shift()();
  await new Promise(setImmediate);
  assert.deepEqual(starts, ["image-0.png", "image-499.png"]);
  view.close();
  completions.shift()();
  await Promise.all(workers);
  assert.equal(peak, 1);
  assert.equal(view.pendingLoad, null);
  assert.equal(view.imageData, null);
  console.log(`# queued 500 selections in ${queuedMs.toFixed(1)} ms, ${starts.length} loads, peak concurrency ${peak}`);
});

test("large JPG preparation scales to 2048px and reuses its cache", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-image-baseline-"));
  try {
    const ppm = join(dir, "test.ppm"), jpg = join(dir, "test.jpg");
    writeFileSync(ppm, Buffer.concat([Buffer.from("P6\n32 24\n255\n"), Buffer.alloc(32 * 24 * 3, 125)]));
    execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", "-z", "6000", "8000", ppm, "--out", jpg], { stdio: "pipe" });
    const original = readFileSync(jpg);
    const prepare = () => {
      const start = performance.now();
      const value = JSON.parse(execFileSync("python3", [fileURLToPath(new URL("images.py", previewDir)), jpg, dir], { timeout: 15000 }));
      return { value, elapsed: performance.now() - start };
    };
    const cold = prepare(), warm = prepare();
    assert.equal(cold.value.width, 2048);
    assert.equal(cold.value.height, 1536);
    assert.equal(warm.value.path, cold.value.path);
    assert.ok(cold.elapsed < 10000 && warm.elapsed < 3000);
    assert.ok(statSync(join(dir, cold.value.path)).size < 15 * 1024 * 1024);
    assert.deepEqual(readFileSync(jpg), original);
    console.log(`# 48 MP JPG helper cold ${cold.elapsed.toFixed(1)} ms, warm ${warm.elapsed.toFixed(1)} ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generic preview identifies text encodings, bounded binary payloads, and unavailable paths", () => {
  assert.ok(existsSync(fileHelper), "the generic preview reader is missing");
  const dir = mkdtempSync(join(tmpdir(), "pixel-file-baseline-"));
  const read = (path) => JSON.parse(execFileSync("python3", [fileHelper, path], { timeout: 5000 }));
  try {
    const plain = join(dir, "设置 'sample'.unknown");
    writeFileSync(plain, "hello 世界\n");
    assert.equal(read(plain).text, "hello 世界\n");
    const utf16 = join(dir, "unicode");
    writeFileSync(utf16, Buffer.concat([Buffer.from([255, 254]), Buffer.from("雪", "utf16le")]));
    assert.equal(read(utf16).text, "雪");
    const empty = join(dir, "empty");
    writeFileSync(empty, "");
    assert.equal(read(empty).text, "");
    const binary = join(dir, "sample.pdf");
    writeFileSync(binary, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1024, 0)]));
    const info = read(binary);
    assert.equal(info.kind, "binary");
    assert.equal(info.size, 1033);
    assert.match(info.hex, /25 50 44 46/);
    assert.equal(info.truncated, true);
    if (process.platform !== "win32") {
      const fifo = join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);
      assert.equal(read(fifo).kind, "error");
    }
    assert.equal(read(dir).kind, "error");
    assert.equal(read(join(dir, "missing")).kind, "error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plain files use a read-only editor and image failures retain a hex preview", async () => {
  const workers = [], states = [];
  const Preview = loadView(source("main.js"), "MarkdownPreview", {
    props: () => ({}), checking: () => true, isImagePath: (file) => file.endsWith(".png"),
    isMarkdown: (file) => file.endsWith(".md"), sourceLanguage: (file) => file.endsWith(".js") ? "js" : "txt",
    prepareImage: async () => { throw new Error("Invalid PNG"); },
    readPreviewFile: async (file) => file.endsWith(".png")
      ? { kind: "binary", hex: "00 ff", size: 2 }
      : { kind: "text", text: "const x = 1;", size: 12 },
    EditorState: { new(options) {
      const state = { options, released: false, release() { this.released = true; } };
      states.push(state);
      return state;
    } },
    theme: () => ({}), settings: () => ({}),
  });
  const cx = { spawn: (task) => workers.push(task(cx)), notify() {} };
  const view = new Preview();
  view.init({}, cx);
  view.file = "code.js";
  view.load(cx);
  await workers.shift();
  assert.equal(view.source.options.language, "js");
  assert.equal(view.source.options.readonly, true);
  view.file = "broken.png";
  view.load(cx);
  await workers.shift();
  assert.equal(view.fileInfo.kind, "binary");
  assert.equal(view.source.options.value, "00 ff");
  assert.equal(view.imageData, null);
  assert.match(view.notice, /Invalid PNG/);
  assert.equal(states[0].released, true);
  view.close();
  assert.equal(states[1].released, true);
});

test("large text and binary files stay within preview payload and latency budgets", () => {
  assert.ok(existsSync(fileHelper), "the generic preview reader is missing");
  const dir = mkdtempSync(join(tmpdir(), "pixel-file-performance-"));
  try {
    for (const [name, prefix, kind] of [
      ["large.log", Buffer.alloc(256 * 1024, 65), "text"], ["large.bin", Buffer.alloc(512), "binary"],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, prefix);
      truncateSync(path, 512 * 1024 * 1024);
      const start = performance.now();
      const options = { timeout: 5000, maxBuffer: 1024 * 1024 };
      const measured = process.platform === "darwin"
        ? spawnSync("/usr/bin/time", ["-l", "python3", fileHelper, path], options)
        : spawnSync("python3", [fileHelper, path], options);
      assert.ifError(measured.error);
      assert.equal(measured.status, 0, measured.stderr.toString());
      const bytes = measured.stdout;
      const elapsed = performance.now() - start;
      const value = JSON.parse(bytes);
      assert.equal(value.kind, kind);
      assert.equal(value.size, 512 * 1024 * 1024);
      assert.equal(value.truncated, true);
      if (kind === "text") assert.equal(value.text.length, 256 * 1024);
      assert.ok(bytes.length < (kind === "text" ? 300 * 1024 : 4096));
      assert.ok(elapsed < 3000, `${name} took ${elapsed.toFixed(1)} ms`);
      const rss = Number(measured.stderr.toString().match(/(\d+)\s+maximum resident set size/)?.[1]);
      if (rss) assert.ok(rss < 64 * 1024 * 1024, "helper peak RSS exceeds 64 MiB");
      console.log(`# ${name}: 512 MiB source, ${bytes.length} serialized bytes, ${elapsed.toFixed(1)} ms`
        + (rss ? `, ${(rss / 1024 / 1024).toFixed(1)} MiB helper peak RSS` : ""));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
