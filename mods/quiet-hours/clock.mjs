// Quiet hours clock: pure functions of an injected `now` (epoch ms), local
// wall-clock time. Windows are built with the Date(y, m, d, h, min)
// constructor, so a DST change moves the instant, never the hh:mm.
//
// A window belongs to the weekday it starts on. When end <= start it crosses
// midnight and ends the next day. `enabled: false` turns off every scheduled
// window; a manual window ({start, end} epoch ms) ignores it and applies only
// when no scheduled window covers now.
//
// Also the watcher's move each tick (boardMove): the board, back, or nothing,
// and with only_with_chip which layouts quiet applies in (layoutCarries).
//
// No node imports: the watcher (node) and the mod (herdr's runtime imports
// ./clock.mjs as is) share this one copy of the rules.

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The fill-ins for keys config.json leaves out. return_layout is only the
// fallback: the watcher returns to the layout that was shown when quiet began.
// only_with_chip: quiet applies only on the board and in layouts with a
// quiet-hours block (off: in every layout).
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  default: ["18:00", "08:00"],
  days: {},
  unlock_minutes: 10,
  only_with_chip: false,
  return_layout: "main",
});

// What the watcher writes when there is no config.json yet (a new install):
// the defaults with the schedule off, so installing in the evening never locks
// the window at once. "Quiet now" works; the settings dialog turns it on.
// only_with_chip stays out of it: the file gets the key once someone turns it on.
const { only_with_chip: _, ...WRITTEN } = DEFAULT_CONFIG;
export const FIRST_CONFIG = Object.freeze({ ...WRITTEN, enabled: false });

// unlock_minutes' bounds.
export const UNLOCK_MIN = 1;
export const UNLOCK_MAX = 240;

const MINUTE = 60_000;

export function parseHM(text) {
  const m = typeof text === "string" ? /^(\d{1,2}):(\d{2})$/.exec(text.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, min } : null;
}

// {h: 8, min: 5} -> "08:05".
export const formatHM = ({ h, min }) => `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => parseHM(x) !== null);
const isSpec = (v) => v === "none" || isPair(v);

// The config with defaults filled in, or throws with the reason it's invalid.
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be a JSON object");
  const c = { ...DEFAULT_CONFIG, ...raw, days: { ...(raw.days ?? {}) } };
  if (typeof c.enabled !== "boolean") throw new Error('"enabled" must be true or false');
  if (!isSpec(c.default)) throw new Error('"default" must be ["hh:mm","hh:mm"] or "none"');
  if (typeof raw.days !== "undefined" && (typeof raw.days !== "object" || raw.days === null || Array.isArray(raw.days))) {
    throw new Error('"days" must be an object like {"sat": "none"}');
  }
  for (const [day, spec] of Object.entries(c.days)) {
    if (!DAYS.includes(day)) throw new Error(`"days.${day}": not a weekday (use ${DAYS.join(", ")})`);
    if (!isSpec(spec)) throw new Error(`"days.${day}" must be "none" or ["hh:mm","hh:mm"]`);
  }
  if (!Number.isInteger(c.unlock_minutes) || c.unlock_minutes < UNLOCK_MIN || c.unlock_minutes > UNLOCK_MAX) {
    throw new Error(`"unlock_minutes" must be a whole number from ${UNLOCK_MIN} to ${UNLOCK_MAX}`);
  }
  if (typeof c.only_with_chip !== "boolean") throw new Error('"only_with_chip" must be true or false');
  if (typeof c.return_layout !== "string" || !/^[A-Za-z0-9._-]+$/.test(c.return_layout) || c.return_layout === "quiet-hours") {
    throw new Error('"return_layout" must be a layout name other than "quiet-hours"');
  }
  return c;
}

// control.json, cleaned: each part that isn't well formed becomes null and
// says why in `errors`.
export function validateControl(raw) {
  const out = { unlock: null, manual: null, applyTonight: null, errors: [] };
  if (raw === null || raw === undefined) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...out, errors: ["control.json must be a JSON object"] };
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const u = raw.unlock;
  if (u !== null && u !== undefined) {
    if (num(u.startedAt) && num(u.until) && u.until > u.startedAt && (u.why === undefined || typeof u.why === "string")) {
      out.unlock = { startedAt: u.startedAt, until: u.until, ...(u.why ? { why: u.why.slice(0, 200) } : {}) };
    } else out.errors.push("control.json: unlock needs {startedAt, until} in epoch ms");
  }
  const m = raw.manual;
  if (m !== null && m !== undefined) {
    if (num(m.start) && num(m.end) && m.end > m.start) out.manual = { start: m.start, end: m.end };
    else out.errors.push("control.json: manual needs {start, end} in epoch ms");
  }
  const a = raw.applyTonight;
  if (a !== null && a !== undefined) {
    if (num(a?.windowStart) && num(a?.at)) out.applyTonight = { windowStart: a.windowStart, at: a.at };
    else out.errors.push("control.json: applyTonight needs {windowStart, at} in epoch ms");
  }
  return out;
}

// The scheduled window that starts on the calendar day (y, m, d), or null.
export function windowStartingOn(y, m, d, config) {
  if (!config.enabled) return null;
  const day = new Date(y, m, d);
  const spec = config.days?.[DAYS[day.getDay()]] ?? config.default;
  if (spec === "none" || !isPair(spec)) return null;
  const a = parseHM(spec[0]);
  const b = parseHM(spec[1]);
  const [yy, mm, dd] = [day.getFullYear(), day.getMonth(), day.getDate()];
  const crosses = b.h * 60 + b.min <= a.h * 60 + a.min;
  return {
    start: new Date(yy, mm, dd, a.h, a.min).getTime(),
    end: new Date(yy, mm, dd + (crosses ? 1 : 0), b.h, b.min).getTime(),
  };
}

// The scheduled window in force at `now`: one that started yesterday or today
// and contains now (both checked; overlapping ones merge). Null outside.
export function scheduledAt(now, config) {
  const t = new Date(now);
  const hits = [-1, 0]
    .map((off) => windowStartingOn(t.getFullYear(), t.getMonth(), t.getDate() + off, config))
    .filter((w) => w && w.start <= now && now < w.end);
  if (hits.length === 0) return null;
  return {
    kind: "scheduled",
    start: Math.min(...hits.map((w) => w.start)),
    end: Math.max(...hits.map((w) => w.end)),
  };
}

// The quiet window at `now`: scheduled first, else the manual one.
export function activeWindow(now, config, manual) {
  const s = scheduledAt(now, config);
  if (s) return s;
  if (manual && manual.start <= now && now < manual.end) return { kind: "manual", start: manual.start, end: manual.end };
  return null;
}

// The next scheduled start after `now` (up to 8 days ahead), or null.
export function nextStart(now, config) {
  const t = new Date(now);
  for (let off = 0; off <= 8; off++) {
    const w = windowStartingOn(t.getFullYear(), t.getMonth(), t.getDate() + off, config);
    if (w && w.start > now) return w.start;
  }
  return null;
}

// The unlock in force: it must start inside the current quiet window (an
// unlock from an earlier window never carries over) and it lasts at most
// unlock_minutes from when it started, whatever `until` says.
export function activeUnlock(now, unlock, unlockMinutes, win) {
  if (!win || !unlock) return null;
  if (unlock.startedAt < win.start || unlock.startedAt > now + MINUTE) return null;
  const until = Math.min(unlock.until, unlock.startedAt + unlockMinutes * MINUTE);
  if (now >= until) return null;
  return { startedAt: unlock.startedAt, until, ...(unlock.why ? { why: unlock.why } : {}) };
}

// When anything the watcher acts on next changes: the window's end, the next
// scheduled start, the manual window's edges, the unlock's expiry.
export function nextBoundary(now, config, control, unlockMinutes = config.unlock_minutes) {
  const win = activeWindow(now, config, control?.manual);
  const unlock = activeUnlock(now, control?.unlock, unlockMinutes, win);
  const times = [win?.end, nextStart(now, config), control?.manual?.start, control?.manual?.end, unlock?.until];
  const future = times.filter((t) => typeof t === "number" && t > now);
  return future.length ? Math.min(...future) : null;
}

// ---- the window: the board, back, or nothing ----------------------------------
//
// Locked quiet shows the board; otherwise never the board. With only_with_chip
// quiet applies only on the board and in layouts with a quiet-hours block: a
// layout without one is left alone (no board, the sounds as you have them), and
// a switch from the locked board to it is a bypass that stands.

const BOARD = "quiet-hours";

// A layout (layouts/<name>.json, parsed) has a quiet-hours block at any depth:
// a block's content in rows, columns and stacks, a floating block, a pane
// header, a stack's header.
export function layoutCarries(node) {
  if (Array.isArray(node)) return node.some(layoutCarries);
  if (!node || typeof node !== "object") return false;
  if (node.mod === BOARD || node.header === BOARD) return true;
  return Object.values(node).some(layoutCarries);
}

// The watcher's move this tick.
//   locked:  quiet and not unlocked;
//   shown:   the layout on screen (null: herdr didn't answer);
//   last:    {shown, locked} after the previous tick;
//   only:    config.only_with_chip;
//   carries: the shown layout has a quiet-hours block (layoutCarries; a file
//            that can't be read counts as having one).
// Returns {applies, to, bypass, remember}: applies, quiet holds where the
// window is (sounds go off only then); to, BOARD, "back" (the return layout)
// or null; bypass, null or {stayed} for a switch away from the locked board;
// remember, the shown layout becomes the one to return to. A bypass never does:
// where they went doesn't become the morning's layout.
export function boardMove({ locked, shown, last, only, carries }) {
  const applies = !only || shown === null || shown === BOARD || Boolean(carries);
  const left = last?.shown === BOARD && Boolean(last?.locked);
  if (shown !== null && locked && shown !== BOARD) {
    if (!applies) return { applies, to: null, bypass: left ? { stayed: true } : null, remember: false };
    return { applies, to: BOARD, bypass: left ? { stayed: false } : null, remember: !left };
  }
  return { applies, to: shown === BOARD && !locked ? "back" : null, bypass: null, remember: false };
}

// ---- the apply-tonight guardrail (que's effectiveConfig) ---------------------
//
// Editing config.json mid-window must not be a quiet way out: a change that
// would end the scheduled window in progress sooner, or remove it, waits for
// the window to end unless the person said "apply tonight" (which is logged).
// Any other change applies at once.

// Under `incoming`, tonight's window (the one containing `now`) would end
// before `end`, or not be there at all.
export function endsEarly(now, end, incoming) {
  const next = scheduledAt(now, incoming);
  return !next || next.end < end;
}

// The config in effect: `incoming`, unless it would end the window `inForce`
// has in progress sooner (or remove it) and `applyTonight` is false.
// Returns one of its two arguments, never a copy.
export function effectiveConfig(now, inForce, incoming, applyTonight) {
  if (applyTonight) return incoming;
  const cur = scheduledAt(now, inForce);
  if (!cur) return incoming;
  return endsEarly(now, cur.end, incoming) ? inForce : incoming;
}

// One tick of the guardrail.
//   held:    the scheduled window in progress and the config in force for it,
//            {start, end, config, appliedAt?}, or null (from the last tick).
//   file:    config.json, validated.
//   request: control.json's applyTonight, {windowStart, at}, or null. It is
//            honoured once (a new `at` is a new request), and only for the
//            held window.
// Returns the config in force, the next `held`, whether the request was
// honoured now (`applied`) and whether the file waits for tomorrow
// (`pending`). A held window is released at its end; a change that applies
// at once (a later end, another unlock length) becomes the held config, so
// the next edit is measured against what is in force, not the evening's file.
export function guard(now, held, file, request) {
  const h = held && now < held.end ? held : null;
  const applied = Boolean(h && request && request.windowStart === h.start && request.at !== h.appliedAt);
  const config = h ? effectiveConfig(now, h.config, file, applied) : file;
  const win = scheduledAt(now, config);
  const appliedAt = applied ? request.at : h?.appliedAt;
  const next = win ? { start: win.start, end: win.end, config, ...(h && appliedAt ? { appliedAt } : {}) } : null;
  return { config, held: next, applied, pending: config !== file };
}

// The overnight summary of a window from the log's entries: unlocks, the
// minutes they were open (each ends at its expiry, its lock, the next unlock
// or the window's end, whichever is first), bypasses (pulled back or stayed)
// and apply-tonight edits.
export function summarize(entries, windowStart, windowEnd) {
  const inWindow = (t) => typeof t === "number" && t >= windowStart && t <= windowEnd;
  const unlocks = entries.filter((e) => e.type === "unlock" && inWindow(e.startedAt)).sort((a, b) => a.startedAt - b.startedAt);
  const locks = entries.filter((e) => e.type === "lock");
  let ms = 0;
  unlocks.forEach((u, i) => {
    const lock = locks.find((l) => l.startedAt === u.startedAt);
    const next = unlocks[i + 1]?.startedAt;
    const end = Math.min(u.until, lock?.at ?? Infinity, next ?? Infinity, windowEnd);
    ms += Math.max(0, end - u.startedAt);
  });
  const applied = entries.filter((e) => e.type === "apply-tonight" && inWindow(e.at)).map((e) => e.at);
  return {
    windowEnd,
    unlocks: unlocks.length,
    unlockMinutes: Math.ceil(ms / MINUTE),
    bypasses: entries.filter((e) => e.type === "bypass" && inWindow(e.at)).length,
    appliedTonight: applied.length,
    appliedAt: applied.length ? Math.max(...applied) : null,
  };
}

// que's countdown: "9:52", "1:05:00" past an hour; seconds rounded up, never below 0.
export function countdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
