import { describe, expect, it } from "vitest";
import { emptyRepo, exec, headId, isSolved, LEVELS, runScript, tokenize } from "./index";

const repo = (...cmds: string[]) => runScript(emptyRepo(), cmds);
const base = ["git init", 'echo "hi" > a.txt', "git add a.txt", 'git commit -m "first"'];

describe("tokenize", () => {
  it("handles quotes, redirects and &&", () => {
    expect(tokenize(`git commit -m "hello world" && echo 'x y'>f`)).toEqual([
      "git", "commit", "-m", "hello world", "&&", "echo", "x y", ">", "f",
    ]);
  });
});

describe("basics", () => {
  it("refuses git commands before init", () => {
    const r = exec(emptyRepo(), "git status");
    expect(r.failed).toBe(true);
    expect(r.lines[0].text).toMatch(/not a git repository/);
  });

  it("commits staged files", () => {
    const s = repo(...base);
    expect(Object.keys(s.commits)).toHaveLength(1);
    expect(s.commits[headId(s)!].tree).toEqual({ "a.txt": "hi\n" });
  });

  it("refuses an empty commit", () => {
    const r = exec(repo(...base), 'git commit -m "again"');
    expect(r.failed).toBe(true);
    expect(r.changed).toBe(false);
  });

  it("commit -am stages tracked files only", () => {
    const s = repo(...base, 'echo "changed" > a.txt', 'echo "new" > b.txt', 'git commit -am "update"');
    const tree = s.commits[headId(s)!].tree;
    expect(tree).toEqual({ "a.txt": "changed\n" });
    expect(s.work["b.txt"]).toBe("new\n");
  });

  it("resolves HEAD~n", () => {
    const s = repo(...base, 'echo "2" > a.txt', 'git commit -am "second"');
    const first = Object.values(s.commits).find((c) => c.message === "first")!;
    expect(exec(s, "git log --oneline HEAD~1").lines[0].text).toContain(first.id);
  });
});

describe("branching", () => {
  it("switch -c creates and moves HEAD", () => {
    const s = repo(...base, "git switch -c feat");
    expect(s.head).toEqual({ type: "branch", name: "feat" });
    expect(s.branches.feat).toBe(s.branches.main);
  });

  it("switching branches swaps the working tree", () => {
    const s = repo(...base, "git switch -c feat", 'echo "f" > f.txt', "git add f.txt", 'git commit -m "f"', "git switch main");
    expect(s.work["f.txt"]).toBeUndefined();
  });

  it("blocks a switch that would overwrite local changes", () => {
    const s = repo(...base, "git switch -c feat", 'echo "feat" > a.txt', 'git commit -am "f"', "git switch main", 'echo "dirty" > a.txt');
    expect(exec(s, "git switch feat").failed).toBe(true);
  });

  it("refuses to delete an unmerged branch with -d", () => {
    const s = repo(...base, "git switch -c feat", 'echo "f" > f.txt', "git add f.txt", 'git commit -m "f"', "git switch main");
    expect(exec(s, "git branch -d feat").failed).toBe(true);
    expect(exec(s, "git branch -D feat").state.branches.feat).toBeUndefined();
  });

  it("fast-forwards when possible", () => {
    const s = repo(...base, "git switch -c feat", 'echo "f" > f.txt', "git add f.txt", 'git commit -m "f"', "git switch main", "git merge feat");
    expect(s.branches.main).toBe(s.branches.feat);
  });

  it("creates a merge commit for diverged branches", () => {
    const s = repo(
      ...base,
      "git switch -c feat", 'echo "f" > f.txt', "git add f.txt", 'git commit -m "f"',
      "git switch main", 'echo "m" > m.txt', "git add m.txt", 'git commit -m "m"',
      "git merge feat",
    );
    const merge = s.commits[s.branches.main];
    expect(merge.parents).toHaveLength(2);
    expect(merge.tree).toEqual({ "a.txt": "hi\n", "f.txt": "f\n", "m.txt": "m\n" });
  });

  it("aborts cleanly on a conflict", () => {
    const before = repo(
      ...base,
      "git switch -c feat", 'echo "feat" > a.txt', 'git commit -am "f"',
      "git switch main", 'echo "main" > a.txt', 'git commit -am "m"',
    );
    const r = exec(before, "git merge feat");
    expect(r.failed).toBe(true);
    expect(r.changed).toBe(false);
  });
});

describe("levels", () => {
  for (const level of LEVELS) {
    it(`${level.id}: setup builds, is unsolved, and the solution solves it`, () => {
      const start = runScript(emptyRepo(), level.setup);
      const target = runScript(start, level.solution);
      expect(isSolved(start, target, level.match)).toBe(false);
      expect(isSolved(target, target, level.match)).toBe(true);
    });
  }

  it("validation ignores hashes but not messages", () => {
    const level = LEVELS.find((l) => l.id === "w1-awaken")!;
    const start = runScript(emptyRepo(), level.setup);
    const target = runScript(start, level.solution);
    const alt = runScript(start, ["git init", "git add .", 'git commit -m "initial commit"']);
    expect(isSolved(alt, target, level.match)).toBe(true);
    const wrong = runScript(start, ["git init", "git add .", 'git commit -m "oops"']);
    expect(isSolved(wrong, target, level.match)).toBe(false);
  });
});
