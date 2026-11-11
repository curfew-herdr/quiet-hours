// quietd: the quiet-hours watcher, a small node process and the only writer
// of quiet-hours/state.json and quiet-hours/log.jsonl. The quiet mod starts it as a
// hidden herdr-core terminal (no herdr.space/herdr.tab labels):
//
//   hc run --bg --no-parent --name quiet-hours-watcher --label quiet-hours.watcher=1 \
//     --cwd <app home>/quiet-hours -- node <app home>/mods/quiet-hours/quietd.mjs
//
// Every 15 s, at the next boundary, and when quiet-hours/config.json,
// quiet-hours/control.json, settings.json or shared.json change, it works out
// whether it's quiet, switches the window to the `quiet` layout (or back),
// keeps herdr's sounds off during quiet, logs and writes state.
//
// With config.json `only_with_chip` (off by default) quiet applies only on the
// board and in layouts with a quiet-hours block (it reads layouts/<shown>.json):
// in any other layout the window isn't switched and the sounds are left as
// they are; leaving the locked board for one is a bypass, logged `stayed`.
//
// The apply-tonight guardrail (clock.mjs `guard`): a scheduled window keeps
// the config it is running under (state.json `held`, so a restart keeps it);
// an edit that would end it sooner or remove it waits for the window to end
// (`pending`), unless control.json asks to apply it tonight (logged).
// Stop it with `hc kill quiet-hours-watcher`: it puts the sounds back as it exits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FIRST_CONFIG, validateConfig, validateControl, activeWindow, activeUnlock, nextStart, nextBoundary, summarize, guard, boardMove, layoutCarries,
} from "./clock.mjs";

// The mod restarts a watcher whose state carries another version.
export const VERSION = 4;

const TICK_MS = 15_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(HERE, "..", "..");
const DIR = path.join(HOME, "quiet-hours");
const P = {
  config: path.join(DIR, "config.json"),
  control: path.join(DIR, "control.json"),
  state: path.join(DIR, "state.json"),
  log: path.join(DIR, "log.jsonl"),
  pid: path.join(DIR, "quietd.pid"),
  settings: path.join(HOME, "settings.json"),
  layouts: path.join(HOME, "layouts"),
  board: path.join(HERE, "quiet.layout.json"),
  boardPreview: path.join(HERE, "quiet.layout.svg"),
};

const HERDR = [
  process.env.HERDR_APP_BIN,
  path.join(os.homedir(), ".local/bin/herdr-app"),
  path.join(os.homedir(), "Applications/Herdr.app/Contents/MacOS/Herdr"),
  "/Applications/Herdr.app/Contents/MacOS/Herdr",
].find((p) => p && isExecutable(p)) ?? "herdr-app";

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const say = (text) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${text}`);

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// tmp + rename, the tmp hidden so nothing watching the folder picks it up.
function writeAtomic(p, text) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- herdr ------------------------------------------------------------------

function herdr(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(HERDR, args, { timeout, env: { ...process.env, HERDR_APP_HOME: HOME } }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });
}

// The shown layout, from the running window (`herdr-app status`); null when
// herdr isn't running.
async function shownLayout() {
  const r = await herdr(["status"]);
  const s = r.ok ? parse(r.stdout) : undefined;
  return typeof s?.layout === "string" ? s.layout : null;
}

const layoutExists = (name) => Boolean(name) && fs.existsSync(path.join(P.layouts, `${name}.json`));

// layouts/<name>.json has a quiet-hours block (clock.mjs layoutCarries). A file
// that is missing, unreadable or not a JSON object counts as having one: quiet
// still applies.
export function carriesQuiet(name, layouts = P.layouts) {
  try {
    const json = parse(readText(path.join(layouts, `${name}.json`)) ?? "");
    return json && typeof json === "object" && !Array.isArray(json) ? layoutCarries(json) : true;
  } catch {
    return true;
  }
}

// Switches and waits (up to ~2 s) until the window reports it. Returns the
// layout shown afterwards and an error, if any.
async function switchTo(name) {
  const r = await herdr(["do", "layout.switch", JSON.stringify({ name })]);
  if (!r.ok) return { shown: null, error: parse(r.stdout)?.error ?? (r.stderr.trim() || `exit ${r.code}`) };
  for (let i = 0; i < 10; i++) {
    const shown = await shownLayout();
    if (shown === name) return { shown, error: null };
    await new Promise((res) => setTimeout(res, 200));
  }
  return { shown: await shownLayout(), error: null };
}

// The board's layout comes back if something set it aside (the escape hatch
// moves the shown layout away), with the picture its "preview" names: the
// gallery install copies only mods/, so both come from this folder.
function ensureBoardLayout() {
  const picture = path.join(P.layouts, "quiet-hours.svg");
  if (!fs.existsSync(picture) && fs.existsSync(P.boardPreview)) {
    writeAtomic(picture, readText(P.boardPreview));
    say("restored layouts/quiet-hours.svg");
  }
  const target = path.join(P.layouts, "quiet-hours.json");
  if (fs.existsSync(target)) return;
  writeAtomic(target, readText(P.board));
  say("restored layouts/quiet-hours.json");
}

// ---- settings.json: herdr's sounds -----------------------------------------

// Changes only `sounds.enabled`, as a text edit so every other byte stays.
export function withSounds(text, enabled) {
  const re = /("sounds"\s*:\s*\{[^{}]*?"enabled"\s*:\s*)(true|false)/;
  if (re.test(text)) {
    const out = text.replace(re, `$1${enabled}`);
    if (parse(out)?.sounds?.enabled === enabled) return out;
  }
  const obj = JSON.parse(text);
  obj.sounds = { ...(obj.sounds ?? {}), enabled };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// During quiet the sounds are off; the value they had is remembered
// (`soundsSaved`) and put back when quiet ends. `quiet`: quiet holds where the
// window is (with only_with_chip, not in a layout without the chip, so moving
// there puts them back as quiet's end would, and coming back turns them off).
// Returns the new soundsSaved.
function handleSounds(quiet, saved, errors) {
  try {
    const text = readText(P.settings);
    if (text === null) return saved;
    const on = JSON.parse(text)?.sounds?.enabled !== false;
    if (quiet && on) {
      writeAtomic(P.settings, withSounds(text, false));
      if (!saved) say("sounds off");
      return true;
    }
    if (!quiet && saved) {
      if (!on) writeAtomic(P.settings, withSounds(text, true));
      say("sounds restored");
      return false;
    }
  } catch (e) {
    errors.push(`settings.json: ${e.message}`);
  }
  return saved;
}

// ---- config, control, log, state -------------------------------------------

let goodConfig = null;
function loadConfig(errors) {
  let text = readText(P.config);
  if (text === null) {
    text = `${JSON.stringify(FIRST_CONFIG, null, 2)}\n`;
    writeAtomic(P.config, text);
  }
  try {
    goodConfig = validateConfig(JSON.parse(text));
  } catch (e) {
    errors.push(`config.json: ${e.message} (${goodConfig ? "kept the last good one" : "using the defaults"})`);
    goodConfig ??= validateConfig({});
  }
  return goodConfig;
}

function loadControl(errors) {
  const text = readText(P.control);
  if (text === null || !text.trim()) return { unlock: null, manual: null, applyTonight: null };
  const raw = parse(text);
  if (raw === undefined) {
    errors.push("control.json is not valid JSON");
    return { unlock: null, manual: null, applyTonight: null };
  }
  const c = validateControl(raw);
  errors.push(...c.errors);
  return c;
}

function log(entry) {
  const line = { at: Date.now(), ...entry };
  fs.appendFileSync(P.log, `${JSON.stringify(line)}\n`);
  const tail =
    entry.type === "apply-tonight"
      ? ` ${hhmm(entry.windowEnd)} -> ${entry.newEnd ? hhmm(entry.newEnd) : "now"}`
      : `${entry.to ? ` -> ${entry.to}` : ""}${entry.stayed ? " (stayed: no quiet chip)" : ""}${entry.until ? ` until ${hhmm(entry.until)}` : ""}${entry.windowEnd && entry.type.endsWith("start") ? ` until ${hhmm(entry.windowEnd)}` : ""}`;
  say(`${entry.type}${tail}`);
}

const readLog = () => (readText(P.log) ?? "").split("\n").map(parse).filter(Boolean);

let written = "";
function writeState(state) {
  const { updatedAt: _, ...rest } = state;
  const key = JSON.stringify(rest);
  if (key === written) return;
  written = key;
  writeAtomic(P.state, `${JSON.stringify({ version: rest.version, updatedAt: Date.now(), ...rest }, null, 2)}\n`);
}

function loadState() {
  const s = parse(readText(P.state) ?? "") ?? {};
  // Remember what's on disk so an unchanged first tick doesn't rewrite it.
  const { updatedAt: _, ...rest } = s;
  written = JSON.stringify(rest);
  return { ...s, held: heldFrom(s.held) };
}

// state.json's held window, checked: a broken one is dropped (the next tick
// holds the window again, under the file's config).
function heldFrom(h) {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (!h || !num(h.start) || !num(h.end) || h.end <= h.start) return null;
  try {
    return { start: h.start, end: h.end, config: validateConfig(h.config), ...(num(h.appliedAt) ? { appliedAt: h.appliedAt } : {}) };
  } catch {
    return null;
  }
}

// ---- the tick ---------------------------------------------------------------

let st = {};
let lastShown = null; // the layout shown after the previous tick
let lastLocked = false;
let control = { unlock: null, manual: null, applyTonight: null };

async function tick() {
  const now = Date.now();
  const errors = [];
  // control.json first: the dialog writes config.json, then the apply-tonight
  // request, so a request seen here always comes with its config.
  control = loadControl(errors);
  const file = loadConfig(errors);
  const g = guard(now, st.held ?? null, file, control.applyTonight);
  const config = g.config;
  // `at: now`, so a window this ends now still counts it in its summary.
  if (g.applied) log({ at: now, type: "apply-tonight", windowStart: st.held.start, windowEnd: st.held.end, newEnd: g.held?.end ?? null, requestedAt: control.applyTonight.at });
  const win = activeWindow(now, config, control.manual);
  const unlock = activeUnlock(now, control.unlock, config.unlock_minutes, win);
  let summary = st.summary ?? null;

  // The same window: same kind and start, or a scheduled one whose start an
  // edit moved while it ran.
  const prevWin = st.quiet ? { kind: st.kind, start: st.windowStart, end: st.windowEnd } : null;
  const sameWin = Boolean(
    prevWin && win && prevWin.kind === win.kind && (prevWin.start === win.start || (win.kind === "scheduled" && now < prevWin.end)),
  );

  // An unlock that ended inside the same window: by its clock, or by lock now.
  const prev = st.unlock;
  if (prev && sameWin && (!unlock || unlock.startedAt !== prev.startedAt)) {
    if (now >= prev.until) log({ type: "relock", startedAt: prev.startedAt, until: prev.until });
    else if (!unlock) log({ type: "lock", startedAt: prev.startedAt });
  }
  if (prevWin && !sameWin) {
    // Ended early (apply tonight, end quiet): the summary covers up to now.
    const ended = Math.min(prevWin.end, now);
    log({ type: prevWin.kind === "manual" ? "manual-end" : "window-end", windowStart: prevWin.start, windowEnd: ended });
    if (prevWin.kind === "scheduled") summary = summarize(readLog(), prevWin.start, ended);
  }
  if (win && !sameWin) log({ type: win.kind === "manual" ? "manual-start" : "window-start", windowStart: win.start, windowEnd: win.end });
  if (unlock && unlock.startedAt !== prev?.startedAt) {
    log({ type: "unlock", startedAt: unlock.startedAt, until: unlock.until, kind: win.kind, ...(unlock.why ? { why: unlock.why } : {}) });
  }

  // The window: locked quiet shows the board; otherwise never the board. With
  // only_with_chip, a layout without a quiet-hours block is left alone, and so
  // are the sounds there (clock.mjs boardMove).
  let returnLayout = st.returnLayout ?? config.return_layout;
  const locked = Boolean(win && !unlock);
  let shown = await shownLayout();
  const only = config.only_with_chip;
  const carries = only && shown !== null && carriesQuiet(shown);
  const move = boardMove({ locked, shown, last: { shown: lastShown, locked: lastLocked }, only, carries });

  const soundsSaved = handleSounds(Boolean(win) && move.applies, Boolean(st.soundsSaved), errors);

  // Left the board without an unlock: logged, and pulled back unless it went to
  // a layout quiet doesn't apply in (`stayed`); where they went doesn't become
  // the morning's layout.
  if (move.bypass) log({ type: "bypass", to: shown, kind: win.kind, ...(move.bypass.stayed ? { stayed: true } : {}) });
  if (move.remember) returnLayout = shown;
  if (move.to === "quiet-hours") {
    try {
      ensureBoardLayout();
    } catch (e) {
      errors.push(`layouts/quiet-hours.json: ${e.message}`);
    }
    const r = await switchTo("quiet-hours");
    if (r.error) errors.push(`switch to quiet: ${r.error}`);
    else say(`showing quiet (was ${shown})`);
    shown = r.shown ?? shown;
  } else if (move.to === "back") {
    const target = [returnLayout, config.return_layout, "main"].find(layoutExists) ?? "main";
    const r = await switchTo(target);
    if (r.error) errors.push(`switch to ${target}: ${r.error}`);
    else say(`showing ${target}`);
    shown = r.shown ?? shown;
  }
  lastShown = shown;
  lastLocked = locked;

  const next = {
    version: VERSION,
    quiet: Boolean(win),
    kind: win?.kind ?? null,
    windowStart: win?.start ?? null,
    windowEnd: win?.end ?? null,
    nextStart: nextStart(now, config),
    enabled: config.enabled,
    unlockMinutes: config.unlock_minutes,
    unlock: unlock ? { startedAt: unlock.startedAt, until: unlock.until } : null,
    // The scheduled window in progress and the config in force for it; pending:
    // config.json waits for that window to end.
    held: g.held,
    pending: g.pending,
    returnLayout,
    summary,
    soundsSaved,
    error: errors.length ? errors.join("; ") : null,
  };
  writeState(next);
  st = next;
  return config;
}

// ---- scheduling: one tick at a time, coalesced ---------------------------

let timer = null;
let running = false;
let again = false;
let debounce = null;

async function kick() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(timer);
  let config = goodConfig ?? validateConfig({});
  try {
    config = await tick();
  } catch (e) {
    say(`tick failed: ${e.stack ?? e}`);
    try {
      writeState({ ...st, version: VERSION, error: `watcher: ${e.message}` });
    } catch {}
  }
  running = false;
  if (again) {
    again = false;
    return kick();
  }
  const now = Date.now();
  const boundary = nextBoundary(now, config, control);
  const wait = boundary ? Math.min(TICK_MS, Math.max(250, boundary - now + 100)) : TICK_MS;
  timer = setTimeout(kick, wait);
}

const soon = () => {
  clearTimeout(debounce);
  debounce = setTimeout(kick, 250);
};

// ---- start and stop -----------------------------------------------------------

function isQuietd(pid) {
  try {
    process.kill(pid, 0);
    return execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString().includes("quietd.mjs");
  } catch {
    return false;
  }
}

function stop(signal) {
  clearTimeout(timer);
  clearTimeout(debounce);
  try {
    if (st.soundsSaved) {
      const text = readText(P.settings);
      if (text !== null && JSON.parse(text)?.sounds?.enabled === false) writeAtomic(P.settings, withSounds(text, true));
      writeState({ ...st, soundsSaved: false });
      say("sounds restored");
    }
  } catch (e) {
    say(`couldn't restore sounds: ${e.message}`);
  }
  try {
    if (readText(P.pid)?.trim() === String(process.pid)) fs.unlinkSync(P.pid);
  } catch {}
  say(`stopped (${signal})`);
  process.exit(0);
}

function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const other = Number(readText(P.pid)?.trim());
  if (other && other !== process.pid && isQuietd(other)) {
    say(`another quietd is running (pid ${other}); exiting`);
    process.exit(0);
  }
  fs.writeFileSync(P.pid, `${process.pid}\n`);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => stop(sig));

  st = loadState();
  say(`quietd ${VERSION} watching ${DIR} (herdr-app: ${HERDR})`);
  // A new install has no board layout yet: write it now, so herdr knows it by
  // the time the first quiet switches to it.
  try {
    ensureBoardLayout();
  } catch (e) {
    say(`layouts/quiet-hours.json: ${e.message}`);
  }

  const ours = new Set(["config.json", "control.json"]);
  fs.watch(DIR, (_ev, name) => {
    if (!name || ours.has(name)) soon();
  }).on("error", (e) => say(`watch quiet-hours/: ${e.message}`));
  // The settings (someone turning sounds on during quiet) and shared.json
  // (its "layout": a switch away from the board) get an answer at once.
  fs.watch(HOME, (_ev, name) => {
    if (name === "settings.json" || name === "shared.json") soon();
  }).on("error", (e) => say(`watch home: ${e.message}`));

  kick();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
