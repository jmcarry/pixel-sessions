// Modified for Pixel Sessions; pinned upstream provenance and licensing are in THIRD_PARTY_NOTICES.md.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, checking, shared, setShared, nextCommand } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const terminal = allPanes.find(p => p.tab === f?.tab && p.terminal && p.cwd);
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || terminal?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");
const isImagePath = (path) => /\.(?:jpe?g|jpe|png|svg|gif|webp|avif|heic|heif|heics|tiff?|bmp|icns|ico|jp2|j2k|jpf|jpx|psd|dng|cr2|cr3|nef|nrw|arw|raf|orf|rw2|pef|srw|exr|tga|pict|pct)$/i.test(path ?? "");

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.selected = null;
    this.selectionGeneration = 0;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watchRequest?.cancel();
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context && this.watched === root) {
          const request = watchFolder(root);
          this.watchRequest = request;
          await request;
          if (this.watchRequest === request) this.watchRequest = null;
          if (this.current(context)) this.refresh(cx);
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  close() {
    this.watchRequest?.cancel();
    this.code?.release();
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, selected: this.selected, selectedIndex: this.selectedIndex });
      this.watchRequest?.cancel(); this.watchRequest = null;
      const saved = this.saved.get(next);
      this.selected = saved?.selected ?? null; this.selectedIndex = saved?.selectedIndex ?? 0;
      this.selectionGeneration++; this.previewFocus = null; this.revealed = null;
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        if (this.file) this.show(this.file, cx, true);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, refresh = false) {
    if (!refresh) {
      this.code?.release(); this.code = null; this.file = path; this.fileError = null;
      this.markdown = null; this.mdSource = false; this.fileText = null;
    }
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (refresh && text === this.fileText) return;
        this.code?.release(); this.code = null; this.markdown = null;
        this.fileText = text; this.fileError = null;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        if (isMarkdown(path)) { this.markdown = text.length > 300000 ? text.slice(0, 300000) + "\n\n… (file truncated)" : text; this.mdVersion = (this.mdVersion ?? 0) + 1; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Relative .md links open in this panel; web links in the browser.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [url]).catch(() => null);
      return;
    }
    let target;
    try { target = decodeURI(url.split("#")[0]); } catch { return; }
    if (!target || target.startsWith("/") || !isMarkdown(target)) return;
    const parts = [...this.file.split("/").slice(0, -1), ...target.split("/")], out = [];
    for (const part of parts) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
    this.show(out.join("/"), cx); cx.notify();
  }

  selectFile(path, cx, { focusPreview = true } = {}) {
    if (isMarkdown(path) || isImagePath(path)) this.openPane(path, { focusPreview, cx });
    else this.show(path, cx);
  }

  // Resolve the new pane after the host applies a split. Never guess ownership
  // of an older, manually opened preview or a preview in another tab.
  syncPreviewPanes(cx) {
    const stored = shared("md-preview-tools.panes") ?? {};
    let next = stored;
    const current = panes();
    for (const [tab, entry] of Object.entries(stored)) {
      if (entry.pane || !entry.before) continue;
      const found = current.find(p => p.tab === tab && p.mod === "md-preview-tools" && !entry.before.includes(p.pane));
      if (found) {
        if (next === stored) next = { ...stored };
        next[tab] = { pane: found.pane };
        const restore = this.previewFocus;
        if (restore?.tab === tab && cx) {
          this.previewFocus = null;
          cx.timer.after(0, cx => {
            const focus = focused();
            if (this.context === restore.context && focus?.tab === tab && focus?.pane === found.pane) {
              this.handle.focus(); cx.notify();
            }
          });
        }
      }
    }
    if (next !== stored) setShared("md-preview-tools.panes", next);
    return next;
  }

  openPane(path = this.file, { focusPreview = true, cx = null } = {}) {
    if (!path || !this.root) return;
    const all = panes(), focus = focused();
    const space = spaces().find(s => s.active);
    const tab = focus?.tab ?? space?.tabs?.find(t => t.active)?.id;
    if (!tab) return;
    const selectionKey = `md-preview-tools.selection:${tab}`;
    const previous = shared(selectionKey);
    setShared(selectionKey, { file: `${this.root}/${path}`, on: this.on ?? null, version: (previous?.version ?? 0) + 1 });
    const registry = this.syncPreviewPanes(cx);
    const entry = registry[tab];
    const existing = all.find(p => p.tab === tab && p.mod === "md-preview-tools" && p.pane === entry?.pane);
    if (existing) { if (focusPreview) run("pane.focus", { pane: existing.pane }); return; }
    // A second click while the host is applying the first split only updates
    // its shared selection, so rapid file changes do not add duplicate panes.
    if (entry?.before && Date.now() - entry.requestedAt < 1500) return;
    const mine = all.filter(p => p.tab === tab);
    const source = mine.find(p => p.terminal && p.focused) ?? mine.find(p => p.terminal)
      ?? mine.find(p => p.mod !== "md-preview-tools");
    if (!source) return;
    setShared("md-preview-tools.panes", { ...registry, [tab]: { before: mine.map(p => p.pane), requestedAt: Date.now() } });
    if (!focusPreview) this.previewFocus = { tab, context: this.context };
    run("pane.split", { pane: source.pane, direction: "right", mod: "md-preview-tools",
      props: { file: `${this.root}/${path}`, on: this.on ?? null, tab, selectionKey } });
  }

  visibleRows(prefix = "", depth = 0, out = []) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ entry, path, depth, parent: prefix });
      if (entry.dir && this.folders.has(path)) this.visibleRows(path, depth + 1, out);
    }
    return out;
  }

  revealSelection(rows) {
    let at = rows.findIndex(row => row.path === this.selected);
    if (this.selected && at < 0 && rows.length) {
      let parent = this.selected;
      while (at < 0 && parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        at = rows.findIndex(row => row.path === parent);
      }
      if (at < 0) at = Math.min(this.selectedIndex ?? 0, rows.length - 1);
      this.selected = rows[at].path;
    }
    if (at >= 0) {
      this.selectedIndex = at;
      if (this.revealed !== this.selected || this.revealedIndex !== at) {
        this.revealed = this.selected; this.revealedIndex = at;
        this.scroll.scroll_to_item(at);
      }
    }
  }

  choose(row, cx, { activate = false, toggle = false, delay = 0 } = {}) {
    if (!row) return;
    this.selected = row.path;
    this.handle.focus();
    const generation = ++this.selectionGeneration, context = this.context;
    if (row.entry.dir) {
      if (toggle) this.toggle(row.path, cx);
    } else if (isMarkdown(row.path) || isImagePath(row.path)) {
      const preview = cx => {
        if (this.selectionGeneration !== generation || this.context !== context || this.selected !== row.path || !this.handle.is_focused()) return;
        this.show(null);
        this.selectFile(row.path, cx, { focusPreview: false });
      };
      if (delay) cx.timer.after(delay, preview);
      else preview(cx);
    } else if (activate) this.show(row.path, cx);
    cx.notify();
  }

  keyDown(event, cx) {
    if (!this.handle.is_focused() || this.file) return;
    const modifiers = event.modifiers ?? {};
    if (modifiers.control || modifiers.alt || modifiers.platform || modifiers.shift) return;
    const rows = this.visibleRows(), key = event.key;
    let at = rows.findIndex(row => row.path === this.selected);
    const current = rows[at];
    if (key === "down" || key === "up") {
      if (!rows.length) return;
      if (at < 0) at = key === "down" ? -1 : rows.length;
      at = Math.max(0, Math.min(rows.length - 1, at + (key === "down" ? 1 : -1)));
      this.choose(rows[at], cx, { delay: 90 });
    } else if (key === "right" && current?.entry.dir) {
      if (!this.folders.has(current.path)) this.toggle(current.path, cx);
      else if (rows[at + 1]?.parent === current.path) this.choose(rows[at + 1], cx, { delay: 90 });
    } else if (key === "left" && current) {
      if (current.entry.dir && this.folders.has(current.path)) this.toggle(current.path, cx);
      else if (current.parent) this.choose(rows.find(row => row.path === current.parent), cx);
    } else if (key === "enter" && current) {
      this.choose(current, cx, { activate: true, toggle: current.entry.dir });
    } else if (key === "escape") {
      this.selectionGeneration++; this.previewFocus = null;
      const tab = focused()?.tab;
      const terminal = panes().find(p => p.tab === tab && p.terminal);
      if (terminal) run("pane.focus", { pane: terminal.pane });
      else run("pane.go", { direction: "left" });
    } else return;
    cx.stop_propagation(); cx.notify();
  }

  rows(visible, t) {
    return visible.map(row => {
      const { entry, path, depth } = row, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.selected === path, el => el.bg(t.selected))
        .when(this.selected !== path, el => el.hover(s => s.bg(t.hover)))
        .on_click((_event, cx) => { cx.stop_propagation(); this.choose(row, cx, { activate: true, toggle: entry.dir }); })
        .child(entry.dir ? svg(`mods/files-md-tools/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-md-tools/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  render(cx) {
    if (!checking()) {
      this.syncPreviewPanes(cx);
      if (key() !== this.context?.key) this.refresh(cx);
    }
    const t = theme(), visible = this.visibleRows();
    this.revealSelection(visible);
    return v_flex().id("files").track_focus(this.handle).on_key_down((event, cx) => this.keyDown(event, cx))
      .when(!this.file, el => el.on_mouse_down("left", () => this.handle.focus()))
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(isMarkdown(this.file), el => {
          const chip = (id, label, on, action) => div().id(id).h(22).px(7).flex().flex_none().items_center().rounded(5).cursor_pointer().text_size(11)
            .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover)).on_click(action).child(label);
          return el.child(chip("md-preview", "Preview", !this.mdSource, (_e, cx) => { this.mdSource = false; cx.notify(); }))
            .child(chip("md-source", "Source", this.mdSource, (_e, cx) => { this.mdSource = true; cx.notify(); }))
            .child(chip("md-pane", "↗", false, () => this.openPane()));
        }))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(6).children(this.rows(visible, t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && this.markdown !== null && !this.mdSource, el => el.child(div().id("files-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12)
        .child(TextView.markdown(`files-md-${this.mdVersion}`, this.markdown).selectable().on_link_click((url, cx) => this.followLink(url, cx)))))
      .when(Boolean(this.file) && (this.markdown === null || this.mdSource), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
