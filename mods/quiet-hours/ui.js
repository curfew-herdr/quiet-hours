// What the quiet mod draws: the board (quiet hours), the chip (work hours, at
// the bottom of the sidebar) and the chip's "quiet now" menu. Pure functions
// of what they're given; main.js owns state and actions. The settings dialog
// is settings.js.
//
// The board's rule: at night nothing on screen may read as a message or a
// call to action. Dim surfaces, no status colours, one slow pulse.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { rowName } from "./names.mjs";

// herdr's statuses as the board words them; blocked is "waiting", neutral.
const WORD = { working: "working", blocked: "waiting", done: "done", idle: "idle" };
const ORDER = ["working", "waiting", "done", "idle"];
const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const pad = (n) => String(n).padStart(2, "0");
export const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// "2 working · 1 waiting · 3 done"; zero counts left out.
export function countLine(list) {
  const n = Object.fromEntries(ORDER.map((w) => [w, 0]));
  for (const a of list) n[WORD[a.status] ?? "idle"]++;
  const parts = ORDER.filter((w) => n[w]).map((w) => `${n[w]} ${w}`);
  return parts.length ? parts.join(" · ") : "nothing running";
}

// The morning's one line: the agents now, then the night's unlocks, bypasses
// and new hours applied tonight (the settings' "Yes, tonight").
export function summaryLine(list, s) {
  const parts = [countLine(list)];
  if (s.unlocks) parts.push(`unlocked ${s.unlocks}× (${s.unlockMinutes} min)`);
  if (s.bypasses) parts.push(`${s.bypasses} ${s.bypasses === 1 ? "bypass" : "bypasses"}`);
  if (s.appliedTonight) parts.push(`applied tonight ${s.appliedTonight > 1 ? `${s.appliedTonight}×, last ` : ""}at ${hm(s.appliedAt)}`);
  return parts.join(" · ");
}

export const unlockedNow = (state, now) => Boolean(state?.quiet && state.unlock && state.unlock.until > now);
const minutesLeft = (state, now) => Math.max(1, Math.ceil((state.unlock.until - now) / 60_000));

// ---- the board ---------------------------------------------------------------

export function board({ t, mono, state, now, agents, error, onUnlock, onEnd }) {
  const quiet = Boolean(state?.quiet);
  const unlocked = unlockedNow(state, now);
  // A quiet now (a meeting) can be ended; the scheduled night can't.
  const manual = state?.kind === "manual";
  const clock = !state
    ? hm(now)
    : quiet
      ? state.kind === "manual"
        ? `until ${hm(state.windowEnd)}`
        : `until ${hm(state.windowEnd)} · ${hm(now)}`
      : state.nextStart
        ? `next ${hm(state.nextStart)} · ${hm(now)}`
        : hm(now);
  const faint = (text) => div().font_family(mono).text_size(12).text_color(t.dim).child(text);

  // An agent: its dot, its name (names.mjs: its Claude Code session's, else its tab's or
  // program's), its project faint (main.js: the git repository it works in), its status.
  const row = (a) => {
    const working = a.status === "working";
    return h_flex()
      .id(`quiet-row-${a.address}`)
      .h(28)
      .flex_none()
      .gap(10)
      .items_center()
      .child(
        div()
          .size(6)
          .flex_none()
          .rounded_full()
          .bg(working ? t.accent : t.dim)
          .when(working, (el) => el.loop("opacity", { from: 0.3, to: 1, period: 2600 })),
      )
      .child(div().flex_none().max_w(240).truncate().text_size(13).text_color(t.muted).child(rowName(a)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(a.project ?? ""))
      .child(div().flex_none().font_family(mono).text_size(11.5).text_color(t.dim).child(WORD[a.status] ?? a.status));
  };

  const ghost = (id, text, action) =>
    div()
      .id(id)
      .h(30)
      .px(14)
      .flex()
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .text_size(12.5)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.border_color(t.input))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(text);

  return v_flex()
    .id("quiet-board")
    .size_full()
    .bg(t.chrome)
    .pt(56)
    .pb(28)
    .px(40)
    .child(
      v_flex()
        .w_full()
        .max_w(560)
        .mx_auto()
        .flex_1()
        .min_h(0)
        .gap(18)
        .child(
          h_flex()
            .flex_none()
            .justify_between()
            .items_center()
            .child(div().font_family(mono).text_size(12).text_color(t.muted).child("[ QUIET ]"))
            .child(faint(clock)),
        )
        .child(faint(countLine(agents)).flex_none())
        .child(v_flex().id("quiet-rows").flex_1().min_h(0).overflow_y_scroll().children(agents.map(row)))
        .child(
          h_flex()
            .flex_none()
            .justify_center()
            .gap(10)
            .when(quiet && !unlocked, (el) => el.child(ghost("quiet-unlock", `unlock ${state?.unlockMinutes ?? 10} min`, onUnlock)))
            .when(quiet && !unlocked && manual, (el) => el.child(ghost("quiet-end", "end quiet", onEnd)))
            .when(unlocked, (el) => el.child(faint(`unlocked · ${minutesLeft(state, now)}m left`))),
        )
        .when(Boolean(error), (el) => el.child(div().flex_none().truncate().text_size(11.5).text_color(t.dim).child(error))),
    );
}

// ---- the chip ----------------------------------------------------------------
//
// que's foot row. Outside a quiet window: "Quiet" (an hour) and the lengths
// 30m 1h 2h right after it, the group taking the hover as a whole; at the
// right end, faint, when the next window starts (it opens the settings).
// While unlocked: the accent lock, the countdown ticking each second, and
// "lock now" (and "end quiet" for a quiet now) faint at the right.

export const QUIET_LENGTHS = [
  [30, "30m", "Quiet for 30 minutes"],
  [60, "1h", "Quiet for 1 hour"],
  [120, "2h", "Quiet for 2 hours"],
];

// When the next window starts: "18:00" today, "mon 18:00" on another day.
function nextLabel(state, now) {
  if (!state) return "";
  if (state.quiet) return `until ${hm(state.windowEnd)}`;
  if (!state.nextStart) return "off";
  return sameDay(state.nextStart, now) ? hm(state.nextStart) : `${DAY[new Date(state.nextStart).getDay()]} ${hm(state.nextStart)}`;
}

export function chip({ t, mono, state, now, error, hover, collapsed, countdown, onHover, onQuiet, onQuietNow, onLock, onEnd, onSettings }) {
  const unlocked = unlockedNow(state, now);
  const next = nextLabel(state, now);
  const small = (el) => el.font_family(mono).text_size(11);
  // A faint word that brightens under the pointer, no surface (que's "lock now").
  const faintLink = (id, text, action) =>
    small(div().id(id).flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.muted)).on_click(action).child(text));

  const row = h_flex().id("quiet-chip").h(26).items_center();
  // The settings: the next start (or the error), faint, at the right end.
  const opener = (words, tip) =>
    h_flex()
      .id("quiet-settings")
      .flex_none()
      .min_w(0)
      .h(26)
      .px(6)
      .gap(6)
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .text_color(error ? t.muted : t.dim)
      .hover((s) => s.text_color(t.muted))
      .tooltip(error ?? tip)
      .on_click(onSettings)
      .child(svg("mods/workspace-chrome/clock.svg").size(12).flex_none())
      .child(small(div().truncate()).child(words));

  let body;
  if (collapsed) {
    body = row
      .w(32)
      .justify_center()
      .rounded(4)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(error ?? (unlocked ? `${countdown} left · click to lock` : `quiet ${next} · click for quiet now`))
      .on_click(unlocked ? onLock : onQuietNow)
      .child(svg(unlocked ? "mods/quiet-hours/unlock.svg" : "mods/workspace-chrome/clock.svg").size(12).flex_none().text_color(unlocked ? t.accent : t.dim));
  } else if (unlocked) {
    body = row
      .px(8)
      .gap(6)
      .child(
        h_flex()
          .id("quiet-unlock")
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .text_color(t.accent)
          .tooltip(error ?? (state?.pending ? "unlocked · new hours from tomorrow · quiet hours settings" : "unlocked · quiet hours settings"))
          .on_click(onSettings)
          .child(svg("mods/quiet-hours/unlock.svg").size(12).flex_none())
          .child(small(div().flex_none()).child(`${countdown} left`))
          .when(Boolean(state?.pending), (el) => el.child(small(div().flex_1().min_w(0).truncate().text_color(t.dim)).child("· new hours tomorrow"))),
      )
      .child(faintLink("quiet-lock", "lock now", onLock))
      .when(state?.kind === "manual", (el) => el.child(faintLink("quiet-end", "end quiet", onEnd)));
  } else if (state?.quiet) {
    // Quiet and locked: the board is up; this shows only until it switches.
    body = row.child(div().flex_1()).child(opener(next, "quiet hours settings"));
  } else {
    const group = h_flex()
      .id("quiet-row")
      .flex_none()
      .h(26)
      .pr(8)
      .items_center()
      .rounded(4)
      .hover((s) => s.bg(t.hover))
      .on_hover(onHover)
      .child(
        div()
          .id("quiet-word")
          .h_full()
          .pl(8)
          .pr(6)
          .flex()
          .items_center()
          .cursor_pointer()
          .text_size(12.5)
          .text_color(hover ? t.foreground : t.muted)
          .tooltip("Quiet for 1 hour")
          .on_click((e, cx) => onQuiet(60, cx))
          .child("Quiet"),
      )
      .child(
        small(h_flex().gap(10).items_center()).children(
          QUIET_LENGTHS.map(([minutes, text, tip]) =>
            div()
              .id(`quiet-${minutes}`)
              .cursor_pointer()
              .text_color(minutes === 60 ? t.muted : t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip(tip)
              .on_click((e, cx) => onQuiet(minutes, cx))
              .child(text),
          ),
        ),
      );
    body = row
      .child(group)
      .child(div().flex_1())
      .child(opener(error ?? next, next === "off" ? "quiet hours are off · settings" : `quiet hours from ${next} · settings`));
  }

  return v_flex()
    .size_full()
    .bg(t.chrome)
    .px(6)
    .pb(8)
    .justify_end()
    .text_size(13)
    .when(collapsed, (el) => el.px(0).items_center())
    .child(body);
}

// ---- the chip's menu ---------------------------------------------------------

export const QUIET_FOR = [
  [30, "30 min"],
  [60, "1 hour"],
  [120, "2 hours"],
];

export function menu({ t, onPick }) {
  return v_flex()
    .w_full()
    .p(5)
    .bg(t.popover)
    .text_size(12.8)
    .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Quiet for"))
    .children(
      QUIET_FOR.map(([minutes, label]) =>
        h_flex()
          .id(`quiet-for-${minutes}`)
          .h(31)
          .px(8)
          .rounded(7)
          .items_center()
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => onPick(minutes, cx))
          .child(label),
      ),
    );
}
