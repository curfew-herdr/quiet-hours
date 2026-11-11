// node --test ~/.config/herdr-app/mods/quiet-hours/form.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { formFrom, configFrom, configText, TIME_ERROR, UNLOCK_ERROR } from "./form.mjs";
import { validateConfig } from "./clock.mjs";

const FILE = '{\n  "enabled": true,\n  "default": [\n    "18:00",\n    "08:00"\n  ],\n  "days": {},\n  "unlock_minutes": 10,\n  "return_layout": "curfew"\n}\n';

test("an unchanged form writes the file back byte for byte", () => {
  const base = JSON.parse(FILE);
  const r = configFrom(formFrom(validateConfig(base)), base);
  assert.deepEqual(r.errors, {});
  assert.equal(configText(r.raw), FILE);
});

test("days: same is left out, off is none, custom is its own window; other keys stay", () => {
  const base = { ...JSON.parse(FILE), extra: 1 };
  const form = formFrom(validateConfig(base));
  form.days.sat = { ...form.days.sat, mode: "off" };
  form.days.fri = { mode: "custom", start: "20:00", end: "9:30" };
  form.unlock = "15";
  const r = configFrom(form, base);
  assert.deepEqual(r.raw, { ...base, days: { fri: ["20:00", "09:30"], sat: "none" }, unlock_minutes: 15 });
  assert.deepEqual(Object.keys(r.raw), ["enabled", "default", "days", "unlock_minutes", "return_layout", "extra"]);
  // And it reads back as the same form.
  assert.deepEqual(formFrom(r.config).days.fri, { mode: "custom", start: "20:00", end: "09:30" });
  assert.equal(formFrom(r.config).days.sat.mode, "off");
});

test('no nightly window is "none"; days in "same" follow it', () => {
  const form = formFrom(validateConfig({}));
  form.nightly = "none";
  form.start = "garbage"; // hidden, so not checked
  const r = configFrom(form, {});
  assert.deepEqual(r.errors, {});
  assert.equal(r.raw.default, "none");
  assert.equal(formFrom(r.config).nightly, "none");
});

test("each bad field is named, and nothing is returned to write", () => {
  const form = formFrom(validateConfig({ days: { mon: ["20:00", "06:00"] } }));
  form.end = "25:00";
  form.days.mon = { mode: "custom", start: "7", end: "06:00" };
  form.days.tue = { mode: "same", start: "x", end: "x" }; // not custom: not checked
  form.unlock = "0";
  const r = configFrom(form, {});
  assert.deepEqual(r.errors, { end: TIME_ERROR, "mon.start": TIME_ERROR, unlock: UNLOCK_ERROR });
  assert.equal(r.raw, null);
  for (const bad of ["", "1e1", "241", "10.5", "ten"]) {
    assert.equal(configFrom({ ...formFrom(validateConfig({})), unlock: bad }, {}).errors.unlock, UNLOCK_ERROR, bad);
  }
});

test("only_with_chip: written once it's on, after unlock_minutes; a file that has it keeps it in place", () => {
  const base = JSON.parse(FILE);
  const form = formFrom(validateConfig(base));
  assert.equal(form.onlyWithChip, false);
  // Off and not in the file: left out (the unchanged-form case above).
  assert.equal("only_with_chip" in configFrom(form, base).raw, false);
  // Turned on: after unlock_minutes, before return_layout and whatever follows.
  const on = configFrom({ ...form, onlyWithChip: true }, { ...base, extra: 1 });
  assert.deepEqual(Object.keys(on.raw), ["enabled", "default", "days", "unlock_minutes", "only_with_chip", "return_layout", "extra"]);
  assert.equal(on.raw.only_with_chip, true);
  assert.equal(on.config.only_with_chip, true);
  assert.equal(formFrom(on.config).onlyWithChip, true);
  // An unchanged form over that file writes it back byte for byte.
  const text = configText(on.raw);
  assert.equal(configText(configFrom(formFrom(validateConfig(JSON.parse(text))), JSON.parse(text)).raw), text);
  // Turned off again: the key stays where it is, false.
  const off = configFrom({ ...formFrom(on.config), onlyWithChip: false }, on.raw);
  assert.deepEqual(Object.keys(off.raw), Object.keys(on.raw));
  assert.equal(off.raw.only_with_chip, false);
  // A file that has it elsewhere keeps that place.
  const first = configFrom({ ...form, onlyWithChip: true }, { only_with_chip: false, ...base });
  assert.equal(Object.keys(first.raw)[0], "only_with_chip");
  assert.equal(first.raw.only_with_chip, true);
  // With no file yet, the edited keys in their order, it last.
  assert.deepEqual(Object.keys(configFrom({ ...form, onlyWithChip: true }, {}).raw), ["enabled", "default", "days", "unlock_minutes", "only_with_chip"]);
});

test("a problem in a key the dialog doesn't edit is reported, not written", () => {
  const r = configFrom(formFrom(validateConfig({})), { return_layout: "quiet-hours" });
  assert.equal(r.raw, null);
  assert.match(r.error, /return_layout/);
});
