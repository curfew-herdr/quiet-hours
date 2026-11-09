// node --test ~/.config/herdr-app/mods/quiet-hours/clock.test.mjs
// A fixed zone keeps the weekdays and the DST night the same on every machine.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAYS, DEFAULT_CONFIG, FIRST_CONFIG, validateConfig, validateControl, scheduledAt, activeWindow,
  nextStart, nextBoundary, activeUnlock, summarize, effectiveConfig, endsEarly, guard, countdown,
} from "./clock.mjs";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const cfg = (over = {}) => validateConfig({ ...DEFAULT_CONFIG, ...over });
const MIN = 60_000;
// Wed 2026-11-11, Thu 12, Fri 13, Sat 14, Sun 15.
const WED = 11;

test("the calendar is what the tests assume", () => {
  assert.equal(DAYS[new Date(2026, 10, WED).getDay()], "wed");
});

test("the default window crosses midnight and belongs to the day it starts", () => {
  const c = cfg();
  assert.equal(scheduledAt(at(2026, 11, WED, 17, 59), c), null);
  assert.deepEqual(scheduledAt(at(2026, 11, WED, 18, 0), c), { kind: "scheduled", start: at(2026, 11, WED, 18), end: at(2026, 11, WED + 1, 8) });
  assert.deepEqual(scheduledAt(at(2026, 11, WED, 23, 30), c), { kind: "scheduled", start: at(2026, 11, WED, 18), end: at(2026, 11, WED + 1, 8) });
  // After midnight the window in force is yesterday's.
  assert.deepEqual(scheduledAt(at(2026, 11, WED + 1, 3, 0), c), { kind: "scheduled", start: at(2026, 11, WED, 18), end: at(2026, 11, WED + 1, 8) });
  // The end is exclusive.
  assert.equal(scheduledAt(at(2026, 11, WED + 1, 8, 0), c), null);
});

test('a weekday override "none" drops only the window that starts that day', () => {
  const c = cfg({ days: { wed: "none" } });
  assert.equal(scheduledAt(at(2026, 11, WED, 23, 0), c), null);
  assert.equal(scheduledAt(at(2026, 11, WED + 1, 3, 0), c), null);
  // Tuesday's window still covers Wednesday's early hours.
  assert.deepEqual(scheduledAt(at(2026, 11, WED, 3, 0), c)?.start, at(2026, 11, WED - 1, 18));
  // And Thursday's starts as usual.
  assert.deepEqual(scheduledAt(at(2026, 11, WED + 1, 19, 0), c)?.start, at(2026, 11, WED + 1, 18));
});

test("a weekday override window replaces the default for the night it starts", () => {
  const c = cfg({ days: { fri: ["22:00", "10:00"], sat: ["09:00", "17:00"] } });
  const FRI = WED + 2;
  assert.equal(scheduledAt(at(2026, 11, FRI, 20, 0), c), null);
  assert.deepEqual(scheduledAt(at(2026, 11, FRI, 23, 0), c), { kind: "scheduled", start: at(2026, 11, FRI, 22), end: at(2026, 11, FRI + 1, 10) });
  // Saturday 09:00-17:00 (no midnight crossing) overlaps Friday's night: merged.
  assert.deepEqual(scheduledAt(at(2026, 11, FRI + 1, 9, 30), c), { kind: "scheduled", start: at(2026, 11, FRI, 22), end: at(2026, 11, FRI + 1, 17) });
  assert.deepEqual(scheduledAt(at(2026, 11, FRI + 1, 12, 0), c), { kind: "scheduled", start: at(2026, 11, FRI + 1, 9), end: at(2026, 11, FRI + 1, 17) });
  assert.equal(scheduledAt(at(2026, 11, FRI + 1, 17, 0), c), null);
});

test("end <= start: equal times make a 24 hour window", () => {
  const c = cfg({ default: "none", days: { wed: ["12:00", "12:00"] } });
  assert.deepEqual(scheduledAt(at(2026, 11, WED + 1, 11, 59), c), { kind: "scheduled", start: at(2026, 11, WED, 12), end: at(2026, 11, WED + 1, 12) });
});

test("enabled: false turns off scheduled windows but not a manual one", () => {
  const c = cfg({ enabled: false });
  const now = at(2026, 11, WED, 23, 0);
  assert.equal(scheduledAt(now, c), null);
  assert.equal(activeWindow(now, c, null), null);
  const manual = { start: now - 5 * MIN, end: now + 25 * MIN };
  assert.deepEqual(activeWindow(now, c, manual), { kind: "manual", ...manual });
  assert.equal(nextStart(now, c), null);
});

test("a manual window applies only when no scheduled window covers now", () => {
  const c = cfg();
  const manual = { start: at(2026, 11, WED, 17, 0), end: at(2026, 11, WED, 19, 0) };
  assert.deepEqual(activeWindow(at(2026, 11, WED, 17, 30), c, manual), { kind: "manual", ...manual });
  assert.equal(activeWindow(at(2026, 11, WED, 18, 30), c, manual).kind, "scheduled");
  // Over, or not started yet.
  assert.equal(activeWindow(at(2026, 11, WED, 16, 59), c, manual), null);
  assert.equal(activeWindow(at(2026, 11, WED + 1, 9, 0), c, manual), null);
});

test("next start skips the window in force and nights set to none", () => {
  const c = cfg({ days: { thu: "none" } });
  assert.equal(nextStart(at(2026, 11, WED, 12, 0), c), at(2026, 11, WED, 18));
  assert.equal(nextStart(at(2026, 11, WED, 23, 0), c), at(2026, 11, WED + 2, 18));
  assert.equal(nextStart(at(2026, 11, WED, 12, 0), cfg({ default: "none" })), null);
});

test("next boundary is the soonest of window end, next start, manual edges and unlock expiry", () => {
  const c = cfg();
  assert.equal(nextBoundary(at(2026, 11, WED, 12, 0), c, null), at(2026, 11, WED, 18));
  const manual = { start: at(2026, 11, WED, 12, 30), end: at(2026, 11, WED, 13, 0) };
  assert.equal(nextBoundary(at(2026, 11, WED, 12, 0), c, { manual }), manual.start);
  assert.equal(nextBoundary(at(2026, 11, WED, 12, 40), c, { manual }), manual.end);
  const now = at(2026, 11, WED, 23, 0);
  assert.equal(nextBoundary(now, c, null), at(2026, 11, WED + 1, 8));
  assert.equal(nextBoundary(now, c, { unlock: { startedAt: now - 2 * MIN, until: now + 8 * MIN } }), now + 8 * MIN);
});

test("an unlock is capped, expires, and never carries over from an earlier window", () => {
  const win = { kind: "scheduled", start: at(2026, 11, WED, 18), end: at(2026, 11, WED + 1, 8) };
  const now = at(2026, 11, WED, 23, 0);
  // `until` past startedAt + unlock_minutes is cut back: no silent extension.
  assert.deepEqual(activeUnlock(now, { startedAt: now - MIN, until: now + 60 * MIN }, 10, win), { startedAt: now - MIN, until: now + 9 * MIN });
  assert.equal(activeUnlock(now, { startedAt: now - 11 * MIN, until: now + 60 * MIN }, 10, win), null);
  assert.equal(activeUnlock(now, { startedAt: win.start - MIN, until: now + 5 * MIN }, 10, win), null);
  assert.equal(activeUnlock(now, { startedAt: now - MIN, until: now + 5 * MIN }, 10, null), null);
  assert.equal(activeUnlock(now, { startedAt: now - MIN, until: now + 5 * MIN, why: "deploy" }, 10, win).why, "deploy");
});

test("the window ends at its wall-clock time across a DST change", () => {
  // US clocks fall back on Sunday 2026-11-01 at 02:00.
  const w = scheduledAt(at(2026, 11, 1, 3, 0), cfg());
  assert.equal(new Date(w.start).getHours(), 18);
  assert.equal(new Date(w.end).getHours(), 8);
  assert.equal((w.end - w.start) / 3_600_000, 15);
  // Spring forward, Sunday 2026-03-08: one hour shorter.
  const s = scheduledAt(at(2026, 3, 8, 3, 30), cfg());
  assert.equal(new Date(s.end).getHours(), 8);
  assert.equal((s.end - s.start) / 3_600_000, 13);
});

test("config validation fills defaults and names what's wrong", () => {
  assert.deepEqual(validateConfig({}), { ...DEFAULT_CONFIG, days: {} });
  assert.throws(() => validateConfig({ default: ["18:00", "25:00"] }), /default/);
  assert.throws(() => validateConfig({ days: { weds: "none" } }), /weds/);
  assert.throws(() => validateConfig({ days: { sat: "off" } }), /days\.sat/);
  assert.throws(() => validateConfig({ unlock_minutes: 0 }), /unlock_minutes/);
  assert.throws(() => validateConfig({ enabled: "yes" }), /enabled/);
  assert.throws(() => validateConfig([]), /object/);
});

test("a new install's config is the defaults with the schedule off; the fallback layout is herdr's main", () => {
  assert.deepEqual(validateConfig(FIRST_CONFIG), { ...DEFAULT_CONFIG, enabled: false, days: {} });
  assert.equal(validateConfig({}).return_layout, "main");
  assert.equal(nextStart(at(2026, 11, WED, 12), validateConfig(FIRST_CONFIG)), null);
});

test("control validation keeps the good parts", () => {
  assert.deepEqual(validateControl(null), { unlock: null, manual: null, applyTonight: null, errors: [] });
  const c = validateControl({ unlock: { startedAt: 1, until: 0 }, manual: { start: 10, end: 20 } });
  assert.equal(c.unlock, null);
  assert.deepEqual(c.manual, { start: 10, end: 20 });
  assert.equal(c.errors.length, 1);
  assert.deepEqual(validateControl({ applyTonight: { windowStart: 5, at: 9 } }).applyTonight, { windowStart: 5, at: 9 });
  const bad = validateControl({ applyTonight: 5 });
  assert.equal(bad.applyTonight, null);
  assert.match(bad.errors[0], /applyTonight/);
});

test("the overnight summary counts unlocks, their open minutes and bypasses", () => {
  const ws = at(2026, 11, WED, 18);
  const we = at(2026, 11, WED + 1, 8);
  const t = at(2026, 11, WED, 21);
  const log = [
    { at: ws, type: "window-start" },
    { at: t, type: "unlock", startedAt: t, until: t + 10 * MIN },
    { at: t + 10 * MIN, type: "relock", startedAt: t, until: t + 10 * MIN },
    { at: t + 60 * MIN, type: "unlock", startedAt: t + 60 * MIN, until: t + 70 * MIN },
    { at: t + 64 * MIN, type: "lock", startedAt: t + 60 * MIN },
    { at: t + 90 * MIN, type: "bypass", to: "work" },
    { at: t + 100 * MIN, type: "apply-tonight", windowStart: ws, windowEnd: we, newEnd: we - 60 * MIN },
    // Before the window: not counted.
    { at: ws - 60 * MIN, type: "bypass", to: "work" },
    { at: ws - 30 * MIN, type: "apply-tonight" },
    { at: we, type: "window-end" },
  ];
  assert.deepEqual(summarize(log, ws, we), { windowEnd: we, unlocks: 2, unlockMinutes: 14, bypasses: 1, appliedTonight: 1, appliedAt: t + 100 * MIN });
});

// ---- the apply-tonight guardrail (que's effectiveConfig cases) ---------------

const tonight = cfg({ default: ["19:00", "07:00"] });
const earlier = cfg({ default: ["19:00", "05:00"] });
const later = cfg({ default: ["19:00", "08:00"] });
const off = cfg({ enabled: false });
const NIGHT = at(2026, 11, WED + 1, 2, 0); // Thursday 02:00, inside Wednesday's window
const NOON = at(2026, 11, WED + 1, 12, 0);

test("an edit that would end tonight's window sooner is held", () => {
  assert.equal(effectiveConfig(NIGHT, tonight, earlier, false), tonight);
  assert.equal(endsEarly(NIGHT, at(2026, 11, WED + 1, 7), earlier), true);
});

test("an edit that would remove tonight's window is held", () => {
  assert.equal(effectiveConfig(NIGHT, tonight, off, false), tonight);
  assert.equal(effectiveConfig(NIGHT, tonight, cfg({ default: "none" }), false), tonight);
  assert.equal(effectiveConfig(NIGHT, tonight, cfg({ days: { wed: "none" } }), false), tonight);
});

test("an edit that lengthens tonight, or changes something else, applies at once", () => {
  assert.equal(effectiveConfig(NIGHT, tonight, later, false), later);
  const unlock = cfg({ default: ["19:00", "07:00"], unlock_minutes: 20 });
  assert.equal(effectiveConfig(NIGHT, tonight, unlock, false), unlock);
  // Another night's override doesn't touch tonight.
  const friday = cfg({ default: ["19:00", "07:00"], days: { fri: "none" } });
  assert.equal(effectiveConfig(NIGHT, tonight, friday, false), friday);
});

test("with no window in progress any edit applies at once", () => {
  assert.equal(effectiveConfig(NOON, tonight, earlier, false), earlier);
  assert.equal(effectiveConfig(NOON, tonight, off, false), off);
});

test("apply tonight applies a shortening edit", () => {
  assert.equal(effectiveConfig(NIGHT, tonight, earlier, true), earlier);
  assert.equal(effectiveConfig(NIGHT, tonight, off, true), off);
});

const WS = at(2026, 11, WED, 19);
const WE = at(2026, 11, WED + 1, 7);

test("guard: a window that starts is held with the config it started under", () => {
  const g = guard(at(2026, 11, WED, 19, 0), null, tonight, null);
  assert.equal(g.config, tonight);
  assert.deepEqual(g.held, { start: WS, end: WE, config: tonight });
  assert.equal(g.pending, false);
  assert.equal(g.applied, false);
  // Outside a window nothing is held.
  assert.deepEqual(guard(NOON, null, tonight, null), { config: tonight, held: null, applied: false, pending: false });
});

test("guard: a shortening edit waits, pending, until the window ends", () => {
  const held = { start: WS, end: WE, config: tonight };
  const g = guard(NIGHT, held, earlier, null);
  assert.equal(g.config, tonight);
  assert.deepEqual(g.held, held);
  assert.equal(g.pending, true);
  // The held config is released after the window ends: the file's applies.
  const after = guard(WE, g.held, earlier, null);
  assert.equal(after.config, earlier);
  assert.equal(after.held, null);
  assert.equal(after.pending, false);
});

test("guard: a lengthening edit applies and becomes the held config", () => {
  const held = { start: WS, end: WE, config: tonight };
  const g = guard(NIGHT, held, later, null);
  assert.equal(g.config, later);
  assert.deepEqual(g.held, { start: WS, end: at(2026, 11, WED + 1, 8), config: later });
  assert.equal(g.pending, false);
  // Going back to 07:00 now ends tonight sooner than what's in force: held.
  const back = guard(NIGHT, g.held, tonight, null);
  assert.equal(back.config, later);
  assert.equal(back.pending, true);
});

test("guard: apply tonight is honoured once, for the held window only", () => {
  const held = { start: WS, end: WE, config: tonight };
  // For another window: ignored.
  assert.equal(guard(NIGHT, held, earlier, { windowStart: WS - 86_400_000, at: NIGHT }).config, tonight);
  const g = guard(NIGHT, held, earlier, { windowStart: WS, at: NIGHT });
  assert.equal(g.applied, true);
  assert.equal(g.config, earlier);
  assert.equal(g.pending, false);
  assert.deepEqual(g.held, { start: WS, end: at(2026, 11, WED + 1, 5), config: earlier, appliedAt: NIGHT });
  // The same request again is spent: a further shortening edit is held.
  const again = guard(NIGHT + MIN, g.held, cfg({ default: ["19:00", "04:00"] }), { windowStart: WS, at: NIGHT });
  assert.equal(again.applied, false);
  assert.equal(again.config, earlier);
  assert.equal(again.pending, true);
  // A new request (a new `at`) applies it.
  const fresh = guard(NIGHT + 2 * MIN, again.held, cfg({ default: ["19:00", "04:00"] }), { windowStart: WS, at: NIGHT + 2 * MIN });
  assert.equal(fresh.applied, true);
  assert.equal(fresh.held.end, at(2026, 11, WED + 1, 4));
});

test("guard: apply tonight with the window removed ends it now", () => {
  const g = guard(NIGHT, { start: WS, end: WE, config: tonight }, off, { windowStart: WS, at: NIGHT });
  assert.equal(g.applied, true);
  assert.equal(g.config, off);
  assert.equal(g.held, null);
  assert.equal(scheduledAt(NIGHT, g.config), null);
});

test("guard: a held window ending at a shortened time is released by then", () => {
  // Applied tonight to 05:00: at 05:00 the window is over, whatever was held.
  const g = guard(at(2026, 11, WED + 1, 5), { start: WS, end: at(2026, 11, WED + 1, 5), config: earlier, appliedAt: NIGHT }, earlier, { windowStart: WS, at: NIGHT });
  assert.equal(g.held, null);
  assert.equal(g.applied, false);
});

test("countdown reads like que's: m:ss, h:mm:ss past an hour, seconds rounded up", () => {
  assert.equal(countdown(592_000), "9:52");
  assert.equal(countdown(59_001), "1:00");
  assert.equal(countdown(3_900_000), "1:05:00");
  assert.equal(countdown(0), "0:00");
  assert.equal(countdown(-5_000), "0:00");
});
