// The settings dialog: quiet hours on or off, the nightly window, a row per
// weekday (same, off, or its own hours, as que's settings lay them out), the
// unlock length, whether quiet applies only in layouts with the quiet chip
// (the on/off switch again, with a faint line under it), and Save. Drawn in
// que's language: a bracketed mono label, hairlines, neutral greys, nearly
// square corners with the four corner points of a drawing's frame; the accent
// only on the field being typed in, and que's light primary button for Save.
//
// SettingsForm holds the live fields; settingsDialog draws them. main.js reads
// and writes the files (and asks "Apply tonight?").

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { DAYS } from "./clock.mjs";
import { WEEK } from "./form.mjs";

// A tone between foreground and muted (#c9c9c9 in the curfew theme); the theme has no name for it.
// The tone of a head's label.
function secondary(t) {
  const ch = (c, i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(t.foreground, i) * 0.55 + ch(t.muted, i) * 0.45).toString(16).padStart(2, "0")).join("");
}

export const DIALOG = { width: 500, height: 520 };

const NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const TIME_KEYS = ["start", "end", ...DAYS.flatMap((d) => [`${d}.start`, `${d}.end`])];

// A time field's text in a plain form: "start", or "mon.end".
function textOf(form, key) {
  const [day, part] = key.includes(".") ? key.split(".") : [null, key];
  return day ? form.days[day][part] : form[part];
}

// The dialog's fields: an InputState per time and for the unlock length, and
// the switches and modes. Build it in init: InputState.new needs a live host call.
export class SettingsForm {
  constructor(form, onSubmit) {
    this.inputs = {};
    this.focused = null;
    const field = (key, value) => {
      const s = InputState.new({ value, placeholder: key === "unlock" ? "" : "HH:MM" });
      s.on("focus", (_e, cx) => {
        this.focused = key;
        cx.notify();
      });
      s.on("blur", (_e, cx) => {
        if (this.focused === key) this.focused = null;
        cx.notify();
      });
      s.on("change", (_e, cx) => cx.notify());
      s.on("submit", (_e, cx) => onSubmit(cx));
      this.inputs[key] = s;
    };
    for (const key of TIME_KEYS) field(key, textOf(form, key));
    field("unlock", form.unlock);
    this.take(form);
  }

  // The switches, the modes, and what the fields were filled with.
  take(form) {
    this.enabled = form.enabled;
    this.onlyWithChip = Boolean(form.onlyWithChip);
    this.nightly = form.nightly;
    this.mode = Object.fromEntries(DAYS.map((d) => [d, form.days[d].mode]));
    this.loaded = { ...this.mode };
    this.filled = Object.fromEntries(TIME_KEYS.map((k) => [k, textOf(form, k)]));
  }

  // Puts in a form read later (the file, once read).
  set(form) {
    for (const key of TIME_KEYS) this.inputs[key].set_value(textOf(form, key));
    this.inputs.unlock.set_value(form.unlock);
    this.take(form);
  }

  value(key) {
    return this.inputs[key].value();
  }

  // The form's plain values, for form.mjs.
  form() {
    const days = Object.fromEntries(DAYS.map((d) => [d, { mode: this.mode[d], start: this.value(`${d}.start`), end: this.value(`${d}.end`) }]));
    return { enabled: this.enabled, nightly: this.nightly, start: this.value("start"), end: this.value("end"), days, unlock: this.value("unlock"), onlyWithChip: this.onlyWithChip };
  }

  // A day switched to custom starts from the nightly hours, unless it had its
  // own when the dialog opened or its fields were edited since.
  setMode(day, mode) {
    const fresh = this.loaded[day] !== "custom" && ["start", "end"].every((p) => this.value(`${day}.${p}`) === this.filled[`${day}.${p}`]);
    if (mode === "custom" && this.mode[day] !== "custom" && fresh && this.nightly === "hours") {
      this.inputs[`${day}.start`].set_value(this.value("start"));
      this.inputs[`${day}.end`].set_value(this.value("end"));
      this.filled[`${day}.start`] = this.value("start");
      this.filled[`${day}.end`] = this.value("end");
    }
    this.mode[day] = mode;
  }
}

// ---- the dialog ---------------------------------------------------------------

// errors: form.mjs configFrom's field errors. showAll: after a Save, every
// error shows; before, a field's shows once you leave it. message: a line
// above the buttons (a write that failed, a problem in the file). asking: the
// "Apply tonight?" question replaces it, with its two answers.
export function settingsDialog({ t, mono, form, errors, showAll, message, asking, busy, onToggle, onOnlyWithChip, onNightly, onMode, onSave, onCancel, onAnswer }) {
  const shown = (key) => (errors[key] && (showAll || form.focused !== key) ? errors[key] : null);
  const faint = (text) => div().font_family(mono).text_size(12).text_color(t.dim).child(text);
  const hairline = () => div().h(1).flex_none().bg(t.border);

  const field = (key, w) =>
    Input.new(form.inputs[key])
      .w(w)
      .h(24)
      .px(7)
      .rounded(2)
      .border(1)
      .border_color(form.focused === key ? t.accent : shown(key) ? t.ansi9 : t.border)
      .bg(t.chrome)
      .font_family(mono)
      .text_size(12)
      .text_color(t.foreground);
  const times = (prefix) =>
    h_flex()
      .gap(6)
      .items_center()
      .child(field(`${prefix}start`, 58))
      .child(div().text_size(12).text_color(t.dim).child("→"))
      .child(field(`${prefix}end`, 58));
  // The same hours, faint, where a custom day's fields would be.
  const inherited = () => {
    if (form.nightly === "none") return div().pl(8).child(faint("none"));
    return div().pl(8).child(faint(`${form.value("start").trim() || "--:--"}  →  ${form.value("end").trim() || "--:--"}`));
  };
  const error = (...keys) => {
    const text = keys.map(shown).find(Boolean);
    return div().flex_1().min_w(0).pl(10).truncate().text_size(11.5).text_color(t.ansi9).child(text ?? "");
  };

  // que's segmented control: mono 11px behind a 1px hairline, 2px corners,
  // the chosen one bright on a raised step.
  const segmented = (id, options, value, onPick) =>
    h_flex()
      .flex_none()
      .h(22)
      .rounded(2)
      .border(1)
      .border_color(t.border)
      .overflow_hidden()
      .children(
        options.map(([v, text]) =>
          div()
            .id(`${id}-${v}`)
            .h(20)
            .px(7)
            .flex()
            .items_center()
            .font_family(mono)
            .text_size(11)
            .when(v === value, (el) => el.bg(t.selected).text_color(t.foreground))
            .when(v !== value, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.muted)))
            .on_click((_e, cx) => onPick(v, cx))
            .child(text),
        ),
      );

  const row = (id, name, control, rest, err) =>
    h_flex()
      .id(id)
      .h(30)
      .flex_none()
      .items_center()
      .child(div().w(84).flex_none().text_color(t.muted).child(name))
      .child(div().w(136).flex_none().child(control))
      .child(div().w(150).flex_none().child(rest))
      .child(err);

  const nightly = row(
    "qs-nightly",
    "Every night",
    segmented("qs-nightly", [["hours", "hours"], ["none", "none"]], form.nightly, onNightly),
    form.nightly === "hours" ? times("") : div().pl(8).child(faint("no nightly window")),
    error("start", "end"),
  );
  const days = WEEK.map((d) =>
    row(
      `qs-day-${d}`,
      NAME[d],
      segmented(`qs-${d}`, [["same", "same"], ["off", "off"], ["custom", "custom"]], form.mode[d], (mode, cx) => onMode(d, mode, cx)),
      form.mode[d] === "custom" ? times(`${d}.`) : form.mode[d] === "same" ? inherited() : div(),
      error(`${d}.start`, `${d}.end`),
    ),
  );
  const unlock = h_flex()
    .id("qs-unlock")
    .h(30)
    .flex_none()
    .items_center()
    .child(div().w(84).flex_none().text_color(t.muted).child("Unlock"))
    .child(field("unlock", 48))
    .child(div().pl(8).text_size(12.5).text_color(t.dim).child("minutes"))
    .child(error("unlock"));

  // A switch: a 26×14 track, its knob at the end when on, and its words.
  const switcher = (id, on, onClick, text) =>
    h_flex()
      .id(id)
      .flex_none()
      .h(24)
      .gap(10)
      .items_center()
      .cursor_pointer()
      .on_click(onClick)
      .child(
        h_flex()
          .w(26)
          .h(14)
          .flex_none()
          .px(2)
          .items_center()
          .rounded_full()
          .border(1)
          .border_color(on ? t.muted : t.input)
          .bg(on ? t.selected : t.chrome)
          .when(on, (el) => el.justify_end())
          .child(div().size(8).rounded_full().bg(on ? t.foreground : t.dim)),
      )
      .child(div().text_color(on ? t.foreground : t.muted).child(text));
  const toggle = switcher("qs-enabled", form.enabled, onToggle, form.enabled ? "Quiet hours on" : "Quiet hours off");
  // only_with_chip: the same switch, and under its words, faint, what it does.
  const onlyWithChip = v_flex()
    .flex_none()
    .child(switcher("qs-only-with-chip", form.onlyWithChip, onOnlyWithChip, "Only in layouts with the quiet chip"))
    .child(div().h(16).pl(36).truncate().text_size(12).text_color(t.dim).child("Other layouts are left alone; switching to one during quiet is logged."));

  const button = (id, text, primary, action) =>
    h_flex()
      .id(id)
      .h(26)
      .px(11)
      .items_center()
      .rounded(2)
      .border(1)
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.popover)
      .text_size(12.5)
      .font_medium()
      .text_color(primary ? t.solid_foreground : t.foreground)
      .when(busy, (el) => el.opacity(0.4))
      .when(!busy, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover).border_color(t.input))))
      .on_click((e, cx) => !busy && action(e, cx))
      .child(text);

  const foot = asking
    ? v_flex()
        .flex_none()
        .gap(8)
        .child(
          h_flex()
            .h(18)
            .gap(5)
            .text_size(12.5)
            .child(div().font_semibold().text_color(t.foreground).child("Apply tonight?"))
            .child(div().truncate().text_color(t.muted).child("This ends tonight's quiet hours early.")),
        )
        .child(
          h_flex()
            .justify_end()
            .gap(8)
            .child(button("qs-tomorrow", "No, from tomorrow", false, (_e, cx) => onAnswer(false, cx)))
            .child(button("qs-tonight", "Yes, tonight", false, (_e, cx) => onAnswer(true, cx))),
        )
    : v_flex()
        .flex_none()
        .gap(8)
        .child(div().h(18).truncate().text_size(12).text_color(message?.bad ? t.ansi9 : t.dim).child(message?.text ?? ""))
        .child(
          h_flex()
            .justify_end()
            .gap(8)
            .child(button("qs-cancel", "Cancel", false, onCancel))
            .child(button("qs-save", busy ? "Saving…" : "Save", true, onSave)),
        );

  const body = v_flex()
    .id("quiet-settings")
    .size_full()
    .bg(t.popover)
    .border(1)
    .border_color(t.input)
    .rounded(2)
    .px(20)
    .pt(16)
    .pb(16)
    .text_size(13)
    .text_color(t.foreground)
    .child(
      h_flex()
        .flex_none()
        .h(18)
        .justify_between()
        .items_center()
        .child(div().font_family(mono).text_size(10.5).text_color(secondary(t)).child("QUIET HOURS"))
        .child(div().font_family(mono).text_size(10.5).text_color(t.dim).child("esc")),
    )
    .child(div().h(12).flex_none())
    .child(toggle)
    .child(div().h(10).flex_none())
    .child(hairline())
    .child(div().h(6).flex_none())
    .child(nightly)
    .children(days)
    .child(div().h(6).flex_none())
    .child(hairline())
    .child(div().h(6).flex_none())
    .child(unlock)
    .child(div().h(4).flex_none())
    .child(onlyWithChip)
    .child(div().flex_1().min_h(10))
    .child(hairline())
    .child(div().h(10).flex_none())
    .child(foot);

  // The frame's four corner points sit on its border (que's dialogs).
  const corner = (el) => el.absolute().size(5).bg(t.dim);
  return div()
    .relative()
    .size_full()
    .p(3)
    .child(body)
    .child(corner(div().top(0).left(0)))
    .child(corner(div().top(0).right(0)))
    .child(corner(div().bottom(0).left(0)))
    .child(corner(div().bottom(0).right(0)));
}
