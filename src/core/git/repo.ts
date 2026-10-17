// Low-level repository helpers: hashing, ref resolution, ancestry, trees and diffs.
import type { Commit, RepoState, Tree } from "./types";

export class GitError extends Error {}

export const AUTHOR = "Hero <hero@gitquest.dev>";

export function emptyRepo(): RepoState {
  return {
    initialized: false,
    commits: {},
    branches: {},
    tags: {},
    head: { type: "branch", name: "main" },
    index: {},
    work: {},
    reflog: [],
    stash: [],
    op: null,
    seq: 0,
  };
}

/** cyrb53 string hash -> hex */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export const firstLine = (msg: string) => msg.split("\n")[0];

export function headId(s: RepoState): string | null {
  return s.head.type === "branch" ? (s.branches[s.head.name] ?? null) : s.head.id;
}

export function currentBranch(s: RepoState): string | null {
  return s.head.type === "branch" ? s.head.name : null;
}

export function treeOf(s: RepoState, id: string | null | undefined): Tree {
  return id ? s.commits[id].tree : {};
}

export const headTree = (s: RepoState) => treeOf(s, headId(s));

export function treesEqual(a: Tree, b: Tree): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function createCommit(s: RepoState, parents: string[], message: string, tree: Tree): Commit {
  s.seq += 1;
  let id = hashString(`${parents.join(",")}\n${message}\n${JSON.stringify(tree)}\n${s.seq}`).slice(0, 7);
  let salt = 0;
  while (s.commits[id]) id = hashString(`${id}:${++salt}`).slice(0, 7);
  const commit: Commit = { id, parents, message, tree: { ...tree }, seq: s.seq };
  s.commits[id] = commit;
  return commit;
}

/** Move HEAD (and the branch it points to, if any) to a commit and record it in the reflog. */
export function moveHead(s: RepoState, id: string, reflogMessage: string) {
  if (s.head.type === "branch") s.branches[s.head.name] = id;
  else s.head = { type: "detached", id };
  s.reflog.push({ id, message: reflogMessage });
}

export function ancestors(s: RepoState, id: string | null): Set<string> {
  const seen = new Set<string>();
  const stack = id ? [id] : [];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...s.commits[cur].parents);
  }
  return seen;
}

/** true when `a` is `b` or an ancestor of `b` */
export const isAncestor = (s: RepoState, a: string, b: string) => ancestors(s, b).has(a);

export function mergeBase(s: RepoState, a: string, b: string): string | null {
  const ancA = ancestors(s, a);
  const common = [...ancestors(s, b)].filter((id) => ancA.has(id));
  if (!common.length) return null;
  return common.reduce((best, id) => (s.commits[id].seq > s.commits[best].seq ? id : best));
}

/** Resolve a revision (branch, tag, hash prefix, HEAD, HEAD~2, main^, HEAD@{1}) to a commit id. */
export function tryResolve(s: RepoState, rev: string): string | null {
  const m = rev.match(/^(.*?)((?:[~^]\d*)*)$/);
  if (!m) return null;
  const base = m[1] || "HEAD";
  const suffix = m[2];
  let id: string | null = null;

  const reflogMatch = base.match(/^(?:HEAD)?@\{(\d+)\}$/);
  if (reflogMatch) {
    id = s.reflog[s.reflog.length - 1 - Number(reflogMatch[1])]?.id ?? null;
  } else if (base === "HEAD" || base === "@") {
    id = headId(s);
  } else if (s.branches[base]) {
    id = s.branches[base];
  } else if (s.tags[base]) {
    id = s.tags[base];
  } else if (/^[0-9a-f]{4,40}$/.test(base)) {
    const matches = Object.keys(s.commits).filter((c) => (base.length <= c.length ? c.startsWith(base) : base.startsWith(c)));
    if (matches.length === 1) id = matches[0];
  }
  if (!id) return null;

  for (const [, op, num] of suffix.matchAll(/([~^])(\d*)/g)) {
    const n = num === "" ? 1 : Number(num);
    if (op === "~") {
      for (let i = 0; i < n && id; i++) id = s.commits[id].parents[0] ?? null;
    } else if (n > 0) {
      id = s.commits[id].parents[n - 1] ?? null;
    }
    if (!id) return null;
  }
  return id;
}

export function resolve(s: RepoState, rev: string): string {
  const id = tryResolve(s, rev);
  if (!id) throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  return id;
}

/** Tracked paths whose index or working copy differs from HEAD. */
export function dirtyTracked(s: RepoState): string[] {
  const ht = headTree(s);
  const paths = new Set([...Object.keys(ht), ...Object.keys(s.index)]);
  return [...paths].filter((p) => s.index[p] !== ht[p] || s.work[p] !== s.index[p]).sort();
}

export const untrackedPaths = (s: RepoState) => Object.keys(s.work).filter((p) => !(p in s.index)).sort();

export function requireClean(s: RepoState, action: string) {
  const dirty = dirtyTracked(s);
  if (dirty.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by ${action}:\n${dirty
        .map((p) => `\t${p}`)
        .join("\n")}\nPlease commit your changes or stash them before you ${action}.`,
    );
  }
}

/** Replace index + working tree with `tree`, keeping untracked files. */
export function checkoutTree(s: RepoState, tree: Tree) {
  const untracked = untrackedPaths(s);
  const work: Tree = { ...tree };
  for (const p of untracked) if (!(p in tree)) work[p] = s.work[p];
  s.index = { ...tree };
  s.work = work;
}

/**
 * Switch the working tree from HEAD's tree to `newTree`, carrying local changes along
 * the way real git does, and refusing when a local change would be overwritten.
 */
export function switchTree(s: RepoState, newTree: Tree) {
  const oldTree = headTree(s);
  const paths = new Set([...Object.keys(oldTree), ...Object.keys(newTree), ...Object.keys(s.index), ...Object.keys(s.work)]);
  const blocked: string[] = [];
  const index: Tree = {};
  const work: Tree = {};
  for (const p of paths) {
    const idxDirty = s.index[p] !== oldTree[p];
    const workDirty = s.work[p] !== s.index[p];
    const dirty = idxDirty || workDirty;
    if (dirty && oldTree[p] !== newTree[p] && !(s.work[p] === newTree[p] && s.index[p] === newTree[p])) blocked.push(p);
    const i = idxDirty ? s.index[p] : newTree[p];
    const w = dirty ? s.work[p] : newTree[p];
    if (i !== undefined) index[p] = i;
    if (w !== undefined) work[p] = w;
  }
  if (blocked.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by checkout:\n${blocked
        .sort()
        .map((p) => `\t${p}`)
        .join("\n")}\nPlease commit your changes or stash them before you switch branches.`,
    );
  }
  s.index = index;
  s.work = work;
}

const withNl = (x: string) => (x === "" || x.endsWith("\n") ? x : `${x}\n`);

export interface MergeResult {
  tree: Tree; // result, conflicted paths hold "ours"
  conflicts: string[];
  markers: Tree; // conflicted paths -> content with conflict markers
}

export function threeWay(base: Tree, ours: Tree, theirs: Tree, oursLabel: string, theirsLabel: string): MergeResult {
  const tree: Tree = {};
  const markers: Tree = {};
  const conflicts: string[] = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const p of [...paths].sort()) {
    const b = base[p];
    const o = ours[p];
    const t = theirs[p];
    let r: string | undefined;
    if (o === t) r = o;
    else if (b === o) r = t;
    else if (b === t) r = o;
    else {
      conflicts.push(p);
      r = o;
      markers[p] = `<<<<<<< ${oursLabel}\n${withNl(o ?? "")}=======\n${withNl(t ?? "")}>>>>>>> ${theirsLabel}\n`;
    }
    if (r !== undefined) tree[p] = r;
  }
  return { tree, conflicts, markers };
}

/** Put a conflicted merge result into the index / working tree. */
export function applyConflict(s: RepoState, r: MergeResult) {
  checkoutTree(s, r.tree);
  for (const p of r.conflicts) s.work[p] = r.markers[p];
}

export const hasConflictMarkers = (content: string | undefined) =>
  !!content && /^<<<<<<< /m.test(content) && /^>>>>>>> /m.test(content);

// ---------- diffs ----------

function splitLines(x: string | undefined): string[] {
  if (!x) return [];
  const lines = x.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineDiff(a: string | undefined, b: string | undefined): string[] {
  const A = splitLines(a);
  const B = splitLines(b);
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      out.push(` ${A[i]}`);
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(`+${B[j++]}`);
    } else {
      out.push(`-${A[i++]}`);
    }
  }
  return out;
}

export function diffTrees(a: Tree, b: Tree, only?: (path: string) => boolean): string[] {
  const out: string[] = [];
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const p of paths) {
    if (a[p] === b[p] || (only && !only(p))) continue;
    out.push(`diff --git a/${p} b/${p}`);
    if (a[p] === undefined) out.push("new file mode 100644");
    if (b[p] === undefined) out.push("deleted file mode 100644");
    out.push(a[p] === undefined ? "--- /dev/null" : `--- a/${p}`);
    out.push(b[p] === undefined ? "+++ /dev/null" : `+++ b/${p}`);
    out.push(...lineDiff(a[p], b[p]));
  }
  return out;
}
