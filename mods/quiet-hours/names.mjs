// What a board row says: who the agent is and which project it works in. Pure functions with no
// imports, so `node --test` runs them; main.js runs git and ui.js draws.
//
// The name is the one a Claude Code session gives itself in its terminal title, from its first
// prompt or /rename: Claude Code writes `✳ <name>` when idle or waiting, `◐ <name>` or
// `◑ <name>` while busy, `Claude Code` until the session has a name, and an empty title on exit.
// These are que's rules (src/shared/session-label.ts, capTitle in src/shared/brief.ts), copied
// from the curfew-sidebar mod's titles.mjs because a mod can't import another mod's files: keep
// the two the same.
//
// The project is the git repository's name: the main checkout's folder, so every worktree of a
// repository shows the repository; outside one, the folder's own name.

/** One status glyph Claude Code puts before the session name, and the whitespace after it. */
const GLYPH = /^[✳◐◑]\s*/u;
/** The title Claude Code shows before the session has been named. */
const PLACEHOLDER = "Claude Code";
/** The longest name, in characters. */
export const MAX_TITLE_CHARS = 80;

/** A one-line title cut to MAX_TITLE_CHARS, ending in `…` when it was longer. */
export function capTitle(line) {
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : line;
}

/** The session name in a raw terminal title; null for an empty title or the placeholder. */
export function sessionLabel(raw) {
  const body = String(raw ?? "").trim().replace(GLYPH, "").trim();
  if (body === "" || body === PLACEHOLDER) return null;
  return capTitle(body);
}

/** A Claude Code agent, as herdr reports it: the agent's own report, else the program. */
export const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";

/** An agent's terminal title as its program set it. herdr gives a terminal with no title its
 *  address instead (`t2c`; on another machine `vps/t2c`), which is no name. */
export function agentTitle(a) {
  const title = a.title ?? "";
  const address = a.address ?? "";
  return title === address || title === address.split("/").pop() ? "" : title;
}

/** A row's name: its Claude Code session's name; else its tab's, when someone named the tab
 *  (`named`, from main.js); else what runs there. */
export function rowName(a) {
  return (isClaude(a) && sessionLabel(agentTitle(a))) || (a.named ? a.tab_name : a.program?.name || a.tab_name || `tab ${a.tab_index}`);
}

/** git's arguments for the repository a folder is in: read-only and light (no optional locks, no
 *  fsmonitor). The answer is the shared git folder as an absolute path, which for a linked
 *  worktree is its main checkout's `.git`. */
export const commonDirArgs = (folder) => ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"];

const lastPart = (path) => path.split("/").pop();

/** The repository's name from git's answer to commonDirArgs: the folder holding `.git` (the main
 *  checkout), or a bare repository's own name without `.git`. null for no usable answer (none, or
 *  a relative path from a git too old for --path-format). */
export function repoName(commonDir) {
  const dir = String(commonDir ?? "").trim().split("\n").pop().trim().replace(/\/+$/, "");
  if (!dir.startsWith("/")) return null;
  return (dir.endsWith("/.git") ? lastPart(dir.slice(0, -5)) : lastPart(dir).replace(/\.git$/, "")) || null;
}

/** A folder's own name; `~` for the home folder, and for no folder (herdr's empty folder is the
 *  home). `home`: null when unknown (a space on another machine). */
export function folderName(folder, home) {
  const trim = (path) => String(path ?? "").replace(/(.)\/+$/, "$1");
  const f = trim(folder);
  if (f === "" || (home && f === trim(home))) return "~";
  return lastPart(f) || f;
}

/** An agent folder's project: the repository's name from git's answer (null when git failed),
 *  else the folder's name. */
export function projectName(folder, commonDir, home) {
  return repoName(commonDir) ?? folderName(folder, home);
}
