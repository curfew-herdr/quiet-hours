// quiet: quiet hours for herdr, a thin client of its watcher (quietd.mjs).
// One mod, roles by props().role:
//   "board":    the dim screen layouts/quiet-hours.json shows during quiet hours;
//   "chip":     the small control at the bottom of the work layout's sidebar;
//   "menu":     the chip's "quiet now" popup;
//   "settings": the dialog the chip's clock opens (never the board's: at night
//               you unlock first, and that is logged).
// Without a role (as `herdr-app check` loads it) it draws a preview of all of
// them and does nothing else.
//
// It reads quiet-hours/state.json and writes quiet-hours/control.json, and the
// settings dialog writes quiet-hours/config.json; the watcher decides, switches
// layouts, logs and handles sounds. The board and the chip make sure the
// watcher runs (a hidden core terminal labelled quiet-hours.watcher). The board
// names its rows with names.mjs, asking git (read-only) which repository each
// agent's folder is in.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import {
  agents, spaces, panes, home, theme, settings, layout, props, appHome, hc, exec, readTextFile, writeTextFile,
  watchFolder, openOverlay, closeOverlay, notify, shared, setShared,
} from "herdr";
import { board, chip, menu, summaryLine, unlockedNow } from "./ui.js";
import { SettingsForm, settingsDialog, DIALOG } from "./settings.js";
import { formFrom, configFrom, configText } from "./form.mjs";
import { FIRST_CONFIG, validateConfig, endsEarly, countdown } from "./clock.mjs";
import { commonDirArgs, folderName, projectName } from "./names.mjs";

const VERSION = 4; // quietd.mjs's VERSION
const LABEL = "quiet-hours.watcher=1";
const NAME = "quiet-hours-watcher";
const MINUTE = 60_000;

const dir = () => `${appHome()}/quiet-hours`;
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const mono = () => (typeof settings()?.font_family === "string" ? settings().font_family : "JetBrains Mono");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The sidebar's rail, as workspace-chrome reads it.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Agents with whether their tab was named (a row with no session name shows a named tab's name,
// names.mjs) and where each works now: its pane's live folder, else its space's folder (empty: its
// machine's home), on its space's machine.
function listed() {
  const sp = spaces();
  const named = new Set(sp.flatMap((s) => s.tabs.filter((tab) => tab.named).map((tab) => tab.id)));
  const space = new Map(sp.map((s) => [s.id, s]));
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  return agents().map((a) => {
    const s = space.get(a.space);
    const machine = s?.machine ?? null;
    return { ...a, named: named.has(a.tab), machine, folder: cwd.get(a.pane) || s?.folder || (machine ? "" : home()) };
  });
}

// Where an agent works, as the key of the board's project cache.
const place = (a) => JSON.stringify([a.machine, a.folder]);
// The home folder, shown as `~`: this computer's; another machine's isn't known.
const homeOf = (machine) => (machine ? null : home());

// An agent folder's project (names.mjs): its git repository's name, else the folder's name. git
// only reads, for at most 5 s; for a space on another machine it runs there.
async function projectOf(machine, folder) {
  let answer = null;
  if (folder) {
    try {
      const r = await exec("git", commonDirArgs(folder), { on: machine, timeout: 5000 });
      if (r.code === 0) answer = r.stdout;
    } catch {}
  }
  return projectName(folder, answer, homeOf(machine));
}

// Absolute path of a node >= 18: the user's PATH first, then the usual places.
async function findNode() {
  const found = [];
  try {
    const r = await exec("/bin/sh", ["-c", "command -v node"], { timeout: 5000 });
    if (r.code === 0 && r.stdout.trim().startsWith("/")) found.push(r.stdout.trim());
  } catch {}
  found.push("/usr/local/bin/node", "/opt/homebrew/bin/node");
  for (const node of found) {
    try {
      const r = await exec(node, ["--version"], { timeout: 5000 });
      if (r.code === 0 && Number(/^v(\d+)/.exec(r.stdout.trim())?.[1]) >= 18) return node;
    } catch {}
  }
  return null;
}

// A quiet now of these minutes, from now (any unlock ends with it).
const quietChange = (minutes) => (c) => {
  const now = Date.now();
  return { ...c, unlock: null, manual: { start: now, end: now + minutes * MINUTE } };
};

export default class Quiet extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "preview";
    this.state = null;
    this.error = null; // the mod's own: the watcher couldn't start, a write failed
    this.hover = false;
    this.restarted = false;
    this.projects = new Map(); // the board's: place -> project, once git has answered
    this.asking = new Set(); // places git is being asked about
    if (this.role === "settings") return this.initSettings(cx);
    if (this.role === "preview") return this.initPreview();
    if (this.role !== "board" && this.role !== "chip") return;

    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir(), { recursive: true });
      } catch {}
      await this.load();
      cx.notify();
      await this.ensureWatcher(false);
      await this.load();
      this.after(cx);
      cx.notify();
      // If the folder can't be watched, the 15 s timer below still reads it.
      for (;;) {
        try {
          await watchFolder(dir());
        } catch {
          return;
        }
        await this.load();
        this.after(cx);
        cx.notify();
      }
    });
    // The countdown and the clock; every fourth tick, is the watcher alive.
    let ticks = 0;
    cx.timer.every(15_000, (cx) => {
      cx.spawn(async (cx) => {
        if (++ticks % 4 === 0) await this.ensureWatcher(false);
        await this.load();
        this.after(cx);
        cx.notify();
      });
    });
    // While unlocked, the chip's countdown ticks each second (que's m:ss).
    if (this.role === "chip") {
      cx.timer.every(1_000, (cx) => {
        if (unlockedNow(this.state, Date.now())) cx.notify();
      });
    }
  }

  async load() {
    const s = parse((await readTextFile(`${dir()}/state.json`)) ?? "");
    if (s) this.state = s;
  }

  // A watcher from another version is restarted (once); the chip posts the
  // morning summary.
  after(cx) {
    const s = this.state;
    if (s && s.version !== VERSION && !this.restarted) {
      this.restarted = true;
      cx.spawn(async (cx) => {
        await this.ensureWatcher(true);
        cx.notify();
      });
    }
    if (this.role === "chip") this.morning();
  }

  morning() {
    const s = this.state;
    const sum = s?.summary;
    if (!sum?.windowEnd || (s.quiet && !s.unlock)) return;
    const age = Date.now() - sum.windowEnd;
    if (age < 0 || age > 12 * 60 * MINUTE || shared("quiet.summary") === sum.windowEnd) return;
    setShared("quiet.summary", sum.windowEnd);
    notify({ title: "Overnight", body: summaryLine(listed(), sum), level: "info" });
  }

  // Finds the watcher (a live core terminal labelled quiet-hours.watcher running
  // quietd.mjs) or starts one. `restart` kills the running one first.
  async ensureWatcher(restart) {
    try {
      const all = parse((await hc(["ls", "--all", "--json", "--label", LABEL])).stdout)?.terminals ?? [];
      let running = null;
      for (const term of all.filter((x) => x.state === "live")) {
        const info = parse((await hc(["get", term.address, "--json"])).stdout);
        const ours = (info?.argv ?? []).some((a) => String(a).endsWith("/quietd.mjs"));
        if (ours && !restart && !running) running = term.address;
        else await hc(["kill", term.address]);
      }
      if (running) {
        this.error = null;
        return;
      }
      const old = parse((await hc(["ls", "--all", "--json", "--label", LABEL])).stdout)?.terminals ?? [];
      for (const term of old.filter((x) => x.state !== "live")) await hc(["rm", term.address]);
      const node = await findNode();
      if (!node) throw new Error("no node (18 or later) found");
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", NAME, "--label", LABEL, "--cwd", dir(), "--", node, `${appHome()}/mods/quiet-hours/quietd.mjs`]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `hc run exited ${r.code}`);
      this.error = null;
    } catch (e) {
      this.error = `quiet watcher didn't start: ${e?.message ?? e}`;
    }
  }

  // control.json is the mod's requests. The snapshot it read must still be
  // there when it writes; a stale one is read again, once.
  async control(change) {
    const path = `${dir()}/control.json`;
    for (let attempt = 0; ; attempt++) {
      const current = await readTextFile(path);
      const c = { unlock: null, manual: null, ...(parse(current ?? "") ?? {}) };
      // An apply-tonight request is for one window: once that's over (the
      // watcher ignores it then), the next write drops it.
      if (c.applyTonight && this.state && c.applyTonight.windowStart !== this.state.held?.start) delete c.applyTonight;
      try {
        await writeTextFile(path, `${JSON.stringify(change(c), null, 2)}\n`, current);
        return;
      } catch (e) {
        if (attempt >= 1) throw e;
      }
    }
  }

  act(cx, change) {
    cx.spawn(async (cx) => {
      try {
        await this.control(change);
      } catch (e) {
        this.error = `couldn't write control.json: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  unlock(cx) {
    const now = Date.now();
    const minutes = this.state?.unlockMinutes ?? 10;
    this.act(cx, (c) => ({ ...c, unlock: { startedAt: now, until: now + minutes * MINUTE } }));
  }

  lock(cx) {
    this.act(cx, (c) => ({ ...c, unlock: null }));
  }

  // Ends a quiet now early (and any unlock inside it).
  endQuiet(cx) {
    this.act(cx, (c) => ({ ...c, unlock: null, manual: null }));
  }

  quietFor(minutes) {
    return this.control(quietChange(minutes));
  }

  // The board's rows: each agent with its project. git is asked once per folder, when a folder
  // first shows up among the agents, in a task (never in the render itself); a row's project is
  // blank until git answers. The preview runs nothing: its rows show the folders' names.
  rows(cx) {
    const list = listed();
    if (this.role !== "board") return list.map((a) => ({ ...a, project: folderName(a.folder, homeOf(a.machine)) }));
    const fresh = [...new Set(list.map(place))].filter((k) => !this.projects.has(k) && !this.asking.has(k));
    if (fresh.length) {
      for (const k of fresh) this.asking.add(k);
      cx.spawn(async (cx) => {
        for (const k of fresh) {
          const [machine, folder] = JSON.parse(k);
          this.projects.set(k, await projectOf(machine, folder));
          this.asking.delete(k);
        }
        cx.notify();
      });
    }
    return list.map((a) => ({ ...a, project: this.projects.get(place(a)) ?? "" }));
  }

  // ---- the settings dialog ------------------------------------------------

  initSettings(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.form = new SettingsForm(formFrom(validateConfig({})), (cx) => this.save(cx));
    this.ready = false; // config.json read
    this.tried = false; // a Save was pressed: every error shows
    this.busy = false;
    this.asking = null; // {windowStart, form}: "Apply tonight?" is up, about that form
    this.message = null; // {text, bad}
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${dir()}/config.json`);
      try {
        // No file yet: what the watcher will write (the schedule off).
        this.form.set(formFrom(validateConfig(text === null ? FIRST_CONFIG : JSON.parse(text))));
      } catch (e) {
        this.message = { text: `config.json: ${e?.message ?? e}; showing the defaults`, bad: true };
      }
      await this.load();
      this.ready = true;
      cx.notify();
      // Keep the state fresh; when quiet locks (an unlock ran out), close.
      for (;;) {
        try {
          await watchFolder(dir());
        } catch {
          return;
        }
        await this.load();
        if (this.locked() && !this.busy) return closeOverlay(props().overlay);
        cx.notify();
      }
    });
  }

  // Quiet and not unlocked: the settings stay shut.
  locked() {
    return Boolean(this.state?.quiet && !unlockedNow(this.state, Date.now()));
  }

  // Validates, then saves, or first asks "Apply tonight?" when a scheduled
  // window is in progress and this would end it sooner or remove it.
  save(cx) {
    if (this.busy || this.asking || !this.ready) return;
    this.tried = true;
    const form = this.form.form();
    const check = configFrom(form, {});
    if (!check.config) {
      this.message = check.error ? { text: check.error, bad: true } : null;
      return cx.notify();
    }
    this.busy = true;
    this.message = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.load();
        const s = this.state;
        if (this.locked()) throw new Error("quiet hours are locked: unlock first");
        if (s?.quiet && s.kind === "scheduled" && s.held && endsEarly(Date.now(), s.windowEnd, check.config)) {
          this.asking = { windowStart: s.held.start, form };
          this.busy = false;
          return cx.notify();
        }
        await this.writeConfig(form);
        closeOverlay(props().overlay);
      } catch (e) {
        this.message = { text: `couldn't save: ${e?.message ?? e}`, bad: true };
        this.busy = false;
        cx.notify();
      }
    });
  }

  // "No, from tomorrow" saves; "Yes, tonight" saves and asks the watcher to
  // apply it to the window in progress. Both writes finish before the dialog
  // closes (closing cancels this copy's unfinished tasks).
  answer(tonight, cx) {
    if (this.busy || !this.asking) return;
    const { windowStart, form } = this.asking;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.writeConfig(form);
        if (tonight) await this.control((c) => ({ ...c, applyTonight: { windowStart, at: Date.now() } }));
        closeOverlay(props().overlay);
      } catch (e) {
        this.message = { text: `couldn't save: ${e?.message ?? e}`, bad: true };
        this.asking = null;
        this.busy = false;
        cx.notify();
      }
    });
  }

  // config.json with the form's fields over what the file holds now, so keys
  // the dialog doesn't edit stay; 2-space JSON as the file is kept. Never an
  // invalid config. A snapshot gone stale is read again, once.
  async writeConfig(form) {
    const path = `${dir()}/config.json`;
    for (let attempt = 0; ; attempt++) {
      const current = await readTextFile(path);
      const r = configFrom(form, parse(current ?? "") ?? {});
      if (!r.config) throw new Error(r.error ?? "a field is not valid");
      const text = configText(r.raw);
      if (text === current) return;
      try {
        await writeTextFile(path, text, current);
        return;
      } catch (e) {
        if (attempt >= 1) throw e;
      }
    }
  }

  cancel() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    if (this.asking && !this.busy) this.asking = null;
    else this.cancel();
    cx.stop_propagation();
    cx.notify();
  }

  dialogView(t, form, extra = {}) {
    const live = this.role === "settings";
    const check = configFrom(form.form(), {});
    return settingsDialog({
      t,
      mono: mono(),
      form,
      errors: check.errors,
      showAll: this.tried,
      message: this.message,
      asking: this.asking,
      busy: this.busy,
      onToggle: (_e, cx) => {
        if (!live) return;
        form.enabled = !form.enabled;
        cx.notify();
      },
      onOnlyWithChip: (_e, cx) => {
        if (!live) return;
        form.onlyWithChip = !form.onlyWithChip;
        cx.notify();
      },
      onNightly: (v, cx) => {
        if (!live) return;
        form.nightly = v;
        cx.notify();
      },
      onMode: (day, mode, cx) => {
        if (!live) return;
        form.setMode(day, mode);
        cx.notify();
      },
      onSave: (_e, cx) => live && this.save(cx),
      onCancel: () => live && this.cancel(),
      onAnswer: (tonight, cx) => live && this.answer(tonight, cx),
      ...extra,
    });
  }

  // ---- the preview -----------------------------------------------------------

  initPreview() {
    const sample = formFrom(validateConfig({ days: { fri: ["20:00", "10:00"], sat: "none" } }));
    this.preview = {
      // One with a mistyped time, to show the inline error.
      form: new SettingsForm({ ...sample, days: { ...sample.days, fri: { mode: "custom", start: "20:00", end: "25:00" } } }, () => {}),
      // And one with only_with_chip on, so both looks of the switch show.
      asking: new SettingsForm({ ...sample, end: "06:00", onlyWithChip: true }, () => {}),
    };
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const error = this.error ?? this.state?.error ?? null;
    if (this.role === "settings") {
      return div().id("quiet-settings-root").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().child(this.dialogView(t, this.form));
    }
    if (this.role === "menu") {
      return menu({
        t,
        // Write first, then close: closing the popup cancels its unfinished tasks.
        onPick: (minutes, cx) =>
          cx.spawn(async () => {
            try {
              await this.quietFor(minutes);
            } catch (e) {
              notify({ title: "Quiet", body: `couldn't start quiet: ${e?.message ?? e}`, level: "error" });
            }
            closeOverlay(props().overlay);
          }),
      });
    }
    if (this.role === "board") {
      return board({ t, mono: mono(), state: this.state, now, agents: this.rows(cx), error, onUnlock: (_e, cx) => this.unlock(cx), onEnd: (_e, cx) => this.endQuiet(cx) });
    }
    const live = this.role === "chip";
    const chipView = (state, err) =>
      chip({
        t,
        mono: mono(),
        state,
        now,
        countdown: state?.unlock ? countdown(state.unlock.until - now) : "",
        error: err,
        hover: live ? this.hover : true,
        collapsed: live && narrow(),
        onHover: (hovered, cx) => {
          this.hover = hovered;
          cx.notify();
        },
        onQuiet: (minutes, cx) => live && this.act(cx, quietChange(minutes)),
        onQuietNow: () => live && openOverlay({ mod: "quiet-hours", kind: "popup", width: 170, height: 136, props: { role: "menu" } }),
        // Not while quiet is locked (the board is up then; unlock first).
        onSettings: () => live && !this.locked() && openOverlay({ mod: "quiet-hours", kind: "dialog", modal: true, frame: "none", ...DIALOG, props: { role: "settings" } }),
        onLock: (_e, cx) => live && this.lock(cx),
        onEnd: (_e, cx) => live && this.endQuiet(cx),
      });
    if (live) return chipView(this.state, error);

    // Preview: a sample night and every piece, drawn inert (clicks do nothing):
    // the chips (idle; unlocked; unlocked over a change waiting for tomorrow),
    // the menu and the board; the settings dialog with a mistyped time, and
    // asking "Apply tonight?" (with "Only in layouts with the quiet chip" on).
    const sample = { version: VERSION, quiet: true, kind: "scheduled", windowStart: now - 3 * 60 * MINUTE, windowEnd: now + 9 * 60 * MINUTE, nextStart: null, unlockMinutes: 10, unlock: null, error: null };
    const unlocked = { ...sample, unlock: { startedAt: now, until: now + 8 * MINUTE } };
    const dialog = (form, extra) => div().w(DIALOG.width).h(DIALOG.height).flex_none().child(this.dialogView(t, form, extra));
    return h_flex()
      .size_full()
      .bg(t.chrome)
      .p(16)
      .gap(20)
      .items_start()
      .child(
        v_flex()
          .w(350)
          .h_full()
          .flex_none()
          .child(div().h(36).flex_none().child(chipView({ ...sample, quiet: false, nextStart: now + 3 * 60 * MINUTE }, null)))
          .child(div().h(36).flex_none().child(chipView(unlocked, null)))
          .child(div().h(36).flex_none().child(chipView({ ...unlocked, pending: true }, null)))
          .child(div().w(170).flex_none().child(menu({ t, onPick: () => {} })))
          .child(div().flex_1().min_h(0).child(board({ t, mono: mono(), state: sample, now, agents: this.rows(), error: null, onUnlock: () => {} }))),
      )
      .child(dialog(this.preview.form, { showAll: true, message: null, asking: null, busy: false }))
      .child(dialog(this.preview.asking, { showAll: true, message: null, asking: { windowStart: sample.windowStart }, busy: false }));
  }
}
