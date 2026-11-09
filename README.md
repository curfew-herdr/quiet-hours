# Quiet hours

Quiet hours for herdr. At night the window turns into a dim board of your agents, herdr's sounds
go off, and every way out is logged: a 10-minute unlock, "quiet now" for a meeting, per-day
hours, a guardrail against ending tonight early, and a summary of the night in the morning.

It doesn't make night work impossible; it makes drifting into it visible.

## What it does

- **The board.** During your quiet hours the window switches to the `quiet-hours` layout: one
  dim screen with `[ QUIET ]`, when quiet ends and the time, a count (`2 working · 1 waiting`),
  and a row per agent (a dot, its tab or program, its space, its status). No terminals, no
  tabs, no colours that call for action. Switching to another layout is logged as a bypass and
  undone.
- **A logged unlock.** `unlock 10 min` on the board gives the window back for 10 minutes (you
  choose the length, 1 to 240). The chip counts down (`9:52 left`) and has `lock now`. Each
  unlock is a line in the log.
- **Quiet now.** In the day, the chip's `Quiet` starts an hour of quiet; `30m`, `1h` and `2h`
  start that long. `end quiet` ends it early.
- **Settings.** The clock at the chip's right end opens a dialog: quiet hours on or off, every
  night's hours (or none), each weekday the same, off, or its own hours, and the unlock length.
  Times are 24-hour `HH:MM`; a field that isn't valid says why, and Save never writes a bad
  config.
- **The apply-tonight guardrail.** At night, a change that would end tonight's quiet early (an
  earlier end, tonight off, quiet hours off) waits for tomorrow. Saving it asks *Apply
  tonight?*; **Yes, tonight** applies it now and logs it, **No, from tomorrow** saves it for the
  next night. Other changes apply at once.
- **Overnight.** When a night ends, one notification: the agents now, how many unlocks and
  minutes, bypasses, and whether new hours were applied tonight.
- **Sounds off at night.** herdr's done and blocked sounds are off during quiet and back after.

## Install

Copying the folder alone shows nothing: the chip has to be placed in a layout (step 3).

**The gallery way:** ask your agent in herdr to add `herdr.dev/mods/rquellh/herdr-quiet-hours`
and to put its chip in your sidebar (step 3).

**By hand**, from a clone of this repo:

1. Check the name is free: `ls ~/.config/herdr-app/mods/quiet-hours` should find nothing.
2. Copy the folder in one move, so herdr never sees the folder before its `mod.json`:

   ```sh
   H=~/.config/herdr-app
   mkdir "$H/.incoming" && cp -R mods/quiet-hours "$H/.incoming/" \
     && mv "$H/.incoming/quiet-hours" "$H/mods/" && rmdir "$H/.incoming"
   herdr-app check "$H/mods/quiet-hours"
   ```

3. Add the chip to a layout. For herdr's own layout, clone it (the clone becomes the shown
   layout; `main` itself is replaced on every herdr start, so it can't be edited):

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"main-quiet"}'
   ```

   then in `~/.config/herdr-app/layouts/main-quiet.json` append this block to the `children`
   of the node whose `id` is `"sidebar"` (after `sidebar-footer`):

   ```json
   { "id": "quiet-chip", "type": "block", "content": { "mod": "quiet-hours", "props": { "role": "chip" } }, "size": { "px": 36 } }
   ```

   Or let node do the edit:

   ```sh
   node -e '
   const fs = require("fs"), f = process.argv[1], l = JSON.parse(fs.readFileSync(f, "utf8"));
   const find = (n) => n.id === "sidebar" ? n : (n.children ?? []).map(find).find(Boolean);
   find(l).children.push({ id: "quiet-chip", type: "block", content: { mod: "quiet-hours", props: { role: "chip" } }, size: { px: 36 } });
   fs.writeFileSync(f, JSON.stringify(l, null, 2) + "\n");' ~/.config/herdr-app/layouts/main-quiet.json
   herdr-app status   # "errors": []
   ```

   Any other layout works the same way: a 36 px block at the foot of a sidebar column at least
   160 px wide. A layout that ships the chip already (such as
   [herdr-curfew](https://github.com/rquellh/herdr-curfew)) needs no edit.
4. Turn it on. A new install starts with the schedule **off**, so installing in the evening
   doesn't lock the window. Click the clock at the chip's right end, switch *Quiet hours on*,
   set your hours (18:00 to 08:00 to start) and Save. "Quiet now" works either way.

The first time the chip shows, it starts the watcher (below) and creates
`~/.config/herdr-app/quiet-hours/config.json`.

## What it runs

Before you add it, know that this mod runs programs and writes files outside its folder:

- **A background watcher.** `mods/quiet-hours/quietd.mjs`, a node process, started by the chip
  or the board as a hidden herdr-core terminal:
  `hc run --bg --no-parent --name quiet-hours-watcher --label quiet-hours.watcher=1 -- <node> quietd.mjs`.
  It keeps running while herdr is closed. The mod checks on it every minute (`hc ls`, `hc get`)
  and restarts one from another version (`hc kill`, `hc rm`). To find node it runs
  `/bin/sh -c "command -v node"` and `node --version`.
- **herdr commands.** The watcher runs `herdr-app status` (which layout is shown) and
  `herdr-app do layout.switch` (to the board and back) against this window.
- **Files it writes**, all under `~/.config/herdr-app`:
  - `quiet-hours/`: `config.json` (your settings; the dialog writes it too), `control.json`
    (unlock and quiet-now requests), `state.json`, `log.jsonl` (every start, end, unlock, lock,
    bypass and apply-tonight), `quietd.pid`.
  - `settings.json`: only `sounds.enabled`, set to `false` during quiet and back to `true` after
    (the rest of the file is left byte for byte).
  - `layouts/quiet-hours.json`: the board's layout, written from `mods/quiet-hours/quiet.layout.json`
    when the watcher starts (and when quiet starts) if the file is missing. It then shows in
    herdr's layout list.
- **Files it reads:** the above. The watcher also watches `settings.json` and `shared.json`
  so it answers a change (sounds turned back on, a switch away from the board) at once.
- **Network:** none.

## Stop it

- A quiet now: `end quiet` on the board, or on the chip while unlocked.
- Tonight: `unlock` (logged). In the day, switch quiet hours off in the settings.
- The watcher: switch to a layout without the chip (the chip and the board start it again
  within a minute), then `hc kill quiet-hours-watcher`. It turns the sounds back on as it exits.

## Uninstall

Stop the watcher as above, then delete `~/.config/herdr-app/mods/quiet-hours/`,
`layouts/quiet-hours.json`, `quiet-hours/` and the chip block (or your `main-quiet` clone).

## Limits

- herdr's own "finished" and "needs you" notifications still show on the board for about 5
  seconds (silent: sounds are off). A mod can't hold them back.
- No watcher, no quiet: after herdr-core restarts, quiet resumes once the chip or board is on
  screen again (within a minute).
- The overnight notification is posted by the chip, so it needs a layout with the chip.
- `ctrl-shift-l` stops at the board in the day; the watcher sends you straight back. Pick
  other layouts from the palette.
- The schedule follows this computer's clock; one window belongs to the day it starts.

The full reference (every file, the config keys, the guardrail's rules) is
[`mods/quiet-hours/README.md`](mods/quiet-hours/README.md).

## Requirements

- herdr (built against herdr-app 0.1.14), with herdr-core (`hc`) on this computer.
- node 18 or later on `PATH`, in `/usr/local/bin` or in `/opt/homebrew/bin`.
- Built and used on macOS. Nothing in it is macOS-only, but it has not been tried on Linux; it
  does not run on Windows (it starts node through `/bin/sh`).

## Tests

```sh
cd mods/quiet-hours && node --test
```

## Licence

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
