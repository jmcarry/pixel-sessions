// Modified for Pixel Sessions; pinned upstream provenance and licensing are in THIRD_PARTY_NOTICES.md.
import { View, div, svg, image, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar } from "gpui-base";
import { spaces, machines, panes, focused, exec, appHome, home, readTextFile, theme, settings, run, checking } from "herdr";

// One entry per agent whose transcripts history.py can read. `resume` builds
// the command that reopens a session in its own folder.
const AGENTS = {
  claude: { name: "Claude", icon: "icons/claude.svg", tint: false, resume: (s) => s.profile
    ? ["python3", "-c", 'import os,sys; os.environ["CLAUDE_CONFIG_DIR"]=sys.argv[1]; os.execvp("claude", ["claude", "--resume", sys.argv[2]])', s.profile, s.id]
    : ["claude", "--resume", s.id] },
  codex: { name: "Codex", icon: "icons/codex.svg", tint: false, resume: (s) => s.profile
    ? ["python3", "-c", 'import os,sys; os.environ["CODEX_HOME"]=sys.argv[1]; os.execvp("codex", ["codex", "--no-daemon", "resume", sys.argv[2]])', s.profile, s.id]
    : ["codex", "resume", s.id] },
  agy: { name: "Antigravity", icon: "icons/antigravity.svg", tint: false, resume: (s) => ["agy", "--conversation", s.id] },
  pi: { name: "Pi", icon: "icons/pi.svg", tint: true, resume: (s) => ["pi", "--session", s.file] },
};
const SCRIPT = () => `${appHome()}/mods/history-tools/history.py`;
const TOOL_LINES = 6;
const LIMIT = 100; // most recent sessions shown in the list

// The folder the panel follows: the focused pane's, else the space's (as Changes does).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, machine: space?.machine ?? null };
}

async function history(machine, ...args) {
  let command = [SCRIPT()];
  if (machine) {
    const source = await readTextFile(SCRIPT());
    if (!source) throw new Error("History helper is missing.");
    command = ["-c", source];
  }
  const result = await exec("python3", [...command, ...args], { on: machine, timeout: 30000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code}`);
  return JSON.parse(result.stdout);
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inside = (path, root) => Boolean(path && root && (path === root || path.startsWith(root.endsWith("/") ? root : root + "/")));
const inFolder = (session, root) => (session.workspaces ?? [session.cwd]).some(path => inside(path, root));
const short = (path, home) => (path && home && path.startsWith(home) ? "~" + path.slice(home.length) : path ?? "");
const profileName = (session) => session.profile?.split(/[\\/]/).pop();
const sessionKey = (session) => `${session.agent}:${session.profile ?? ""}:${session.id}`;
const rowCount = (session) => session.agent === "agy" ? `${session.steps} steps`
  : `${session.turns} ${session.turns === 1 ? "prompt" : "prompts"}`;
const canDelete = (s) => Boolean(s?.revision) && ["claude", "codex", "pi"].includes(s.agent);

function localAlias(session, launchers) {
  if (session.machine) return null;
  const alias = session.agent === "claude" && session.profile ? launchers?.claude?.[session.profile]
    : session.agent === "agy" ? launchers?.agy : null;
  return typeof alias === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(alias) ? alias : null;
}

function resumeArgs(session, launchers) {
  const alias = localAlias(session, launchers);
  if (!alias) return AGENTS[session.agent]?.resume?.(session);
  // The shell loads the local alias definitions. The session ID is a positional
  // argument and is never inserted into the shell program.
  return ["/bin/zsh", "-lic", `${alias} "$@"`, "herdr-history",
    session.agent === "claude" ? "--resume" : "--conversation", session.id];
}

export default class History extends View {
  init(_props, cx) {
    this.home = home(); this.sessions = []; this.agent = "all"; this.scope = "here"; this.query = "";
    this.hostChoice = undefined;
    this.open = null; this.transcript = null; this.typing = false;
    // Turn rail state: `start` is the first message shown (a jump to a prompt
    // starts the transcript there), `top` the message at the top of the view.
    this.start = 0; this.top = 0; this.drawnTop = Infinity;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search sessions" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.syncRoot(cx);
    // Transcripts grow while agents work; the index is cached, so this is cheap.
    cx.timer.every(20000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (checking() || this.loading) return;
    const machine = this.machine;
    const token = {};
    this.loading = token;
    cx.spawn(async (cx) => {
      try {
        const [sessions, launchers] = await Promise.all([
          history(machine, "list"),
          machine ? null : readTextFile(`${appHome()}/history-launchers.json`)
            .then(text => text && JSON.parse(text)).catch(() => null),
        ]);
        if (this.loading === token) {
          this.sessions = sessions.map(session => ({ ...session, machine }));
          this.launchers = launchers;
          this.error = null;
        }
      } catch (e) {
        if (this.loading === token) {
          this.error = `Cannot read history on ${machine ?? "this Mac"}: ${e.message ?? e}`;
        }
      } finally {
        if (this.loading === token) { this.loading = null; cx.notify(); }
      }
    });
  }

  // "This folder" means the repo the focused folder belongs to, else the folder itself.
  syncRoot(cx) {
    const current = location();
    const machine = this.hostChoice === undefined ? current.machine : this.hostChoice;
    const cwd = machine === current.machine ? current.cwd : null;
    const hostChanged = machine !== this.machine;
    if (!hostChanged && cwd === this.cwd) return;
    this.cwd = cwd; this.machine = machine; this.root = cwd;
    if (hostChanged) {
      this.sessions = []; this.open = null; this.transcript = null;
      this.error = null; this.loading = null; this.hot = null;
      this.refresh(cx);
    }
    if (checking() || !cwd) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: machine, timeout: 5000 }).catch(() => null);
      if (this.cwd === cwd && this.machine === machine && r?.code === 0 && r.stdout.trim()) {
        this.root = r.stdout.trim(); cx.notify();
      }
    });
  }

  chooseHost(machine, cx) {
    this.hostChoice = machine;
    this.scope = machine === undefined ? "here" : "all";
    this.agent = "all";
    this.syncRoot(cx);
    cx.notify();
  }

  show(session, cx) {
    if (checking()) return;
    this.open = session; this.transcript = null; this.loadError = null; this.start = 0; this.top = 0; this.drawnTop = Infinity;
    const token = this.viewing = {};
    cx.spawn(async (cx) => {
      try {
        const result = await history(session.machine, "show", session.agent, session.file);
        if (this.open === session && this.viewing === token) this.transcript = result;
      } catch (e) { if (this.open === session && this.viewing === token) this.loadError = String(e); }
      cx.notify();
    });
    cx.notify();
  }

  requestDelete(session, cx) {
    if (checking() || !canDelete(session) || this.deleting) return;
    this.pendingDelete = session;
    this.deleteError = null;
    cx.notify();
  }

  confirmDelete(cx) {
    const session = this.pendingDelete;
    if (checking() || this.deleting || !canDelete(session)) return;
    this.deleting = true;
    this.deleteError = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const { trash } = await history(session.machine, "trash", session.agent, session.file, session.id, session.revision);
        this.trashed = { path: trash, host: session.machine ?? "Local" };
        this.pendingDelete = null;
        if (this.open === session) { this.open = null; this.transcript = null; }
        if (this.machine === (session.machine ?? null)) {
          this.sessions = this.sessions.filter(s => s.file !== session.file || s.agent !== session.agent);
          // Ignore any list request that started before the move.
          this.loading = null;
          this.refresh(cx);
        }
      } catch (e) {
        this.deleteError = e?.message ?? String(e);
      } finally {
        this.deleting = false;
        cx.notify();
      }
    });
  }

  resume(session) {
    const argv = resumeArgs(session, this.launchers);
    if (checking() || !argv) return;
    const machine = session.machine ?? null;
    const available = spaces().filter((s) => (s.machine ?? null) === machine);
    const normalize = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const folder = (machine === this.machine && session.workspaces?.find(path => inside(path, this.root))) || session.cwd;
    const tabFor = new Map(available.flatMap((s) => (s.tabs || []).map((t) => [t.id, s])));
    const exact = folder ? available.find((s) => normalize(s.folder) === normalize(folder))
      ?? panes().filter((p) => p.terminal && normalize(p.cwd) === normalize(folder)).map((p) => tabFor.get(p.tab)).find(Boolean)
      : null;
    const space = exact ?? available.find((s) => s.active) ?? available[0];
    const args = { argv, ...(folder ? { folder } : {}) };
    if (space) run("tab.new", { ...args, space: space.id });
    else run("space.new", { ...args, machine: machine ?? "" });
  }

  // Resume straight from the list: a quiet play icon that becomes a button on row hover.
  quickResume(s, hot, t) {
    return h_flex().id(`resume-${sessionKey(s)}`).h(24).flex_none().gap(4).items_center().justify_center().rounded(6).cursor_pointer()
      .when(hot, (el) => el.px(9).bg(t.solid).text_color(t.solid_foreground).text_size(11.5))
      .when(!hot, (el) => el.w(24).text_color(t.dim))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.resume(s); })
      .child(svg("mods/history-tools/resume.svg").size(hot ? 10 : 11))
      .when(hot, (el) => el.child("Resume"));
  }

  visible() {
    const q = this.query.trim().toLowerCase();
    return this.sessions.filter((s) =>
      (this.agent === "all" || s.agent === this.agent) &&
      (this.scope === "all" || !this.cwd || inFolder(s, this.root)) &&
      (!q || [s.title, s.cwd, s.id, profileName(s), localAlias(s, this.launchers)]
        .some(value => value?.toLowerCase().includes(q))));
  }

  icon(agent, size, t) {
    const a = AGENTS[agent];
    if (!a) return div().size(size);
    return a.tint ? svg(a.icon).size(size).flex_none().text_color(t.foreground) : image(a.icon).size(size).flex_none();
  }

  chip(id, label, on, t, action, icon) {
    return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.border : t.background)
      .hover((s) => s.bg(t.hover)).on_click(action)
      .when(Boolean(icon), (el) => el.child(icon)).child(label);
  }

  header(t, children) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).children(children);
  }

  renderList(t) {
    const list = this.visible();
    const here = this.scope === "here" && Boolean(this.cwd), counts = {};
    for (const s of this.sessions) if (!here || inFolder(s, this.root)) counts[s.agent] = (counts[s.agent] ?? 0) + 1;
    const present = Object.keys(AGENTS).filter((a) => counts[a]);
    const hostNames = [...new Set([this.machine, ...machines().map(m => m.name)].filter(Boolean))];
    const host = (id, label, machine) => this.chip(id, label, this.hostChoice === machine, t,
      (_e, cx) => this.chooseHost(machine, cx));
    const empty = this.loading && !this.sessions.length ? "Loading sessions…"
      : this.query ? "No matching sessions" : here ? "No sessions in this folder. Choose All to browse this host." : "No sessions";
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().font_semibold().child("History"),
        div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${list.length}`),
        div().flex_1(),
        ...(this.cwd ? [this.chip("scope-here", "This folder", here, t, (_e, cx) => { this.scope = "here"; cx.notify(); })] : []),
        this.chip("scope-all", "All", !here, t, (_e, cx) => { this.scope = "all"; cx.notify(); }),
        div().id("history-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(svg("mods/history-tools/history.svg").size(14).when(this.loading, (el) => el.spin(900))),
      ]))
      .child(v_flex().flex_none().px(10).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().id("history-hosts").gap(4).overflow_x_scrollbar()
          .child(host("host-active", "Current space", undefined))
          .child(host("host-local", "Local", null))
          .children(hostNames.map(name => host(`host-${name}`, name, name))))
        .child(div().text_size(11).text_color(t.dim).truncate().child(this.machine ?? "Local history"))
        .child(div().id("history-search").h(30).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("history-agents").gap(4).overflow_x_scrollbar()
          .child(this.chip("agent-all", "All", this.agent === "all", t, (_e, cx) => { this.agent = "all"; cx.notify(); }))
          .children(present.map((a) => this.chip(`agent-${a}`, `${AGENTS[a].name} ${counts[a]}`, this.agent === a, t,
            (_e, cx) => { this.agent = this.agent === a ? "all" : a; cx.notify(); }, this.icon(a, 13, t))))))
      .child(v_flex().id("history-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(this.trashed), el => el.child(h_flex().gap(5).p(4).items_center()
          .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(`Session Trash on ${this.trashed.host}`))
          .child(this.chip("history-copy-trashed", "Copy path", false, t, (_e, cx) => cx.write_to_clipboard(this.trashed.path)))
          .child(this.chip("history-dismiss-trashed", "×", false, t, (_e, cx) => { this.trashed = null; cx.notify(); }))))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.ansi1).child(this.error)))
        .when(!this.error && !list.length, (el) => el.child(div().p(8).text_color(t.dim).child(empty)))
        .children(list.slice(0, LIMIT).map((s) =>
          h_flex().id(`session-${sessionKey(s)}`).flex_none().px(8).py(7).gap(10).items_center().rounded(8).cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.show(s, cx))
            .on_hover((hovered, cx) => {
              const key = sessionKey(s);
              if (hovered) this.hot = key; else if (this.hot === key) this.hot = null;
              cx.notify();
            })
            .child(this.icon(s.agent, 16, t))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(12.5).truncate().child(s.title || "(untitled)"))
              .child(h_flex().gap(6).text_size(11).text_color(t.dim)
                .child(div().flex_none().child(ago(s.updated)))
                .child(div().flex_none().child(`· ${rowCount(s)}`))
                .when(Boolean(s.profile), el => el.child(div().min_w(0).truncate().child(`· ${profileName(s)}`)))
                .when(!here, (el) => el.child(div().min_w(0).truncate().child(`· ${short(s.cwd, this.home)}`)))))
            .when(Boolean(AGENTS[s.agent]?.resume), (el) => el.child(this.quickResume(s, this.hot === sessionKey(s), t))))))
      .when(list.length > LIMIT, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the ${LIMIT} most recent of ${list.length}; search to narrow`)));
  }

  message(m, i, t) {
    const agent = AGENTS[this.open.agent]?.name ?? "Agent";
    if (m.role === "tool") {
      const lines = m.text.split("\n"), shown = lines.slice(0, TOOL_LINES);
      return v_flex().flex_none().mx(12).px(10).py(5).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(t.dim)
        .children(shown.map((line) => div().truncate().child(`▸ ${line}`)))
        .when(lines.length > TOOL_LINES, (el) => el.child(div().child(`… ${lines.length - TOOL_LINES} more tool calls`)));
    }
    const user = m.role === "user";
    return v_flex().flex_none().mx(12).gap(4).when(user, (el) => el.px(10).py(8).rounded(8).bg(t.raised))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().font_semibold().text_color(user ? t.accent : t.muted).child(user ? "You" : agent))
        .child(div().child(clock(m.time))))
      .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`msg-${i}`, m.text).selectable()));
  }

  renderSession(t) {
    const s = this.open, a = AGENTS[s.agent], can = Boolean(a?.resume);
    const tr = this.transcript;
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().id("history-back").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(16).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.open = null; this.transcript = null; cx.notify(); }).child("‹"),
        this.icon(s.agent, 16, t),
        div().flex_1().min_w(0).font_semibold().truncate().child(s.title || "(untitled)"),
      ]))
      .child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().child(short(s.cwd, this.home) || "(unknown folder)"))
          .child(div().truncate().child([a?.name ?? s.agent, profileName(s), localAlias(s, this.launchers), s.machine ?? "Local",
            s.created ? `${clock(s.created)} → ${ago(s.updated)}` : ago(s.updated)].filter(Boolean).join(" · "))))
        .when(canDelete(s), el => el.child(this.chip("history-delete", "Delete", false, t, (_e, cx) => this.requestDelete(s, cx))))
        .child(div().id("history-resume").h(28).px(12).flex_none().flex().items_center().rounded(7).text_size(12)
          .bg(can ? t.solid : t.raised).text_color(can ? t.solid_foreground : t.dim).when(can, (el) => el.cursor_pointer())
          .on_click(() => this.resume(s)).child(can ? "Resume" : "View only")))
      .when(!tr, (el) => el.child(div().px(14).py(12).text_color(this.loadError ? t.ansi1 : t.dim).child(this.loadError ?? "Loading transcript…")))
      .when(Boolean(tr && tr.total > tr.messages.length), (el) => el.child(div().flex_none().px(14).pt(8).text_size(11).text_color(t.dim)
        .child(`Showing the last ${tr.messages.length} of ${tr.total} entries`)))
      .when(Boolean(tr?.summaryOnly), el => el.child(v_flex().id("agy-summary").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).gap(8)
        .child(div().text_color(t.dim).child("Antigravity summary. Resume to read the full conversation in AGY."))
        .child(div().text_color(t.dim).child("To delete this conversation, use /resume in AGY and press F4 on the selected row."))
        .when(Boolean(tr.summary), box => box.child(TextView.markdown("agy-summary-text", tr.summary).selectable()))))
      .when(Boolean(tr && !tr.summaryOnly && !tr.messages.length), (el) => el.child(div().px(14).py(12).text_color(t.dim).child("No messages")))
      .when(Boolean(tr?.messages.length), (el) => el.child(this.renderTranscript(tr.messages, t)));
  }

  renderDelete(t) {
    const s = this.pendingDelete;
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [div().font_semibold().child("Delete session?")]))
      .child(v_flex().gap(10).p(14)
        .child(div().font_semibold().child(s.title || "(untitled)"))
        .child(div().text_size(12).text_color(t.dim).child([AGENTS[s.agent].name, profileName(s), s.machine ?? "Local"].filter(Boolean).join(" · ")))
        .child(div().text_size(12).child("The transcript moves to Session Trash on this host. To restore it, move it back to its original folder. Close the session before deleting."))
        .when(Boolean(this.deleteError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.deleteError)))
        .child(h_flex().gap(8).justify_end()
          .child(this.chip("history-delete-cancel", "Cancel", false, t, (_e, cx) => {
            if (!this.deleting) { this.pendingDelete = null; cx.notify(); }
          }))
          .child(this.chip("history-delete-confirm", this.deleting ? "Moving…" : "Move to Session Trash", true, t,
            (_e, cx) => this.confirmDelete(cx)))));
  }

  // The transcript, with a rail on the right: one dot per prompt you sent.
  // Hover a dot for the prompt; click it to read from there. The lazy list
  // can't be scrolled from code, so a jump starts the list at that prompt
  // (a fresh list id) and a bar above it brings back what came before.
  renderTranscript(messages, t) {
    const turns = [];
    messages.forEach((m, i) => { if (m.role === "user") turns.push(i); });
    const start = Math.min(this.start, messages.length - 1), shown = messages.length - start;
    // Rows are drawn during layout, after render; the first one drawn last
    // time is the message at the top of the view.
    if (this.drawnTop !== Infinity) this.top = this.drawnTop;
    this.drawnTop = Infinity;
    let current = 0;
    turns.forEach((i, k) => { if (i <= this.top) current = k; });
    const id = `history-tools-transcript-${this.open.agent}-${this.open.id}-${start}`;
    return h_flex().flex_1().min_h(0)
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(start > 0, (el) => el.child(h_flex().id("history-earlier").flex_none().mx(12).mt(8).h(26).px(10).gap(6).items_center().justify_center()
          .rounded(6).border_1().border_color(t.border).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.start = 0; this.top = 0; this.drawnTop = Infinity; cx.notify(); })
          .child(`↑ Show ${start} earlier ${start === 1 ? "entry" : "entries"}`)))
        .child(div().id(`${id}-box`).relative().flex_1().min_h(0)
          // The wheel moves the list itself; render again once it has, so the lit dot follows.
          .on_scroll_wheel((_e, cx) => { cx.notify(); cx.timer.after(50, (cx) => cx.notify()); })
          .child(list(id, shown, (i) => `m${start + i}`, (i) => {
            const at = start + i;
            if (at < this.drawnTop) this.drawnTop = at;
            return div().w_full().pt(i === 0 ? 12 : 0).pb(i === shown - 1 ? 12 : 10).child(this.message(messages[at], at, t));
          }).size_full())
          .child(Scrollbar.vertical(id).absolute().inset_0())))
      .when(turns.length > 1, (el) => el.child(this.turnRail(turns, messages, current, t)));
  }

  turnRail(turns, messages, current, t) {
    return v_flex().id("history-turns").w(18).flex_none().h_full().py(10).items_center().justify_center().border_l(1).border_color(t.border)
      .children(turns.map((i, k) => {
        const on = k === current, text = messages[i].text.replace(/\s+/g, " ").trim();
        return div().id(`turn-${k}`).w_full().flex_1().min_h(3).max_h(18).flex().items_center().justify_center().cursor_pointer()
          .rounded(4).hover((s) => s.bg(t.hover))
          .tooltip(`${k + 1}/${turns.length} · ${text.length > 120 ? text.slice(0, 120) + "…" : text}`)
          .on_click((_e, cx) => { this.start = k === 0 ? 0 : i; this.top = i; this.drawnTop = Infinity; cx.notify(); })
          .child(div().flex_none().rounded(4).when(on, (d) => d.size(8).bg(t.accent)).when(!on, (d) => d.size(5).bg(t.dim)));
      }));
  }

  render(cx) {
    this.syncRoot(cx);
    const t = theme();
    return v_flex().id("history").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.pendingDelete) {
          if (!this.deleting) this.pendingDelete = null;
        } else if (this.typing) { this.typing = false; this.handle.focus(); }
        else if (this.open) { this.open = null; this.transcript = null; }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(this.pendingDelete ? this.renderDelete(t) : this.open ? this.renderSession(t) : this.renderList(t));
  }
}
