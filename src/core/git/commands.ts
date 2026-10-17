// Command parser + implementations. `exec` takes a state and a command line and returns a new state.
import type { ExecResult, Line, LineKind, RepoState, Tree } from "./types";
import {
  AUTHOR,
  GitError,
  checkoutTree,
  createCommit,
  currentBranch,
  diffTrees,
  firstLine,
  headId,
  headTree,
  isAncestor,
  mergeBase,
  moveHead,
  requireClean,
  resolve,
  switchTree,
  threeWay,
  treeOf,
  treesEqual,
  tryResolve,
  untrackedPaths,
} from "./repo";

const REPO_PATH = "/dungeon/repo";

export const GIT_SUBCOMMANDS = ["init", "status", "add", "commit", "log", "branch", "switch", "checkout", "merge", "diff", "help"];
export const SHELL_COMMANDS = ["git", "echo", "cat", "ls", "touch", "rm", "clear", "help"];

/** Split a command line into tokens, honouring quotes and treating > / >> / && as their own tokens. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  const push = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      push();
    } else if (ch === ">" || (ch === "&" && input[i + 1] === "&")) {
      push();
      const op = input[i + 1] === ch ? ch + ch : ch;
      i += op.length - 1;
      tokens.push(op);
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new GitError("shell: unterminated quote");
  push();
  return tokens;
}

interface Parsed {
  flags: Record<string, string | true>;
  pos: string[];
}

/** Minimal getopt: `bool` flags take no value, `value` flags consume the next token. Short flags may be combined (-am). */
function parseArgs(args: string[], bool: string[], value: string[] = []): Parsed {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const [k, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
      if (!value.includes(k)) throw new GitError(`error: unknown option '${a.slice(2)}'`);
      flags[k] = v;
    } else if (value.includes(a)) {
      if (i + 1 >= args.length) throw new GitError(`error: option '${a.replace(/^-+/, "")}' requires a value`);
      flags[a] = args[++i];
    } else if (bool.includes(a)) {
      flags[a] = true;
    } else if (/^-[a-zA-Z]{2,}$/.test(a)) {
      const letters = a.slice(1).split("");
      letters.forEach((l, idx) => {
        const f = `-${l}`;
        if (value.includes(f) && idx === letters.length - 1) {
          if (i + 1 >= args.length) throw new GitError(`error: switch '${l}' requires a value`);
          flags[f] = args[++i];
        } else if (bool.includes(f)) flags[f] = true;
        else throw new GitError(`error: unknown switch '${l}'`);
      });
    } else if (a.startsWith("-") && a.length > 1) {
      throw new GitError(`error: unknown option '${a.replace(/^-+/, "")}'`);
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

class Out {
  lines: Line[] = [];
  add(text: string, kind: LineKind = "out") {
    for (const t of text.split("\n")) this.lines.push({ text: t, kind });
  }
}

// ---------------------------------------------------------------------------
// git subcommands
// ---------------------------------------------------------------------------

function decorations(s: RepoState, id: string): string {
  const refs: string[] = [];
  const branch = currentBranch(s);
  if (headId(s) === id) refs.push(branch ? `HEAD -> ${branch}` : "HEAD");
  for (const [name, target] of Object.entries(s.branches)) if (target === id && name !== branch) refs.push(name);
  if (branch && s.branches[branch] === id && headId(s) !== id) refs.push(branch);
  for (const [name, target] of Object.entries(s.tags)) if (target === id) refs.push(`tag: ${name}`);
  return refs.length ? ` (${refs.join(", ")})` : "";
}

function cmdStatus(s: RepoState, out: Out) {
  const branch = currentBranch(s);
  const hid = headId(s);
  out.add(branch ? `On branch ${branch}` : `HEAD detached at ${hid}`);
  if (!hid) out.add("\nNo commits yet");

  const ht = headTree(s);
  const all = [...new Set([...Object.keys(ht), ...Object.keys(s.index)])].sort();
  const staged = all.filter((p) => s.index[p] !== ht[p]);
  const unstaged = Object.keys(s.index)
    .sort()
    .filter((p) => s.work[p] !== s.index[p]);
  const untracked = untrackedPaths(s);

  const label = (p: string, from: Tree, to: Tree) =>
    from[p] === undefined ? `new file:   ${p}` : to[p] === undefined ? `deleted:    ${p}` : `modified:   ${p}`;

  if (staged.length) {
    out.add("\nChanges to be committed:");
    out.add('  (use "git restore --staged <file>..." to unstage)', "hint");
    for (const p of staged) out.add(`\t${label(p, ht, s.index)}`, "ok");
  }
  if (unstaged.length) {
    out.add("\nChanges not staged for commit:");
    out.add('  (use "git add <file>..." to update what will be committed)', "hint");
    for (const p of unstaged) out.add(`\t${label(p, s.index, s.work)}`, "err");
  }
  if (untracked.length) {
    out.add("\nUntracked files:");
    out.add('  (use "git add <file>..." to include in what will be committed)', "hint");
    for (const p of untracked) out.add(`\t${p}`, "err");
  }
  if (!staged.length && !unstaged.length) {
    if (untracked.length) out.add('\nnothing added to commit but untracked files present (use "git add" to track)');
    else if (!hid) out.add('\nnothing to commit (create/copy files and use "git add" to track)');
    else out.add("\nnothing to commit, working tree clean");
  }
}

function cmdAdd(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["-A", "--all", "-u"]);
  const all = flags["-A"] || flags["--all"] || pos.includes(".");
  if (!all && !pos.length) {
    out.add("Nothing specified, nothing added.", "hint");
    out.add("hint: Maybe you wanted to say 'git add .'?", "hint");
    return;
  }
  const paths = all ? [...new Set([...Object.keys(s.work), ...Object.keys(s.index)])] : pos;
  for (const p of paths) {
    if (p in s.work) s.index[p] = s.work[p];
    else if (p in s.index) delete s.index[p];
    else throw new GitError(`fatal: pathspec '${p}' did not match any files`);
  }
}

function cmdCommit(s: RepoState, args: string[], out: Out) {
  const { flags } = parseArgs(args, ["-a", "--all", "--amend", "--allow-empty", "--no-edit"], ["-m", "--message"]);
  const message = (flags["-m"] ?? flags["--message"]) as string | undefined;
  const amend = !!flags["--amend"];
  const hid = headId(s);

  if (flags["-a"] || flags["--all"]) {
    for (const p of Object.keys(s.index)) {
      if (p in s.work) s.index[p] = s.work[p];
      else delete s.index[p];
    }
  }
  if (amend && !hid) throw new GitError("fatal: You have nothing to amend.");
  if (!amend && hid && treesEqual(s.index, headTree(s)) && !flags["--allow-empty"]) {
    const dirty = untrackedPaths(s).length || Object.keys(s.index).some((p) => s.work[p] !== s.index[p]);
    throw new GitError(
      dirty
        ? 'no changes added to commit (use "git add" and/or "git commit -a")'
        : "nothing to commit, working tree clean",
    );
  }
  if (!hid && !Object.keys(s.index).length) {
    throw new GitError('nothing to commit (create/copy files and use "git add" to track)');
  }
  const msg = message ?? (amend ? s.commits[hid!].message : undefined);
  if (!msg || !msg.trim()) throw new GitError('Aborting commit due to empty commit message.\nhint: use  git commit -m "your message"');

  const parents = amend ? s.commits[hid!].parents : hid ? [hid] : [];
  const c = createCommit(s, parents, msg.trim(), s.index);
  moveHead(s, c.id, `commit${amend ? " (amend)" : parents.length ? "" : " (initial)"}: ${firstLine(c.message)}`);

  const ht = treeOf(s, parents[0]);
  const changed = [...new Set([...Object.keys(ht), ...Object.keys(c.tree)])].filter((p) => ht[p] !== c.tree[p]);
  const branch = currentBranch(s) ?? "detached HEAD";
  out.add(`[${branch}${parents.length ? "" : " (root-commit)"} ${c.id}] ${firstLine(c.message)}`, "ok");
  out.add(` ${changed.length} file${changed.length === 1 ? "" : "s"} changed`);
}

function cmdLog(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["--oneline", "--all", "--graph", "--decorate"], ["-n", "--max-count"]);
  const starts = flags["--all"]
    ? [...Object.values(s.branches), ...Object.values(s.tags), headId(s)].filter((x): x is string => !!x)
    : [pos.length ? resolve(s, pos[0]) : headId(s)].filter((x): x is string => !!x);
  if (!starts.length) {
    const b = currentBranch(s) ?? "HEAD";
    throw new GitError(`fatal: your current branch '${b}' does not have any commits yet`);
  }
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...s.commits[id].parents);
  }
  let commits = [...seen].map((id) => s.commits[id]).sort((a, b) => b.seq - a.seq);
  const limit = flags["-n"] ?? flags["--max-count"];
  if (typeof limit === "string") commits = commits.slice(0, Number(limit));

  for (const c of commits) {
    if (flags["--oneline"]) {
      out.lines.push({ text: `${c.id}${decorations(s, c.id)} ${firstLine(c.message)}`, kind: "info" });
    } else {
      out.add(`commit ${c.id}${decorations(s, c.id)}`, "info");
      if (c.parents.length > 1) out.add(`Merge: ${c.parents.join(" ")}`);
      out.add(`Author: ${AUTHOR}\n`);
      out.add(c.message.split("\n").map((l) => `    ${l}`).join("\n"));
      out.add("");
    }
  }
}

function validBranchName(name: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.endsWith("/") || name.includes(".."))
    throw new GitError(`fatal: '${name}' is not a valid branch name`);
}

function createBranch(s: RepoState, name: string, start: string | undefined, force = false) {
  validBranchName(name);
  if (s.branches[name] && !force) throw new GitError(`fatal: a branch named '${name}' already exists`);
  const target = start ? resolve(s, start) : headId(s);
  if (!target) throw new GitError(`fatal: not a valid object name: '${currentBranch(s) ?? "HEAD"}'`);
  s.branches[name] = target;
}

function cmdBranch(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["-d", "-D", "--delete", "-a", "-v", "--list", "-f", "-m", "-M"]);
  if (flags["-d"] || flags["-D"] || flags["--delete"]) {
    if (!pos.length) throw new GitError("fatal: branch name required");
    for (const name of pos) {
      if (!s.branches[name]) throw new GitError(`error: branch '${name}' not found.`);
      if (currentBranch(s) === name)
        throw new GitError(`error: Cannot delete branch '${name}' checked out at '${REPO_PATH}'`);
      const hid = headId(s);
      if (!flags["-D"] && (!hid || !isAncestor(s, s.branches[name], hid)))
        throw new GitError(
          `error: The branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'.`,
        );
      out.add(`Deleted branch ${name} (was ${s.branches[name]}).`);
      delete s.branches[name];
    }
    return;
  }
  if (flags["-m"] || flags["-M"]) {
    const [from, to] = pos.length === 1 ? [currentBranch(s), pos[0]] : pos;
    if (!from || !to || !s.branches[from]) throw new GitError("fatal: no branch to rename");
    validBranchName(to);
    if (s.branches[to] && !flags["-M"]) throw new GitError(`fatal: a branch named '${to}' already exists`);
    s.branches[to] = s.branches[from];
    delete s.branches[from];
    if (currentBranch(s) === from) s.head = { type: "branch", name: to };
    return;
  }
  if (!pos.length || flags["--list"]) {
    const names = Object.keys(s.branches).sort();
    if (s.head.type === "detached") out.add(`* (HEAD detached at ${s.head.id})`, "ok");
    for (const n of names) {
      const cur = currentBranch(s) === n;
      const extra = flags["-v"] ? ` ${s.branches[n]} ${firstLine(s.commits[s.branches[n]].message)}` : "";
      out.lines.push({ text: `${cur ? "*" : " "} ${n}${extra}`, kind: cur ? "ok" : "out" });
    }
    return;
  }
  createBranch(s, pos[0], pos[1], !!flags["-f"]);
}

function switchToBranch(s: RepoState, name: string, out: Out) {
  if (currentBranch(s) === name) {
    out.add(`Already on '${name}'`);
    return;
  }
  const from = currentBranch(s) ?? headId(s) ?? "HEAD";
  switchTree(s, treeOf(s, s.branches[name]));
  s.head = { type: "branch", name };
  s.reflog.push({ id: s.branches[name], message: `checkout: moving from ${from} to ${name}` });
  out.add(`Switched to branch '${name}'`);
}

function detachAt(s: RepoState, rev: string, id: string, out: Out) {
  const from = currentBranch(s) ?? headId(s) ?? "HEAD";
  switchTree(s, treeOf(s, id));
  s.head = { type: "detached", id };
  s.reflog.push({ id, message: `checkout: moving from ${from} to ${rev}` });
  out.add(`Note: switching to '${rev}'.\n\nYou are in 'detached HEAD' state. Commits you make here belong to no branch.`, "hint");
  out.add(`HEAD is now at ${id} ${firstLine(s.commits[id].message)}`);
}

function cmdSwitch(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["--detach", "-d"], ["-c", "--create", "-C"]);
  const create = (flags["-c"] ?? flags["--create"] ?? flags["-C"]) as string | undefined;
  if (create) {
    createBranch(s, create, pos[0], !!flags["-C"]);
    switchToBranch(s, create, out);
    out.lines[out.lines.length - 1].text = `Switched to a new branch '${create}'`;
    return;
  }
  if (!pos.length) throw new GitError("fatal: missing branch or commit argument");
  if (flags["--detach"] || flags["-d"]) return detachAt(s, pos[0], resolve(s, pos[0]), out);
  if (!s.branches[pos[0]]) {
    if (tryResolve(s, pos[0])) throw new GitError(`fatal: a branch is expected, got '${pos[0]}'\nhint: use 'git switch --detach ${pos[0]}'`);
    throw new GitError(`fatal: invalid reference: ${pos[0]}`);
  }
  switchToBranch(s, pos[0], out);
}

function cmdCheckout(s: RepoState, args: string[], out: Out) {
  const dashdash = args.indexOf("--");
  const { flags, pos } = parseArgs(dashdash >= 0 ? args.slice(0, dashdash) : args, ["-f"], ["-b", "-B"]);
  const files = dashdash >= 0 ? args.slice(dashdash + 1) : [];
  const create = (flags["-b"] ?? flags["-B"]) as string | undefined;
  if (create) {
    createBranch(s, create, pos[0], !!flags["-B"]);
    switchToBranch(s, create, out);
    out.lines[out.lines.length - 1].text = `Switched to a new branch '${create}'`;
    return;
  }
  const restore = (paths: string[]) => {
    for (const p of paths) {
      if (!(p in s.index)) throw new GitError(`error: pathspec '${p}' did not match any file(s) known to git`);
      s.work[p] = s.index[p];
    }
    out.add(`Updated ${paths.length} path${paths.length === 1 ? "" : "s"} from the index`);
  };
  if (files.length) return restore(files);
  if (!pos.length) throw new GitError("fatal: you must specify a branch to checkout");
  const target = pos[0];
  if (s.branches[target]) return switchToBranch(s, target, out);
  const id = tryResolve(s, target);
  if (id) return detachAt(s, target, id, out);
  if (pos.every((p) => p in s.index)) return restore(pos);
  throw new GitError(`error: pathspec '${target}' did not match any file(s) known to git`);
}

function cmdMerge(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["--no-ff", "--ff-only", "--no-edit"], ["-m"]);
  if (!pos.length) throw new GitError("fatal: No remote for the current branch.\nhint: try 'git merge <branch>'");
  const ours = headId(s);
  const theirs = resolve(s, pos[0]);
  if (!ours) throw new GitError("fatal: cannot merge into an empty branch yet (make a commit first)");
  if (isAncestor(s, theirs, ours)) {
    out.add("Already up to date.");
    return;
  }
  if (isAncestor(s, ours, theirs) && !flags["--no-ff"]) {
    switchTree(s, treeOf(s, theirs));
    moveHead(s, theirs, `merge ${pos[0]}: Fast-forward`);
    out.add(`Updating ${ours}..${theirs}\nFast-forward`, "ok");
    return;
  }
  if (flags["--ff-only"]) throw new GitError("fatal: Not possible to fast-forward, aborting.");
  requireClean(s, "merge");

  const base = mergeBase(s, ours, theirs);
  const r = threeWay(treeOf(s, base), treeOf(s, ours), treeOf(s, theirs), "HEAD", pos[0]);
  if (r.conflicts.length) {
    for (const p of r.conflicts) out.add(`CONFLICT (content): Merge conflict in ${p}`, "err");
    throw new GitError(
      "Automatic merge failed.\nGit Quest note: resolving conflicts unlocks in a later world — merge aborted.",
    );
  }
  const branch = currentBranch(s);
  const defaultMsg = `Merge branch '${pos[0]}'${branch && branch !== "main" ? ` into ${branch}` : ""}`;
  const c = createCommit(s, [ours, theirs], ((flags["-m"] as string) ?? defaultMsg).trim(), r.tree);
  moveHead(s, c.id, `merge ${pos[0]}: Merge made by the 'ort' strategy.`);
  checkoutTree(s, c.tree);
  out.add("Merge made by the 'ort' strategy.", "ok");
}

function cmdDiff(s: RepoState, args: string[], out: Out) {
  const { flags, pos } = parseArgs(args, ["--staged", "--cached"]);
  let lines: string[];
  if (flags["--staged"] || flags["--cached"]) lines = diffTrees(headTree(s), s.index);
  else if (pos.length >= 2) lines = diffTrees(treeOf(s, resolve(s, pos[0])), treeOf(s, resolve(s, pos[1])));
  else if (pos.length === 1) lines = diffTrees(treeOf(s, resolve(s, pos[0])), s.work, (p) => p in s.index);
  else lines = diffTrees(s.index, s.work, (p) => p in s.index);
  for (const l of lines) {
    const kind: LineKind = l.startsWith("diff") || l.startsWith("---") || l.startsWith("+++") ? "info"
      : l.startsWith("+") ? "ok" : l.startsWith("-") ? "err" : "out";
    out.lines.push({ text: l, kind });
  }
}

function gitHelp(out: Out) {
  out.add("Git Quest supports these commands:", "info");
  out.add(
    [
      "  git init                      create a repository",
      "  git status                    show what changed",
      "  git add <file> | .            stage changes",
      '  git commit -m "msg" [-a]      record staged changes',
      "  git log [--oneline] [--all]   show history",
      "  git diff [--staged]           show changes",
      "  git branch [name] [-d name]   list / create / delete branches",
      "  git switch [-c] <branch>      change branch (-c creates it)",
      "  git checkout [-b] <branch>    classic version of switch",
      "  git merge <branch> [--no-ff]  merge a branch into the current one",
    ].join("\n"),
  );
  out.add("Shell: ls, cat <file>, echo \"text\" > file, echo \"text\" >> file, touch, rm, clear", "hint");
}

function runGit(s: RepoState, args: string[], out: Out) {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") return gitHelp(out);
  if (sub === "--version" || sub === "version") return out.add("git version 2.47.0 (git-quest)");
  if (sub === "init") {
    if (s.initialized) out.add(`Reinitialized existing Git repository in ${REPO_PATH}/.git/`);
    else {
      s.initialized = true;
      out.add(`Initialized empty Git repository in ${REPO_PATH}/.git/`, "ok");
    }
    return;
  }
  if (!s.initialized) throw new GitError("fatal: not a git repository (or any of the parent directories): .git");
  switch (sub) {
    case "status":
      return cmdStatus(s, out);
    case "add":
      return cmdAdd(s, rest, out);
    case "commit":
      return cmdCommit(s, rest, out);
    case "log":
      return cmdLog(s, rest, out);
    case "branch":
      return cmdBranch(s, rest, out);
    case "switch":
      return cmdSwitch(s, rest, out);
    case "checkout":
      return cmdCheckout(s, rest, out);
    case "merge":
      return cmdMerge(s, rest, out);
    case "diff":
      return cmdDiff(s, rest, out);
    case "config":
      return;
    case "rebase":
    case "reset":
    case "revert":
    case "cherry-pick":
    case "stash":
    case "restore":
    case "reflog":
    case "tag":
    case "push":
    case "pull":
    case "fetch":
      throw new GitError(`git-quest: 'git ${sub}' is locked — it unlocks in a later world.`);
    default:
      throw new GitError(`git: '${sub}' is not a git command. See 'git help'.`);
  }
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

function runShell(s: RepoState, tokens: string[], out: Out, res: { clear?: boolean }) {
  const [cmd, ...args] = tokens;
  switch (cmd) {
    case "git":
      return runGit(s, args, out);
    case "clear":
      res.clear = true;
      return;
    case "help":
      return gitHelp(out);
    case "ls":
      out.add(Object.keys(s.work).sort().join("  ") || "(empty)");
      return;
    case "pwd":
      return out.add(REPO_PATH);
    case "cat":
      if (!args.length) throw new GitError("cat: missing file operand");
      for (const p of args) {
        if (!(p in s.work)) throw new GitError(`cat: ${p}: No such file or directory`);
        out.add(s.work[p].replace(/\n$/, ""));
      }
      return;
    case "touch":
      for (const p of args) if (!(p in s.work)) s.work[p] = "";
      return;
    case "rm":
      for (const p of args.filter((a) => !a.startsWith("-"))) {
        if (!(p in s.work)) throw new GitError(`rm: cannot remove '${p}': No such file or directory`);
        delete s.work[p];
      }
      return;
    case "echo": {
      const redirect = args.findIndex((a) => a === ">" || a === ">>");
      const text = (redirect >= 0 ? args.slice(0, redirect) : args).join(" ");
      if (redirect < 0) return out.add(text);
      const file = args[redirect + 1];
      if (!file) throw new GitError("shell: syntax error near unexpected token `newline'");
      s.work[file] = (args[redirect] === ">>" ? (s.work[file] ?? "") : "") + `${text}\n`;
      return;
    }
    case "cd":
      throw new GitError("cd: the dungeon doors are sealed — stay in the repo 🙂");
    default:
      throw new GitError(`${cmd}: command not found`);
  }
}

/** Run one command line (possibly several commands joined by &&) against a state. */
export function exec(state: RepoState, input: string): ExecResult {
  const out = new Out();
  const res: { clear?: boolean } = {};
  let s = structuredClone(state);
  let failed = false;
  try {
    const tokens = tokenize(input);
    const segments: string[][] = [[]];
    for (const t of tokens) {
      if (t === "&&") segments.push([]);
      else segments[segments.length - 1].push(t);
    }
    for (const seg of segments) {
      if (!seg.length) continue;
      const snapshot = structuredClone(s);
      try {
        runShell(s, seg, out, res);
      } catch (e) {
        s = snapshot;
        throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    out.add(e.message, "err");
    failed = true;
  }
  const changed = JSON.stringify(s) !== JSON.stringify(state);
  return { state: changed ? s : state, lines: out.lines, changed, failed, clear: res.clear };
}

/** Build a state by running a list of commands from an empty repo. */
export function runScript(start: RepoState, commands: string[]): RepoState {
  let s = start;
  for (const c of commands) {
    const r = exec(s, c);
    if (r.failed) throw new Error(`script command failed: ${c}\n${r.lines.map((l) => l.text).join("\n")}`);
    s = r.state;
  }
  return s;
}
