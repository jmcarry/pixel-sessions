import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, panes, props, run, spaces, terminals, theme } from "herdr";

function items(target = {}) {
  const pane = panes().find(p => p.pane === target.pane);
  const all = terminals();
  const terminal = all.find(t => t.address === target.terminal);
  const parent = terminal?.parent && all.find(t => t.address === terminal.parent);
  const toProgram = terminal?.labels?.["herdr.right-click"] === "program";
  const options = [];
  if (pane) {
    const space = spaces().find(s => s.tabs?.some(tab => tab.id === pane.tab));
    options.push(
      ["Open Files by Path…", "folder", "pane.split", {
        pane: pane.pane, direction: "right", mod: "files-md-tools",
        props: { browse: true, base: pane.cwd ?? space?.folder ?? null,
          on: space?.machine ?? null, space: space?.id ?? null },
      }],
      ["Split right", "panel-right", "pane.split", { pane: pane.pane, direction: "right" }],
      ["Split down", "panel-right", "pane.split", { pane: pane.pane, direction: "down" }],
      ["Zoom", "square", "pane.zoom", { pane: pane.pane }],
    );
  }
  if (terminal) {
    options.push([toProgram ? "Use Herdr right-click menu" : "Send right-clicks to pane",
      "terminal", "terminal.right_click", { terminal: terminal.address, to: toProgram ? "menu" : "program" }]);
  }
  if (parent) options.push([`Send back to ${parent.name || parent.address}`, "terminal", "terminal.park", { terminal: terminal.address }]);
  if (pane) options.push(["Close pane", "x", "pane.close", { pane: pane.pane }]);
  return options;
}

export default class TerminalMenu extends View {
  init(_props, cx) {
    this.selected = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(item) {
    if (!item) return;
    closeOverlay(props()?.overlay);
    run(item[2], item[3]);
  }

  render() {
    const t = theme();
    const options = items(props()?.target);
    return v_flex().id("pixel-terminal-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (e.key === "enter") this.choose(options[this.selected]);
        else if (options.length && (e.key === "up" || e.key === "down")) {
          this.selected = (this.selected + options.length + (e.key === "up" ? -1 : 1)) % options.length;
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(options.map((item, i) => {
        const icon = item[1] === "folder" ? "mods/files-md-tools/folder.svg" : `mods/workspace-chrome/${item[1]}.svg`;
        return h_flex().id(`pixel-terminal-action-${i}`).h(31).px(8).gap(8).rounded(6).items_center().text_color(t.foreground)
          .when(i === this.selected, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover)).on_click(() => this.choose(item))
          .child(svg(icon).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(item[0]));
      }));
  }
}
