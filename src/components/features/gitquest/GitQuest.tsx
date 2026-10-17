import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GIT_SUBCOMMANDS,
  LEVELS,
  SHELL_COMMANDS,
  compareStates,
  emptyRepo,
  exec,
  runScript,
  type Level,
  type Line,
  type RepoState,
} from "../../../core/git";
import CommitGraph from "./CommitGraph";
import Terminal from "./Terminal";
import "./gitquest.css";

export interface GameFx {
  click: () => void;
  error: () => void;
  win: () => void;
}

const PROGRESS_KEY = "gitquest_progress";

function loadProgress(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveProgress(p: Record<string, number>) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — progress just won't persist */
  }
}

// In-progress level, so a refresh resumes where the player left off.
const SESSION_KEY = "gitquest_session";
const MAX_SAVED_LINES = 300;
const MAX_SAVED_UNDO = 30;
const RESTORED = "↻ Session restored.";

interface Session {
  levelId: string;
  fingerprint: string; // detects level definitions that changed since the save
  state: RepoState;
  undoStack: RepoState[];
  lines: Line[];
  moves: number;
  hintsShown: number;
  won: number | null;
}

const fingerprint = (l: Level) => JSON.stringify([l.setup, l.solution]);

function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as Session | null;
    const level = s && LEVELS.find((l) => l.id === s.levelId);
    return level && s && s.fingerprint === fingerprint(level) ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session) {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...s, lines: s.lines.slice(-MAX_SAVED_LINES), undoStack: s.undoStack.slice(-MAX_SAVED_UNDO) }),
    );
  } catch {
    /* storage full or unavailable — the session just won't resume */
  }
}

const introLines = (title: string): Line[] => [
  { text: `⚔  ${title}`, kind: "info" },
  { text: "Type `git status` to look around, `help` for commands, `hint` if you're stuck.", kind: "hint" },
  { text: "", kind: "out" },
];

/** Render `code` spans in level text. */
const rich = (text: string) =>
  text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part));

export default function GitQuest({ fx }: { fx: GameFx }) {
  const [progress, setProgress] = useState(loadProgress);
  const [saved] = useState(loadSession);
  const firstUnsolved = LEVELS.findIndex((l) => !progress[l.id]);
  const [levelIdx, setLevelIdx] = useState(() =>
    saved ? LEVELS.findIndex((l) => l.id === saved.levelId) : firstUnsolved === -1 ? 0 : firstUnsolved,
  );
  const level = LEVELS[levelIdx];

  const start = useMemo(() => runScript(emptyRepo(), level.setup), [level]);
  const target = useMemo(() => runScript(start, level.solution), [start, level]);

  const [state, setState] = useState<RepoState>(saved?.state ?? start);
  const [undoStack, setUndoStack] = useState<RepoState[]>(saved?.undoStack ?? []);
  const [lines, setLines] = useState<Line[]>(() =>
    saved
      ? [...saved.lines.filter((l) => l.text !== RESTORED), { text: RESTORED, kind: "hint" }]
      : introLines(level.title),
  );
  const [moves, setMoves] = useState(saved?.moves ?? 0);
  const [hintsShown, setHintsShown] = useState(saved?.hintsShown ?? 0);
  const [won, setWon] = useState<number | null>(saved?.won ?? null);

  useEffect(() => {
    saveSession({ levelId: level.id, fingerprint: fingerprint(level), state, undoStack, lines, moves, hintsShown, won });
  }, [level, state, undoStack, lines, moves, hintsShown, won]);

  const checks = useMemo(() => compareStates(state, target, level.match), [state, target, level]);

  const loadLevel = useCallback((idx: number) => {
    const l = LEVELS[idx];
    setLevelIdx(idx);
    setState(runScript(emptyRepo(), l.setup));
    setUndoStack([]);
    setLines(introLines(l.title));
    setMoves(0);
    setHintsShown(0);
    setWon(null);
  }, []);

  const showHint = () => {
    if (hintsShown >= level.hints.length) return;
    setLines((ls) => [...ls, { text: `💡 Hint ${hintsShown + 1}: ${level.hints[hintsShown]}`, kind: "hint" }]);
    setHintsShown((h) => h + 1);
  };

  const undo = () => {
    if (!undoStack.length) return;
    setState(undoStack[undoStack.length - 1]);
    setUndoStack((u) => u.slice(0, -1));
    setLines((ls) => [...ls, { text: "↶ Undid the last command.", kind: "hint" }]);
  };

  const resetLevel = () => {
    setState(start);
    setUndoStack([]);
    setLines([...introLines(level.title), { text: "↺ Level reset.", kind: "hint" }]);
    setMoves(0);
  };

  const onSubmit = (input: string) => {
    fx.click();
    const echo: Line = { text: `${prompt} ${input}`, kind: "cmd" };
    if (input === "hint" || input === "undo") {
      setLines((ls) => [...ls, echo]);
      if (input === "hint") showHint();
      else undo();
      return;
    }
    if (input === "reset") return resetLevel();

    const res = exec(state, input);
    if (res.clear) setLines([]);
    else setLines((ls) => [...ls, echo, ...res.lines]);
    if (res.failed) fx.error();
    if (!res.changed) return;

    setUndoStack((u) => [...u, state]);
    setState(res.state);
    // only commands that touch git count as moves; editing files with echo is free
    const nextMoves = moves + (input.includes("git ") ? 1 : 0);
    setMoves(nextMoves);

    if (compareStates(res.state, target, level.match).every((c) => c.ok)) {
      const stars = Math.max(1, 3 - (nextMoves > level.par ? 1 : 0) - hintsShown);
      const next = { ...progress, [level.id]: Math.max(stars, progress[level.id] ?? 0) };
      setProgress(next);
      saveProgress(next);
      setWon(stars);
      fx.win();
    }
  };

  const complete = (before: string[]): string[] => {
    if (!before.length) return [...SHELL_COMMANDS, "hint", "undo", "reset"];
    if (before[0] === "git" && before.length === 1) return GIT_SUBCOMMANDS;
    return [...Object.keys(state.branches), ...Object.keys(state.work), "HEAD", "main"].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
  };

  const branchLabel = state.initialized
    ? ` (${state.head.type === "branch" ? state.head.name : state.head.id})`
    : "";
  const prompt = `hero@dungeon${branchLabel} $`;
  const unlocked = (i: number) => i === 0 || !!progress[LEVELS[i - 1].id] || !!progress[LEVELS[i].id];
  const worlds = [...new Set(LEVELS.map((l) => l.world))];

  return (
    <div className="gq">
      <aside className="gq-map" aria-label="Level map">
        {worlds.map((w) => (
          <div key={w} className="gq-world">
            <div className="gq-world-title">{w}</div>
            {LEVELS.map((l, i) =>
              l.world !== w ? null : (
                <button
                  key={l.id}
                  className={`gq-level-btn ${i === levelIdx ? "active" : ""}`}
                  disabled={!unlocked(i)}
                  onClick={() => loadLevel(i)}
                >
                  <span>
                    {unlocked(i) ? "" : "🔒 "}
                    {i + 1}. {l.title}
                  </span>
                  <span className="gq-stars-small">
                    {progress[l.id] ? "★".repeat(progress[l.id]) + "☆".repeat(3 - progress[l.id]) : ""}
                  </span>
                </button>
              ),
            )}
          </div>
        ))}
      </aside>

      <div className="gq-main">
        <section className="gq-brief">
          <div className="gq-brief-text">
            <div className="gq-level-kicker">
              {level.world} · Level {levelIdx + 1}
            </div>
            <h3 className="gq-level-title">{level.title}</h3>
            <p className="gq-story">{rich(level.story)}</p>
          </div>
          <div className="gq-goal">
            <div className="gq-goal-title">🎯 Goal</div>
            <ul>
              {level.goal.map((g) => (
                <li key={g}>{rich(g)}</li>
              ))}
            </ul>
            <div className="gq-checks">
              {checks.map((c) => (
                <div key={c.label} className={`gq-check ${c.ok ? "ok" : ""}`}>
                  {c.ok ? "✔" : "○"} {c.label}
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="gq-toolbar">
          <div className="gq-moves">
            Moves <strong>{moves}</strong> / par {level.par}
          </div>
          <button className="btn-action" onClick={showHint} disabled={hintsShown >= level.hints.length}>
            💡 Hint ({level.hints.length - hintsShown} left, −1★)
          </button>
          <button className="btn-action" onClick={undo} disabled={!undoStack.length}>
            ↶ Undo
          </button>
          <button className="btn-action" onClick={resetLevel}>
            ↺ Reset
          </button>
        </div>

        <div className="gq-graphs">
          <CommitGraph state={state} title="Your repo" variant="current" />
          <CommitGraph state={target} title="Target" variant="target" />
        </div>

        <Terminal lines={lines} prompt={prompt} onSubmit={onSubmit} complete={complete} disabled={won !== null} />
      </div>

      {won !== null && (
        <div className="overlay-screen" role="dialog" aria-modal="true">
          <div className="modal-icon">🏆</div>
          <h3 className="modal-title">Level cleared!</h3>
          <p className="modal-subtitle">
            {level.title} — solved in {moves} move{moves === 1 ? "" : "s"} (par {level.par})
            {hintsShown ? ` with ${hintsShown} hint${hintsShown === 1 ? "" : "s"}` : ""}.
          </p>
          <div className="gq-stars-big">
            {"★".repeat(won)}
            <span className="dim">{"☆".repeat(3 - won)}</span>
          </div>
          <div className="gq-modal-actions">
            <button
              className="btn-action"
              onClick={() => {
                setWon(null);
                resetLevel();
              }}
            >
              ↺ Replay
            </button>
            {levelIdx + 1 < LEVELS.length ? (
              <button className="btn-play-again btn-play-dev" onClick={() => loadLevel(levelIdx + 1)}>
                Next level →
              </button>
            ) : (
              <button className="btn-play-again btn-play-dev" onClick={() => setWon(null)}>
                🎉 All levels done — more worlds coming!
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
