# quiet-hours

Quiet hours for herdr. During your quiet hours (18:00 to 08:00 when you turn
them on) the window shows a dim board instead of your terminals, herdr's sounds
are off, and every way out is logged. It doesn't make night work impossible, it
makes drifting into it visible.

## Files

| File | What it is |
|---|---|
| `mods/quiet-hours/main.js`, `ui.js`, `settings.js` | the mod: `role: "board"` (the quiet screen), `"chip"` (sidebar control), `"menu"` (the chip's popup), `"settings"` (the settings dialog); no role draws an inert preview of all of them (what `herdr-app check` and `herdr-app do mod.open '{"name":"quiet-hours"}'` show; `mod.json` sizes that preview). The preview never starts the watcher or writes a file: `herdr-app check` runs a mod's `init` against the real app home. |
| `mods/quiet-hours/quietd.mjs` | the watcher: a node process, the only writer of `state.json` and `log.jsonl` |
| `mods/quiet-hours/clock.mjs` | the rules, pure functions of `now`: windows, config validation, the apply-tonight guardrail. No node imports: the watcher and the mod import this one file |
| `mods/quiet-hours/form.mjs` | the settings dialog's form to and from `config.json`, through `clock.mjs`'s validation (`node --test` runs `clock.test.mjs`, `form.test.mjs`, `names.test.mjs`, `quietd.test.mjs`) |
| `mods/quiet-hours/names.mjs` | what a board row says, pure functions: the name a Claude Code session gives itself in its terminal title, and the project (the git repository) of an agent's folder from git's answer |
| `mods/quiet-hours/quiet.layout.json` | the board layout; the watcher writes it to `layouts/quiet-hours.json` when it starts, and again when quiet starts, if that file is missing |
| `mods/quiet-hours/unlock.svg` | the open lock the chip shows while unlocked (the clock icon is herdr's own, `mods/workspace-chrome/clock.svg`) |
| `layouts/quiet-hours.json` | the board: one dim block, no tabs or terminals |
| `quiet-hours/config.json` | your settings (below); created on first run |
| `quiet-hours/control.json` | what the mod asks for: `{ "unlock": {startedAt, until} \| null, "manual": {start, end} \| null, "applyTonight": {windowStart, at} }` (`applyTonight` only after a "Yes, tonight") |
| `quiet-hours/state.json` | what the watcher decided (the mod reads this); with `held` and `pending` (below) |
| `quiet-hours/log.jsonl` | one line per event: `window-start`, `window-end`, `manual-start`, `manual-end`, `unlock`, `relock`, `lock`, `bypass`, `apply-tonight` |
| `quiet-hours/quietd.pid` | the running watcher's process id |

`quiet-hours/` is in the app home (`~/.config/herdr-app/quiet-hours/`), outside
the mod folder: herdr reloads a mod whose files change.

## Add the chip to a layout

The chip is a block with `props.role: "chip"`; a layout has to name it. To add
it to herdr's own layout, clone it (the clone becomes the shown layout) and put
the block last in its sidebar column:

```sh
herdr-app do layout.clone '{"name":"main","as":"main-quiet"}'
```

then, in `layouts/main-quiet.json`, append to the `children` of the node with
`"id": "sidebar"`:

```json
{ "id": "quiet-chip", "type": "block", "content": { "mod": "quiet-hours", "props": { "role": "chip" } }, "size": { "px": 36 } }
```

The window follows within a second; `herdr-app status` should show
`"errors": []`. Any layout works the same way: a 36 px block at the foot of a
sidebar column, 160 px wide or more (narrower, the chip draws only its icon).

## Config: `quiet-hours/config.json`

```json
{ "enabled": true, "default": ["18:00", "08:00"], "days": { "sat": "none", "sun": ["20:00", "09:00"] },
  "unlock_minutes": 10, "return_layout": "main" }
```

- `enabled`: the schedule. `false` turns it off; "quiet now" still works. The
  first run writes `enabled: false` (with every other key at its default), so
  installing in the evening never locks the window at once.
- `default`: the nightly window. A window belongs to the day it starts; an end at
  or before the start ends the next morning. `"none"` for no default window.
- `days`: per weekday (`sun` .. `sat`), `"none"` or its own window.
- `unlock_minutes`: how long one unlock lasts, 1 to 240. A new unlock is a new log entry.
- `return_layout`: where the window goes when quiet ends if the layout that was
  shown when quiet began is gone (default `main`). The watcher remembers that
  layout itself (`state.json` `returnLayout`).

A broken edit keeps the last good config and shows the reason on the chip.

## The board

The quiet screen: `[ QUIET ]` with when quiet ends and the time, a count
(`2 working · 1 waiting`), and a row per agent:

```
●  Small bug hunt   uploader   working
```

- The name: the one the agent's Claude Code session gave itself in its terminal
  title (from its first prompt or `/rename`), without the leading `✳`, `◐` or
  `◑`, at most 80 characters. Before the session has a name (`Claude Code`, an
  empty title, or no title at all, which herdr reports as the terminal's
  address), and for other agents: the tab's name if someone named it, else the
  program's.
- Faint, the project: the git repository the agent works in (its pane's live
  folder, else its space's folder), by the main checkout's folder name, so every
  worktree of `uploader` reads `uploader`. Outside a repository, the folder's
  name, `~` for the home folder.
- The status: `working` (the dot pulses), `waiting`, `done` or `idle`.

At the bottom, `unlock 10 min`, and `end quiet` in a quiet now.

## The chip

The row at the bottom of the sidebar:

- Outside quiet hours: `Quiet 30m 1h 2h`. `Quiet` starts an hour of quiet now,
  each length starts that many minutes. At the right end, faint, the clock and
  when the next window starts (`18:00`, `mon 18:00`, or `off`).
- While unlocked: the accent lock and a countdown ticking each second
  (`9:52 left`), then `lock now`, and `end quiet` in a quiet now.
- A narrow sidebar (under 160 px) shows only the icon; it opens the "quiet for" menu.

## Settings

Click the clock and the time at the chip's right end (or, while unlocked, the
countdown). The dialog has:

- a switch for `enabled`;
- `Every night`: `hours` with a start and an end, or `none`;
- a row per weekday, Monday first: `same` (the nightly hours, shown faint),
  `off` (`"none"`), or `custom` with its own start and end;
- `Unlock`: minutes, 1 to 240;
- Cancel and Save (Enter in a field saves, Esc closes).

Times are typed as 24-hour `HH:MM` (`8:00` is fine and is saved as `08:00`).
A field that isn't valid shows why at the end of its row once you leave it, and
every one shows after Save; Save never writes an invalid config. The checks are
the watcher's own (`clock.mjs`, through `form.mjs`). Save writes `config.json`
in place with its snapshot, keeping keys the dialog doesn't edit
(`return_layout`) and the 2-space format.

The board has no settings, on purpose: at night you unlock first (logged), and
the chip's settings work while the unlock lasts. When quiet locks again (the
unlock runs out) an open dialog closes.

## Changing the hours at night: the apply-tonight guardrail

Editing `config.json` mid-window isn't a quiet way out. When a scheduled window
starts, the watcher holds the config it starts under (`state.json` `held`:
`{start, end, config}`, kept across a watcher restart). While the window lasts:

- A change that would end it sooner, or remove it (`enabled: false`, that
  night `none`, an earlier end), waits until the window ends: the held config
  stays in force, whole (the unlock length too), and `state.json` says
  `pending: true`. The chip, while unlocked, shows `new hours tomorrow`.
- Any other change (a later end, another unlock length, other nights) applies
  at once and becomes the held config, so the next edit is measured against
  what's in force.
- "Apply tonight" overrides this for the window in progress. When a Save would
  end tonight's hours early, the dialog asks: *Apply tonight? This ends
  tonight's quiet hours early.* **No, from tomorrow** saves (pending);
  **Yes, tonight** saves and writes `control.json` `applyTonight:
  {windowStart: <held start>, at: <now>}`. The watcher honours a request once,
  and only for the held window: it logs `apply-tonight` (`windowEnd`, the held
  end, and `newEnd`, `null` when the window is gone) and the new config is in
  force. The morning `Overnight` line says `applied tonight at 23:40`. A request
  for an ended window is ignored, and the mod drops it at its next write.

A manual window ("quiet now") isn't affected by schedule edits. Edits outside a
scheduled window apply at once.

## How it works

- The board and the chip make sure the watcher runs: they look for a live core
  terminal labelled `quiet-hours.watcher` (`hc ls --label quiet-hours.watcher=1`) and start
  one if there is none (`hc run --bg --no-parent --name quiet-hours-watcher --label
  quiet-hours.watcher=1 -- <node> quietd.mjs`, no `herdr.space`/`herdr.tab` labels, so
  it stays out of the window). `<node>` is the first node 18 or later from
  `command -v node`, `/usr/local/bin/node`, `/opt/homebrew/bin/node`. They check
  again every minute and restart a watcher whose `state.version` differs from theirs.
- The board asks git which repository each agent's folder is in, read-only:
  `git --no-optional-locks -c core.fsmonitor=false -C <folder> rev-parse
  --path-format=absolute --git-common-dir` (at most 5 s; for a space on another
  machine, on that machine). Once per folder, when it first shows up among the
  agents, from a task and never while drawing; the answers last while the board
  is up. A row's project is blank until git answers, and the folder's name when
  git fails. The chip and the preview run no git.
- The watcher ticks every 15 s, at the next boundary, and at once when
  `config.json`, `control.json`, `settings.json` or `shared.json` change. It
  reads the shown layout from `herdr-app status`. Quiet and not unlocked: it
  switches to `quiet-hours` (a switch away from the board is logged as a `bypass` and
  undone). Not quiet, or unlocked: it switches from `quiet-hours` back to the layout you
  were on.
- Sounds: entering quiet with `settings.json` `sounds.enabled: true`, it sets it to
  false and puts it back when quiet ends (or when the watcher stops). Only that
  value changes; the rest of the file is left byte for byte.
- When a scheduled window ends, the chip posts one `Overnight` notification with
  the agents now and the night's unlocks, bypasses and apply-tonight changes.

## Stop it

- A quiet now: "end quiet" on the board, or in the chip while unlocked. The
  scheduled night has no end button, only unlock.
- For a night: unlock (the board's button). In the evening, `"enabled": false`
  (or the settings' switch); at night that change waits for the morning unless
  you unlock and apply it tonight, which is logged.
- The watcher: `hc kill quiet-hours-watcher` (or `hc kill <address>` from
  `hc ls --label quiet-hours.watcher=1`). It restores the sounds as it exits. While the
  board or chip is on screen the mod starts it again within a minute, so to stop
  for good, switch to a layout without the chip first (herdr's own:
  `herdr-app do layout.switch '{"name":"main"}'`), then kill it.
- Remove: the above, then delete `mods/quiet-hours/`, `layouts/quiet-hours.json`,
  `layouts/quiet-hours.svg` (if there), `quiet-hours/`, and the chip block from
  your layout.

## Known limits

- herdr's own "finished" / "needs you" toasts still show on the board for about
  5 s (silent, since sounds are off). A mod can't close or suppress them.
- No watcher, no quiet: if herdr-core restarts, the watcher is back when the board
  or chip next checks (within a minute of herdr showing them).
- `ctrl-shift-l` cycling stops at `quiet-hours` in work hours: the watcher sends the
  window straight back to the work layout. Pick other layouts from the palette.
- The escape hatch (`ctrl-alt-shift-escape`) sets the shown layout aside: during
  quiet that is `quiet-hours.json`, which the watcher restores (and logs a bypass). If
  it's your own layout, the return falls back to `return_layout` until you move it back.
- The morning notification needs the chip: if quiet ends on a layout without it,
  there is none.
- A switch away and back within a few hundred ms can go unseen as a bypass.
- herdr has no way to tell a mod it is on the board's layout "for real", so the
  board's layout is a plain file the watcher keeps; Settings shows it without a
  picture unless `layouts/quiet-hours.svg` is there.
