// node --test ~/.config/herdr-app/mods/quiet-hours/quietd.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withSounds } from "./quietd.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("a new install: the watcher writes config.json with the schedule off, and the board's layout", async () => {
  // A temp app home with the watcher's files, and a herdr-app that reports the main layout.
  const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quietd-")));
  const mod = path.join(app, "mods", "quiet-hours");
  fs.mkdirSync(mod, { recursive: true });
  fs.mkdirSync(path.join(app, "layouts"));
  for (const f of ["quietd.mjs", "clock.mjs", "quiet.layout.json", "quiet.layout.svg"]) fs.copyFileSync(path.join(HERE, f), path.join(mod, f));
  const herdr = path.join(app, "herdr-app");
  fs.writeFileSync(herdr, '#!/bin/sh\n[ "$1" = status ] && echo \'{"layout":"main"}\'\nexit 0\n', { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(mod, "quietd.mjs")], { env: { ...process.env, HERDR_APP_BIN: herdr }, stdio: "ignore" });
  const state = path.join(app, "quiet-hours", "state.json");
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(state) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(state), "the watcher wrote no state.json");
    const config = JSON.parse(fs.readFileSync(path.join(app, "quiet-hours", "config.json"), "utf8"));
    assert.equal(config.enabled, false);
    assert.equal(config.return_layout, "main");
    assert.equal(fs.readFileSync(path.join(app, "layouts", "quiet-hours.json"), "utf8"), fs.readFileSync(path.join(HERE, "quiet.layout.json"), "utf8"));
    // The picture the board layout's "preview" names comes with it.
    assert.equal(JSON.parse(fs.readFileSync(path.join(HERE, "quiet.layout.json"), "utf8")).preview, "layouts/quiet-hours.svg");
    assert.equal(fs.readFileSync(path.join(app, "layouts", "quiet-hours.svg"), "utf8"), fs.readFileSync(path.join(HERE, "quiet.layout.svg"), "utf8"));
    assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).quiet, false);
  } finally {
    child.kill("SIGTERM");
  }
});

test("turning sounds off and back changes only sounds.enabled, byte for byte", () => {
  const original = '{\n  "zoom": 1.0,\n  "sounds": {\n    "enabled": true,\n    "done": "a.mp3"\n  },\n  "minimum_contrast": 1.0\n}';
  const off = withSounds(original, false);
  assert.equal(off, original.replace('"enabled": true', '"enabled": false'));
  assert.equal(withSounds(off, true), original);
});

test("an enabled key outside sounds is left alone", () => {
  const text = '{"telemetry": {"enabled": true}, "sounds": {"enabled": true}}';
  assert.equal(withSounds(text, false), '{"telemetry": {"enabled": true}, "sounds": {"enabled": false}}');
});

test("settings without sounds.enabled get the key", () => {
  assert.deepEqual(JSON.parse(withSounds('{"zoom": 1}', false)), { zoom: 1, sounds: { enabled: false } });
});
