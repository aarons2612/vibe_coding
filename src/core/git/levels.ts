// Level definitions. Start state = setup script run on an empty repo;
// target state = start state + the reference solution. Goals compare graph shape, refs and files.
import type { MatchOptions } from "./validate";

export interface Level {
  id: string;
  world: string;
  title: string;
  story: string;
  goal: string[];
  setup: string[];
  solution: string[];
  par: number; // repo-changing commands in the reference solution
  hints: string[];
  match?: MatchOptions;
}

const base = [
  "git init",
  'echo "# The Lost Repository" > README.md',
  "git add README.md",
  'git commit -m "Initial commit"',
];

export const LEVELS: Level[] = [
  {
    id: "w1-awaken",
    world: "World 1 · Basics",
    title: "Awaken the Repo",
    story:
      "You wake in a dusty crypt. A scroll called README.md lies on the floor, but nothing here is tracked by git. Bring the repository to life.",
    goal: ["Initialize a repository", "Stage README.md", 'Commit it with the message "Initial commit"'],
    setup: ['echo "# The Lost Repository" > README.md'],
    solution: ["git init", "git add README.md", 'git commit -m "Initial commit"'],
    par: 3,
    hints: [
      "Start with `git init` to create the repository.",
      "`git add README.md` puts the file in the staging area.",
      'Finish with `git commit -m "Initial commit"`.',
    ],
  },
  {
    id: "w1-stage",
    world: "World 1 · Basics",
    title: "Stage Fright",
    story:
      "Two useful scrolls appeared — torch.txt and map.txt — plus a cursed debug.log that must never be committed. Use `git status` to look around.",
    goal: ['Commit torch.txt and map.txt in one commit: "Light the way"', "Leave debug.log untracked"],
    setup: [...base, 'echo "a flickering torch" > torch.txt', 'echo "north, then left" > map.txt', 'echo "CURSED" > debug.log'],
    solution: ["git add torch.txt map.txt", 'git commit -m "Light the way"'],
    par: 2,
    match: { workdir: true },
    hints: [
      "`git add` accepts several file names at once.",
      "Don't use `git add .` here — that would stage debug.log too.",
      'Try `git add torch.txt map.txt` then `git commit -m "Light the way"`.',
    ],
  },
  {
    id: "w1-shortcut",
    world: "World 1 · Basics",
    title: "The Shortcut",
    story:
      "You've edited README.md and map.txt, both already tracked. A seasoned adventurer can stage and commit tracked changes in a single stroke.",
    goal: ['Commit both changes in one commit: "Update the map"', "Use as few commands as possible (par: 1)"],
    setup: [
      ...base,
      'echo "start at the gate" > map.txt',
      "git add map.txt",
      'git commit -m "Add map"',
      'echo "# The Lost Repository (found!)" > README.md',
      'echo "start at the gate, then descend" > map.txt',
    ],
    solution: ['git commit -am "Update the map"'],
    par: 1,
    hints: [
      "`git commit` has a flag that stages every *tracked* modified file first.",
      "`-a` stages tracked changes, `-m` sets the message — and they can be combined.",
      'Use `git commit -am "Update the map"`.',
    ],
  },
  {
    id: "w2-fork",
    world: "World 2 · Branching",
    title: "A Fork in the Path",
    story:
      "The tunnel splits. Explore the side passage on its own branch so main stays safe. A file called tunnel.txt is waiting.",
    goal: [
      "Create a branch called `tunnel` and switch to it",
      'Commit tunnel.txt there: "Map the tunnel"',
      "Return to main",
    ],
    setup: [...base, 'echo "dark and damp" > tunnel.txt'],
    solution: ["git switch -c tunnel", "git add tunnel.txt", 'git commit -m "Map the tunnel"', "git switch main"],
    par: 4,
    hints: [
      "`git switch -c <name>` creates a branch and moves onto it in one step.",
      'Then `git add tunnel.txt` and `git commit -m "Map the tunnel"`.',
      "Finish with `git switch main` — your commit stays safe on `tunnel`.",
    ],
  },
  {
    id: "w2-merge",
    world: "World 2 · Branching",
    title: "Reunite the Party",
    story:
      "Your party split up: main and the `scout` branch each discovered something new. Bring scout's discoveries back into main, then tidy up.",
    goal: ["Merge `scout` into main (this creates a merge commit)", "Delete the `scout` branch afterwards"],
    setup: [
      ...base,
      "git switch -c scout",
      'echo "a hidden lever" > lever.txt',
      "git add lever.txt",
      'git commit -m "Find the lever"',
      "git switch main",
      'echo "a sleeping dragon" > dragon.txt',
      "git add dragon.txt",
      'git commit -m "Spot the dragon"',
    ],
    solution: ["git merge scout", "git branch -d scout"],
    par: 2,
    match: { messages: false },
    hints: [
      "Make sure you're on main, then use `git merge <branch>`.",
      "After merging, the branch's commits are part of main — it's safe to delete.",
      "`git merge scout` then `git branch -d scout`.",
    ],
  },
];
