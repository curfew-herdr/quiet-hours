// The settings dialog's form as plain values, to and from config.json. Pure:
// node tests it, and the mod imports it as is. Every rule is clock.mjs's, the
// watcher's own: times through parseHM, the whole config through
// validateConfig, so the dialog can't write what the watcher would refuse.

import { DAYS, DEFAULT_CONFIG, parseHM, formatHM, validateConfig, UNLOCK_MIN, UNLOCK_MAX } from "./clock.mjs";

// Monday first, as people read a week (que's order).
export const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const TIME_ERROR = "use HH:MM";
export const UNLOCK_ERROR = `${UNLOCK_MIN} to ${UNLOCK_MAX}`;

// A form: { enabled, nightly: "hours" | "none", start, end,
//   days: { mon: { mode: "same" | "off" | "custom", start, end }, ... }, unlock: "10" }.
// A day that isn't custom carries the nightly hours, so switching it to
// custom starts from them.
export function formFrom(config) {
  const hours = config.default === "none" ? null : config.default;
  const [start, end] = hours ?? DEFAULT_CONFIG.default;
  const days = {};
  for (const d of DAYS) {
    const o = config.days?.[d];
    days[d] = o === undefined ? { mode: "same", start, end } : o === "none" ? { mode: "off", start, end } : { mode: "custom", start: o[0], end: o[1] };
  }
  return { enabled: config.enabled, nightly: hours ? "hours" : "none", start, end, days, unlock: String(config.unlock_minutes) };
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// What's wrong, field by field ({start, end, "mon.start", ..., unlock}), and
// with nothing wrong the config to save: `base` (config.json as read) with
// the form's fields over it, so keys the dialog doesn't edit (return_layout,
// anything else) stay where they were. `raw` is what to write; `config` is
// it validated. A problem only the whole config has (a bad return_layout in
// the file) comes back as `error`.
export function configFrom(form, base) {
  const errors = {};
  const time = (key, text) => {
    const t = parseHM(text);
    if (!t) errors[key] = TIME_ERROR;
    return t ? formatHM(t) : null;
  };
  const pair = (prefix, day) => [time(`${prefix}start`, day.start), time(`${prefix}end`, day.end)];

  const def = form.nightly === "none" ? "none" : pair("", form);
  const days = {};
  for (const d of DAYS) {
    const day = form.days[d];
    if (day.mode === "off") days[d] = "none";
    else if (day.mode === "custom") days[d] = pair(`${d}.`, day);
  }
  const minutes = /^\s*\d+\s*$/.test(form.unlock) ? Number(form.unlock) : NaN;
  try {
    validateConfig({ unlock_minutes: minutes });
  } catch {
    errors.unlock = UNLOCK_ERROR;
  }
  if (Object.keys(errors).length) return { errors, error: null, raw: null, config: null };

  const raw = { ...(isObject(base) ? base : {}), enabled: form.enabled, default: def, days, unlock_minutes: minutes };
  try {
    return { errors, error: null, raw, config: validateConfig(raw) };
  } catch (e) {
    return { errors, error: e.message, raw: null, config: null };
  }
}

// config.json's text: 2-space JSON and a final newline, as the file is kept.
export const configText = (raw) => `${JSON.stringify(raw, null, 2)}\n`;
