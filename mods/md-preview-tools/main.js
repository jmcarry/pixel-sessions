// Modified for Pixel Sessions; pinned upstream provenance and licensing are in THIRD_PARTY_NOTICES.md.
// A Markdown preview pane. Open it beside a terminal:
//   herdr-app do pane.split --direction right --mod md-preview-tools --props '{"file":"/abs/README.md"}'
// props: { file: absolute path, on?: machine name (null: this computer) }.
// The preview follows saves (folder watch here, a gentle poll on other machines),
// toggles to the source, and follows relative .md links inside the pane.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState } from "gpui-base";
import { readTextFile, watchFolder, theme, settings, exec, window, props, checking, shared } from "herdr";

import { isImagePath, prepareImage } from "./images.js";

const MAX = 300000;
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "") || "/";
const basename = (p) => p.split(/[\\/]/).pop();

// Resolves a link inside the document against the shown file's folder.
function resolve(file, href) {
  let target;
  try { target = decodeURI(href.split("#")[0]).replace(/\\/g, "/"); } catch { return null; }
  if (!target) return null;
  const base = file.replace(/\\/g, "/");
  const drive = base.match(/^[A-Za-z]:/)?.[0] ?? "";
  const path = /^[A-Za-z]:\//.test(target) || target.startsWith("//") ? target
    : target.startsWith("/") ? drive + target : `${dirname(base)}/${target}`;
  const pathDrive = path.match(/^[A-Za-z]:/)?.[0] ?? "";
  const unc = path.startsWith("//");
  const prefix = pathDrive ? pathDrive + "/" : unc ? "//" : "/";
  const parts = (pathDrive ? path.slice(2) : path).split("/"), out = [];
  for (const part of parts) {
    if (part === "..") { if (out.length > (unc ? 2 : 0)) out.pop(); }
    else if (part !== "." && part !== "") out.push(part);
  }
  return prefix + out.join("/");
}

export default class MarkdownPreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.closed = false;
    this.loadToken = 0; this.pendingLoad = null; this.loading = false;
    this.watchGeneration = 0;
    this.selectionKey = p.selectionKey ?? null;
    const selected = this.selectionKey ? shared(this.selectionKey) : null;
    this.selectionVersion = selected?.version;
    this.on = selected?.on ?? p.on ?? null;
    this.history = [];
    this.mode = "preview";
    this.file = selected?.file ?? p.file ?? p.props?.file ?? null;
    this.text = null; this.imageData = null; this.error = null; this.sourceError = null;
    if (checking()) return;
    this.open(this.file, cx);
    // Other machines use a gentle poll; failed local watches get the same fallback.
    cx.timer.every(3000, (cx) => { if (this.on || !this.watched) this.load(cx); });
  }

  syncSelection(cx) {
    if (!this.selectionKey) return;
    const next = shared(this.selectionKey);
    if (!next || next.version === this.selectionVersion) return;
    this.selectionVersion = next.version;
    if (next.file === this.file && (next.on ?? null) === this.on) return;
    this.history = []; this.mode = "preview";
    this.on = next.on ?? null;
    this.open(next.file, cx);
  }

  open(file, cx) {
    this.file = file; this.text = null; this.imageData = null; this.error = null; this.sourceError = null;
    this.source?.release(); this.source = null;
    this.watchGeneration++;
    this.watchRequest?.cancel(); this.watchRequest = null; this.watched = null;
    this.load(cx);
    this.watch(cx);
  }

  watch(cx) {
    if (this.on || !this.file) return;
    const dir = dirname(this.file), generation = this.watchGeneration;
    if (this.watched === dir) return;
    this.watchRequest?.cancel();
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed && this.watched === dir && this.watchGeneration === generation) {
          const request = watchFolder(dir);
          this.watchRequest = request;
          const changed = await request;
          if (this.watchRequest === request) this.watchRequest = null;
          if (this.closed || this.watchGeneration !== generation) return;
          const file = this.file;
          if (this.watched === dir && changed.some((p) => p === dir || p === file || basename(p) === basename(file))) this.load(cx);
        }
      } catch { if (this.watchGeneration === generation && this.watched === dir) this.watched = null; }
    });
  }

  close() {
    this.closed = true;
    this.loadToken++; this.pendingLoad = null;
    this.watchGeneration++; this.watched = null;
    this.watchRequest?.cancel(); this.watchRequest = null;
    this.source?.release(); this.source = null;
    this.imageData = null; this.text = null; this.file = null; this.sourceError = null;
    this.history = []; this.imageBounds = null;
  }

  load(cx) {
    if (this.closed) return;
    const file = this.file, on = this.on, token = ++this.loadToken;
    if (!file) { this.error = "No file given (props.file)"; cx.notify(); return; }
    // One helper per preview at a time. A burst of saves or arrow presses keeps
    // only its newest pending selection; superseded results never reach the UI.
    this.pendingLoad = { file, on, token };
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed && this.pendingLoad) {
          const { file, on, token } = this.pendingLoad;
          this.pendingLoad = null;
          try {
            let picture = null, text = null, sourceError = null;
            if (isImagePath(file)) {
              picture = await prepareImage(file, { on });
              if (/\.svg$/i.test(file)) {
                try { text = await readTextFile(file, { on }); }
                catch { sourceError = "Source is unavailable: SVG text exceeds the text-preview limit or cannot be read."; }
                if (text === null && !sourceError) sourceError = "SVG source is no longer available.";
              }
            } else text = await readTextFile(file, { on });
            if (this.closed || this.loadToken !== token || this.file !== file || this.on !== on) continue;
            this.error = null; this.sourceError = sourceError;
            if (picture) this.imageData = picture;
            else if (text === null) { this.error = "This file is no longer available"; this.text = null; cx.notify(); continue; }
            if (text !== null) {
              const clipped = text.length > MAX ? text.slice(0, MAX) + "\n\n… (file truncated)" : text;
              if (clipped !== this.text) {
                this.text = clipped; this.version = (this.version ?? 0) + 1;
                this.source?.release(); this.source = null;
                this.ensureSource();
              }
            }
          } catch (e) {
            if (!this.closed && this.loadToken === token && this.file === file && this.on === on) {
              this.error = `Cannot preview this file: ${e?.message ?? e}`;
              this.text = null; this.imageData = null;
            }
          }
          if (!this.closed && this.loadToken === token) cx.notify();
        }
      } finally { this.loading = false; }
    });
  }

  follow(href, cx) {
    if (/^(https?|mailto):/i.test(href)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [href]).catch(() => null);
      return;
    }
    const target = resolve(this.file, href);
    if (target && (/\.(md|markdown|mdx)$/i.test(target) || isImagePath(target))) {
      this.history.push(this.file); this.mode = "preview"; this.open(target, cx);
    }
  }

  // Build Source outside render, preserving the original Markdown/SVG text.
  ensureSource() {
    if (this.source || this.text === null || this.mode !== "source") return;
    const t = theme();
    this.source = EditorState.new({ language: /\.svg$/i.test(this.file) ? "xml" : "markdown", readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  sourceView(t) {
    return this.source ? Editor.new(this.source).flex_1().min_h(0) : div().p(16).text_color(t.dim).child(this.sourceError ?? "Loading…");
  }

  imageView() {
    const picture = this.imageData;
    const box = this.imageBounds ?? { width: 640, height: 480 };
    const width = Math.max(1, picture.width || 640), height = Math.max(1, picture.height || 480);
    const scale = Math.max(0.001, Math.min(Math.max(1, box.width - 32) / width, Math.max(1, box.height - 32) / height));
    return div().id("image-preview").flex_1().min_h(0).w_full().overflow_hidden().flex().items_center().justify_center().p(16)
      .on_size_change((size, cx) => {
        if (!this.imageBounds || Math.abs(this.imageBounds.width - size.width) > 1 || Math.abs(this.imageBounds.height - size.height) > 1) {
          this.imageBounds = size; cx.notify();
        }
      })
      .child(image(picture.path).w(width * scale).h(height * scale).flex_none());
  }

  button(id, label, on, t, action) {
    return div().id(id).h(24).px(9).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  render(cx) {
    if (!checking()) this.syncSelection(cx);
    const t = theme(), picture = isImagePath(this.file), canSource = !picture || /\.svg$/i.test(this.file);
    const preview = this.mode !== "source" || !canSource;
    const ready = picture ? this.imageData !== null : this.text !== null;
    return v_flex().id("md-preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(38).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .when(this.history.length > 0, (el) => el.child(this.button("md-back", "←", false, t, (_e, cx) => { this.mode = "preview"; this.open(this.history.pop(), cx); })))
        .child(div().font_semibold().flex_none().child(this.file ? basename(this.file) : "Preview"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file ? dirname(this.file) : ""))
        .when(Boolean(picture && this.imageData), el => el.child(div().flex_none().text_size(10).text_color(t.dim)
          .tooltip(this.imageData.resized ? `Preview: ${this.imageData.width}×${this.imageData.height} · original unchanged` : "Original dimensions")
          .child(`${this.imageData.format} · ${this.imageData.originalWidth ?? this.imageData.width}×${this.imageData.originalHeight ?? this.imageData.height}`)))
        .child(this.button("md-mode-preview", "Preview", preview, t, (_e, cx) => { this.mode = "preview"; cx.notify(); }))
        .when(canSource, el => el.child(this.button("md-mode-source", "Source", !preview, t, (_e, cx) => { this.mode = "source"; this.ensureSource(); cx.notify(); }))))
      .when(!ready, (el) => el.child(div().p(16).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Loading…")))
      .when(ready && !preview, (el) => el.child(this.sourceView(t)))
      .when(ready && preview && picture, (el) => el.child(this.imageView()))
      .when(ready && preview && !picture, (el) => el.child(
        div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar()
          .child(h_flex().w_full().justify_center().px(24).py(18)
            .child(div().w_full().max_w(880).text_size(14)
              .child(TextView.markdown(`md-${this.version}`, this.text).selectable()
                .on_link_click((url, cx) => this.follow(url, cx)))))));
  }
}
