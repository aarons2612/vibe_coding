// Goal validation: compares repo *shape* (graph, refs, file contents) — never raw hashes.
import type { RepoState, Tree } from "./types";
import { hashString } from "./repo";

export interface MatchOptions {
  /** compare commit messages (case-insensitive). Default true. */
  messages?: boolean;
  /** compare the staging area + working directory too. Default false. */
  workdir?: boolean;
}

const normContent = (c: string) => c.replace(/\r\n/g, "\n").trimEnd();
const treeKey = (t: Tree) =>
  Object.keys(t)
    .sort()
    .map((p) => `${p}=${normContent(t[p])}`)
    .join("\u0000");

function canonicalizer(s: RepoState, opts: MatchOptions) {
  const memo = new Map<string, string>();
  const canon = (id: string): string => {
    const hit = memo.get(id);
    if (hit) return hit;
    const c = s.commits[id];
    const msg = opts.messages === false ? "" : c.message.trim().toLowerCase();
    const key = hashString(`${c.parents.map(canon).join(",")}|${msg}|${treeKey(c.tree)}`);
    memo.set(id, key);
    return key;
  };
  return canon;
}

export interface Check {
  label: string;
  ok: boolean;
}

/** Itemised comparison of the current state against the target state. */
export function compareStates(current: RepoState, target: RepoState, opts: MatchOptions = {}): Check[] {
  const cc = canonicalizer(current, opts);
  const tc = canonicalizer(target, opts);
  const checks: Check[] = [];

  if (target.initialized) checks.push({ label: "Repository initialized", ok: current.initialized });

  for (const name of Object.keys(target.branches).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))) {
    const cur = current.branches[name];
    checks.push({
      label: `Branch '${name}' matches the target`,
      ok: !!cur && cc(cur) === tc(target.branches[name]),
    });
  }
  const extra = Object.keys(current.branches).filter((b) => !(b in target.branches));
  if (extra.length) checks.push({ label: `No extra branches (remove: ${extra.join(", ")})`, ok: false });

  const headLabel =
    target.head.type === "branch" ? `HEAD is on '${target.head.name}'` : "HEAD is detached at the right commit";
  const headOk =
    target.head.type === "branch"
      ? current.head.type === "branch" && current.head.name === target.head.name
      : current.head.type === "detached" && cc(current.head.id) === tc(target.head.id);
  checks.push({ label: headLabel, ok: headOk });

  if (opts.workdir) {
    checks.push({
      label: "Staging area & working files match",
      ok: treeKey(current.index) === treeKey(target.index) && treeKey(current.work) === treeKey(target.work),
    });
  }
  return checks;
}

export const isSolved = (current: RepoState, target: RepoState, opts?: MatchOptions) =>
  compareStates(current, target, opts).every((c) => c.ok);
