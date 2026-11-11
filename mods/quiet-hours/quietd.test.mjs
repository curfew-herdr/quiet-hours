// node --test ~/.config/herdr-app/mods/quiet-hours/quietd.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withSounds, carriesQuiet } from "./quietd.mjs";

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

// ---- only_with_chip ---------------------------------------------------------

const CHIP = { id: "quiet-chip", type: "block", content: { mod: "quiet-hours", props: { role: "chip" } }, size: { px: 42 } };
const layout = (sidebar) => ({ id: "root", type: "row", children: [{ id: "sidebar", type: "column", children: sidebar }, { id: "main", type: "block", content: { tab: "active" } }] });
const WORK = layout([{ id: "spaces", type: "block", content: { mod: "spaces" } }, { id: "sidebar-foot", type: "column", children: [CHIP] }]);
const PLAIN = layout([{ id: "spaces", type: "block", content: { mod: "spaces" } }]);

test("a layout file without a quiet-hours block doesn't carry it; one that can't be read does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quietd-layouts-"));
  try {
    fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify(WORK));
    fs.writeFileSync(path.join(dir, "plain.json"), JSON.stringify(PLAIN));
    fs.writeFileSync(path.join(dir, "broken.json"), '{"id": "root", "children": [');
    fs.writeFileSync(path.join(dir, "list.json"), "[]");
    fs.mkdirSync(path.join(dir, "folder.json"));
    assert.equal(carriesQuiet("work", dir), true);
    assert.equal(carriesQuiet("plain", dir), false);
    for (const name of ["missing", "broken", "list", "folder"]) assert.equal(carriesQuiet(name, dir), true, name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A temp app home with the watcher, layouts `work` (the chip) and `plain` (no
// chip), sounds on, a quiet now in control.json, and a herdr-app whose window
// shows the layout in the file `shown`: `do layout.switch` changes it, and
// every `do` is noted in `calls`.
const FAKE_HERDR = `#!/bin/sh
cd "$(dirname "$0")"
case "$1" in
  status) printf '{"layout":"%s"}\\n' "$(cat shown)" ;;
  do) printf '%s\\n' "$3" >> calls
      n=$(printf '%s' "$3" | sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p')
      [ -n "$n" ] && printf '%s' "$n" > shown
      echo '{}' ;;
esac
exit 0
`;

function quietHome(config, shown) {
  const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quietd-")));
  const mod = path.join(app, "mods", "quiet-hours");
  fs.mkdirSync(mod, { recursive: true });
  fs.mkdirSync(path.join(app, "layouts"));
  fs.mkdirSync(path.join(app, "quiet-hours"));
  for (const f of ["quietd.mjs", "clock.mjs", "quiet.layout.json", "quiet.layout.svg"]) fs.copyFileSync(path.join(HERE, f), path.join(mod, f));
  fs.writeFileSync(path.join(app, "layouts", "work.json"), JSON.stringify(WORK));
  fs.writeFileSync(path.join(app, "layouts", "plain.json"), JSON.stringify(PLAIN));
  fs.writeFileSync(path.join(app, "settings.json"), '{\n  "sounds": {\n    "enabled": true\n  }\n}\n');
  fs.writeFileSync(path.join(app, "quiet-hours", "config.json"), JSON.stringify(config));
  const now = Date.now();
  fs.writeFileSync(path.join(app, "quiet-hours", "control.json"), JSON.stringify({ unlock: null, manual: { start: now - 60_000, end: now + 3_600_000 } }));
  fs.writeFileSync(path.join(app, "shown"), shown);
  fs.writeFileSync(path.join(app, "herdr-app"), FAKE_HERDR, { mode: 0o755 });

  const child = spawn(process.execPath, [path.join(mod, "quietd.mjs")], { env: { ...process.env, HERDR_APP_BIN: path.join(app, "herdr-app") }, stdio: "ignore" });
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(app, rel), "utf8");
    } catch {
      return null;
    }
  };
  let pokes = 0;
  return {
    shown: () => read("shown"),
    switches: () => (read("calls") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l).name),
    sounds: () => JSON.parse(read("settings.json")).sounds.enabled,
    state: () => JSON.parse(read("quiet-hours/state.json") ?? "null"),
    log: () => (read("quiet-hours/log.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    // The person picks a layout: the window shows it, and shared.json (its
    // "layout") changes, which the watcher answers at once.
    pick(name) {
      fs.writeFileSync(path.join(app, ".shown.tmp"), name);
      fs.renameSync(path.join(app, ".shown.tmp"), path.join(app, "shown"));
      fs.writeFileSync(path.join(app, "shared.json"), JSON.stringify({ layout: name, n: ++pokes }));
    },
    endQuiet: () => fs.writeFileSync(path.join(app, "quiet-hours", "control.json"), JSON.stringify({ unlock: null, manual: null })),
    async stop() {
      const gone = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await gone;
      fs.rmSync(app, { recursive: true, force: true });
    },
  };
}

async function until(what, check) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if (check()) return;
    } catch {}
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("only_with_chip: a layout without the chip is left alone; leaving the board for one is a bypass that stays", async () => {
  const h = quietHome({ enabled: false, only_with_chip: true }, "plain");
  try {
    // Quiet starts in a layout without the chip: logged, no switch, sounds as they were.
    await until("quiet", () => h.state()?.quiet === true);
    assert.equal(h.log().filter((e) => e.type === "manual-start").length, 1);
    assert.deepEqual(h.switches(), []);
    assert.equal(h.shown(), "plain");
    assert.equal(h.sounds(), true);
    assert.equal(h.state().soundsSaved, false);

    // To a layout with the chip: the board, the sounds off, it becomes the morning's layout.
    h.pick("work");
    await until("the board", () => h.shown() === "quiet-hours" && h.state().soundsSaved === true);
    assert.deepEqual(h.switches(), ["quiet-hours"]);
    assert.equal(h.sounds(), false);
    assert.equal(h.state().returnLayout, "work");

    // Off the locked board to the layout without it: a bypass that stays, the sounds back.
    h.pick("plain");
    await until("the bypass", () => h.log().some((e) => e.type === "bypass") && h.state().soundsSaved === false);
    const bypass = h.log().filter((e) => e.type === "bypass");
    assert.equal(bypass.length, 1);
    assert.deepEqual({ ...bypass[0], at: 0 }, { at: 0, type: "bypass", to: "plain", kind: "manual", stayed: true });
    assert.equal(h.shown(), "plain");
    assert.deepEqual(h.switches(), ["quiet-hours"]);
    assert.equal(h.sounds(), true);
    assert.equal(h.state().returnLayout, "work");

    // Back to the chip: the board again (no bypass: it wasn't on the board), sounds off again.
    h.pick("work");
    await until("the board again", () => h.shown() === "quiet-hours" && h.state().soundsSaved === true);
    assert.deepEqual(h.switches(), ["quiet-hours", "quiet-hours"]);
    assert.equal(h.log().filter((e) => e.type === "bypass").length, 1);
    assert.equal(h.sounds(), false);

    // Off to the chipless layout once more, and quiet ends there: no switch, logged.
    h.pick("plain");
    await until("the second bypass", () => h.log().filter((e) => e.type === "bypass").length === 2 && h.state().soundsSaved === false);
    h.endQuiet();
    await until("quiet's end", () => h.state()?.quiet === false);
    assert.equal(h.log().filter((e) => e.type === "manual-end").length, 1);
    assert.deepEqual(h.switches(), ["quiet-hours", "quiet-hours"]);
    assert.equal(h.shown(), "plain");
    assert.equal(h.sounds(), true);
    assert.equal(h.state().returnLayout, "work");
  } finally {
    await h.stop();
  }
});

test("only_with_chip off (the default): quiet follows you into a layout without the chip, as before", async () => {
  const h = quietHome({ enabled: false }, "plain");
  try {
    await until("the board", () => h.shown() === "quiet-hours" && h.state()?.soundsSaved === true);
    assert.deepEqual(h.switches(), ["quiet-hours"]);
    assert.equal(h.sounds(), false);
    assert.equal(h.state().returnLayout, "plain");
    // Off the locked board: a bypass, pulled back, and not the morning's layout.
    h.pick("work");
    await until("the bypass", () => h.log().some((e) => e.type === "bypass") && h.switches().length === 2 && h.shown() === "quiet-hours");
    const bypass = h.log().filter((e) => e.type === "bypass");
    assert.deepEqual({ ...bypass[0], at: 0 }, { at: 0, type: "bypass", to: "work", kind: "manual" });
    assert.equal(h.state().returnLayout, "plain");
    // Quiet ends on the board: back to where quiet began.
    h.endQuiet();
    await until("the way back", () => h.state()?.quiet === false && h.shown() === "plain");
    assert.deepEqual(h.switches(), ["quiet-hours", "quiet-hours", "plain"]);
    await until("the sounds back", () => h.sounds() === true);
  } finally {
    await h.stop();
  }
});
