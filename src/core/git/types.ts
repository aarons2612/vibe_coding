// Core data model for the Git Quest simulator (pure data, no UI).

/** filepath -> file content */
export type Tree = Record<string, string>;

export interface Commit {
  id: string; // 7-char hex hash
  parents: string[];
  message: string;
  tree: Tree;
  seq: number; // creation order; parents always have a lower seq than children
}

export type Head = { type: "branch"; name: string } | { type: "detached"; id: string };

/** An in-progress multi-step operation (merge / cherry-pick / revert / rebase). */
export interface Sequencer {
  kind: "merge" | "cherry-pick" | "revert" | "rebase";
  current?: string; // commit being applied (the "theirs" side)
  message: string; // message to use when the step is committed
  conflicts: string[]; // paths still unresolved
  todo: string[]; // commits still to apply (cherry-pick / revert / rebase)
  origHead: string | null; // commit to return to on --abort
  branch: string | null; // branch HEAD was on when the operation started
  label: string; // human name of the incoming side (e.g. branch name)
}

export interface StashEntry {
  message: string;
  base: string | null;
  index: Tree;
  work: Tree;
}

export interface ReflogEntry {
  id: string;
  message: string;
}

export interface RepoState {
  initialized: boolean;
  commits: Record<string, Commit>;
  branches: Record<string, string>; // name -> commit id
  tags: Record<string, string>; // name -> commit id
  head: Head;
  index: Tree; // staging area
  work: Tree; // working directory
  reflog: ReflogEntry[]; // oldest first
  stash: StashEntry[]; // newest first
  op: Sequencer | null;
  seq: number;
}

export type LineKind = "out" | "err" | "ok" | "info" | "hint" | "cmd";

export interface Line {
  text: string;
  kind: LineKind;
}

export interface ExecResult {
  state: RepoState;
  lines: Line[];
  /** true when the repository/working directory changed */
  changed: boolean;
  /** true when the last command failed */
  failed: boolean;
  clear?: boolean;
  openEditor?: string;
}
