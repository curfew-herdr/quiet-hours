// node --test ~/.config/herdr-app/mods/quiet-hours/names.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionLabel, capTitle, agentTitle, rowName, commonDirArgs, repoName, folderName, projectName, MAX_TITLE_CHARS } from "./names.mjs";

const HOME = "/home/me";
const claude = (fields) => ({ address: "t2p", app: "claude-code", program: { key: "claude", name: "Claude Code" }, tab_name: "Claude Code", tab_index: 1, named: false, ...fields });

test("a session's name is its title without one leading status glyph, trimmed", () => {
  assert.equal(sessionLabel("✳ Small bug hunt"), "Small bug hunt");
  assert.equal(sessionLabel("◐ Fix the cart total"), "Fix the cart total");
  assert.equal(sessionLabel("◑  Fix the cart total "), "Fix the cart total");
  assert.equal(sessionLabel("Small bug hunt"), "Small bug hunt");
  // Only one leading glyph is a status.
  assert.equal(sessionLabel("✳ ✳ stars"), "✳ stars");
});

test("the placeholder and an empty title give no name", () => {
  assert.equal(sessionLabel("Claude Code"), null);
  assert.equal(sessionLabel("✳ Claude Code"), null);
  assert.equal(sessionLabel(""), null);
  assert.equal(sessionLabel("  ✳  "), null);
  assert.equal(sessionLabel(undefined), null);
  assert.equal(sessionLabel(null), null);
});

test("a long name is cut to 80 characters, ending in an ellipsis", () => {
  assert.equal(MAX_TITLE_CHARS, 80);
  const long = sessionLabel(`✳ ${"x".repeat(100)}`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
  assert.equal(capTitle("y".repeat(80)), "y".repeat(80));
  // The cut doesn't leave a space before the ellipsis.
  assert.equal(capTitle(`${"x".repeat(78)} yyyy`), `${"x".repeat(78)}…`);
});

test("a terminal with no title, which herdr reports as its address, has no name", () => {
  assert.equal(agentTitle({ address: "t2c", title: "t2c" }), "");
  assert.equal(agentTitle({ address: "vps/t2c", title: "t2c" }), "");
  assert.equal(agentTitle({ address: "vps/t2c", title: "vps/t2c" }), "");
  assert.equal(agentTitle({ address: "t2c" }), "");
  assert.equal(agentTitle({ address: "t2c", title: "✳ Small bug hunt" }), "✳ Small bug hunt");
});

test("a row is named after its Claude Code session, else its named tab, its program, its tab", () => {
  assert.equal(rowName(claude({ title: "✳ Small bug hunt" })), "Small bug hunt");
  // The session's name comes before a tab someone named.
  assert.equal(rowName(claude({ title: "◐ Small bug hunt", named: true, tab_name: "fix login" })), "Small bug hunt");
  assert.equal(rowName(claude({ title: "Claude Code", named: true, tab_name: "fix login" })), "fix login");
  assert.equal(rowName(claude({ title: "" })), "Claude Code");
  assert.equal(rowName(claude({ address: "t2c", title: "t2c", tab_name: "1" })), "Claude Code");
  // Known by its program alone.
  assert.equal(rowName(claude({ app: null, title: "✳ Small bug hunt" })), "Small bug hunt");
  // Another agent's title isn't a session name.
  assert.equal(rowName({ address: "t3", app: "codex", program: { key: "codex", name: "Codex" }, title: "✳ Something", tab_name: "2", tab_index: 2, named: false }), "Codex");
  assert.equal(rowName({ address: "t4", app: "pi", program: null, title: "", tab_name: "3", tab_index: 3, named: false }), "3");
  assert.equal(rowName({ address: "t5", app: "pi", title: "", tab_name: "", tab_index: 4, named: false }), "tab 4");
});

test("the project is the main checkout's folder name, for a linked worktree too", () => {
  assert.equal(repoName("/home/me/src/uploader/.git\n"), "uploader");
  assert.equal(repoName("/home/me/src/uploader/.git/"), "uploader");
  // A bare repository: its name without .git.
  assert.equal(repoName("/srv/git/uploader.git"), "uploader");
  // A submodule's git folder is named after it.
  assert.equal(repoName("/home/me/src/app/.git/modules/vendor-lib"), "vendor-lib");
  // Nothing usable: no answer, or a relative one from a git without --path-format.
  assert.equal(repoName(""), null);
  assert.equal(repoName(null), null);
  assert.equal(repoName("--path-format=absolute\n.git\n"), null);
});

test("outside a repository the project is the folder's name, ~ for the home folder", () => {
  assert.equal(folderName("/home/me/notes", HOME), "notes");
  assert.equal(folderName("/home/me/notes/", HOME), "notes");
  assert.equal(folderName("/home/me", HOME), "~");
  assert.equal(folderName("/home/me/", HOME), "~");
  // herdr's empty folder is the home.
  assert.equal(folderName("", HOME), "~");
  assert.equal(folderName("/", HOME), "/");
  // On another machine the home isn't known.
  assert.equal(folderName("/home/me", null), "me");
  assert.equal(projectName("/home/me/.herdr/worktrees/uploader/zesty-bold-turnip", "/home/me/src/uploader/.git\n", HOME), "uploader");
  // git failed: the folder's name.
  assert.equal(projectName("/home/me/.herdr/worktrees/uploader/zesty-bold-turnip", null, HOME), "zesty-bold-turnip");
  assert.equal(projectName(HOME, null, HOME), "~");
});

test("against a real repository: its worktrees and subfolders are its project", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qh-names-")));
  // No global or system config (hooks, signing), and no repository above the temp folder.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: base };
  const git = (...args) => execFileSync("git", args, { cwd: base, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // What the board does: git's answer, or null when git fails.
  const project = (folder) => {
    let out = null;
    try {
      out = git(...commonDirArgs(folder));
    } catch {}
    return projectName(folder, out, base);
  };
  try {
    const repo = path.join(base, "src", "uploader");
    const tree = path.join(base, "worktrees", "uploader", "app-142-retry");
    const notes = path.join(base, "notes");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(notes);
    git("-c", "init.defaultBranch=main", "init", "-q", repo);
    git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "first");
    git("-C", repo, "worktree", "add", "-q", "-b", "app-142-retry", tree);
    fs.mkdirSync(path.join(repo, "lib"));
    fs.mkdirSync(path.join(tree, "src"));

    assert.equal(project(repo), "uploader");
    assert.equal(project(path.join(repo, "lib")), "uploader");
    assert.equal(project(tree), "uploader");
    assert.equal(project(path.join(tree, "src")), "uploader");
    assert.equal(project(notes), "notes");
    assert.equal(project(base), "~");
    assert.equal(project(path.join(base, "gone")), "gone");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
