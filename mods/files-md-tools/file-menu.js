import { div } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, openOverlay, readTextFile, setShared, shared, spaces, window } from "herdr";

export const FILE_CHANGE = "pixel-sessions.files.change";

function actionDialog({ overlay, ...target }, action) {
  closeOverlay(overlay);
  openOverlay({ mod: "files-md-tools", kind: "dialog", width: 430, props: { ...target, action } });
}

export function initFileMenu(view, cx, target) {
  view.target = target;
  view.name = target.name;
  if (target.action !== "rename") return;
  view.input = InputState.new({ value: view.name });
  view.input.on("change", (_e, cx) => { view.name = view.input.value(); cx.notify(); });
  view.input.on("submit", (_e, cx) => submit(view, cx, "rename"));
  if (!checking()) cx.timer.after(0, () => {
    view.input.focus();
    view.input.set_selected_range({ start: 0, end: view.name.length });
  });
}

async function perform(target, action, name) {
  if (action === "reveal") return exec("/usr/bin/open", ["-R", target.file], { timeout: 10000 });
  const helper = `${appHome()}/mods/files-md-tools/file_actions.py`;
  const code = target.on ? await readTextFile(helper) : null;
  if (target.on && !code) throw new Error("File action helper is missing.");
  const script = target.on ? ["-c", code] : [helper];
  return exec("python3", [...script, action, target.file, ...(action === "rename" ? [name] : [])],
    { on: target.on, timeout: 20000 });
}

function reportChange(target, name) {
  const renamed = name ? target.file.slice(0, target.file.lastIndexOf("/") + 1) + name : null;
  if (renamed) for (const space of spaces()) {
    for (const tab of space.tabs) {
      const key = `md-preview-tools.selection:${tab.id}`;
      const selected = shared(key);
      if (selected?.file === target.file && (selected.on ?? null) === target.on) {
        setShared(key, { ...selected, file: renamed, version: (selected.version ?? 0) + 1 });
      }
    }
  }
  setShared(FILE_CHANGE, { file: target.file, on: target.on, root: target.root, at: Date.now(), renamed });
}

function submit(view, cx, action) {
  if (checking() || view.busy) return;
  view.busy = true;
  view.error = null;
  cx.notify();
  cx.spawn(async (cx) => {
    const target = view.target, name = view.name;
    try {
      const result = await perform(target, action, name);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "The file action failed.");
      if (action !== "reveal") reportChange(target, action === "rename" ? name : null);
      closeOverlay(target.overlay);
    } catch (error) {
      view.error = error?.message ?? String(error);
      view.busy = false;
      cx.notify();
    }
  });
}

export function renderFileMenu(view, t) {
  const target = view.target;
  const finder = !target.on && window()?.platform === "macos";
  const button = (id, label, action) => div().id(id).px(10).py(7).rounded(6).cursor_pointer()
    .hover(s => s.bg(t.hover)).on_click(action).child(label);
  const box = v_flex().w_full().p(8).gap(3).bg(t.popover).text_color(t.foreground).text_size(13);
  const error = (el) => el.child(div().p(8).text_color(t.ansi1).child(view.error));
  if (target.action === "menu") {
    return box
      .when(finder, el => el.child(button("file-reveal", "Reveal in Finder", (_e, cx) => submit(view, cx, "reveal"))))
      .child(button("file-copy-path", "Copy Path", (_e, cx) => {
        cx.write_to_clipboard(target.file);
        closeOverlay(target.overlay);
      }))
      .child(button("file-rename", "Rename…", () => actionDialog(target, "rename")))
      .child(button("file-delete", "Delete…", () => actionDialog(target, "delete")))
      .when(Boolean(view.error), error);
  }
  const rename = target.action === "rename";
  const title = rename ? "Rename file" : finder ? "Move to Trash?" : "Delete file permanently?";
  return box.p(16).gap(12)
    .child(div().font_semibold().text_size(15).child(title))
    .when(Boolean(target.on), el => el.child(div().text_size(12).text_color(t.dim).child(target.on)))
    .when(rename, el => el.child(Input.new(view.input).h(34).px(8).rounded(6).bg(t.background).text_color(t.foreground)))
    .when(!rename, el => el.child(div().child(target.name)))
    .when(Boolean(view.error), error)
    .child(h_flex().gap(8).justify_end()
      .child(button("file-cancel", "Cancel", () => { if (!view.busy) closeOverlay(target.overlay); }))
      .child(button("file-apply", view.busy ? "Working…" : rename ? "Rename" : finder ? "Move to Trash" : "Delete",
        (_e, cx) => submit(view, cx, rename ? "rename" : finder ? "trash" : "delete")).bg(t.raised)));
}
