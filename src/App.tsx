import React, { useState, useRef } from "react";
import TowerStack, { type TowerEvent } from "./TowerStack";
import Simulation, { type SimEvent } from "./Simulation";
import GitQuest from "./components/features/gitquest/GitQuest";

// ==========================================
// 1. PROCEDURAL WEB AUDIO SOUND GENERATOR
// ==========================================
class SoundFX {
  private ctx: AudioContext | null = null;
  public enabled = true;

  private init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playClick() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    // Snappy mechanical keyboard switch simulation
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = "sine";
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.04);

    filter.type = "highpass";
    filter.frequency.setValueAtTime(400, this.ctx.currentTime);

    gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.04);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.04);
  }

  playCorrect() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(587.33, this.ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.12); // A5

    gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }

  playWrong() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(160, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(110, this.ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.22);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.22);
  }

  playVictory() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const startTime = this.ctx.currentTime + idx * 0.08;

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.2, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.25);
    });
  }
}

const sfx = new SoundFX();

// ==========================================
// 2. LIGHTWEIGHT CANVAS CONFETTI
// ==========================================
function launchConfetti() {
  const canvas = document.getElementById("confetti-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: string;
    size: number;
    alpha: number;
    rotation: number;
    vRot: number;
  }> = [];

  const colors = ["#ec4899", "#8b5cf6", "#10b981", "#06b6d4", "#f59e0b", "#3b82f6"];
  for (let i = 0; i < 90; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height * 0.35 + (Math.random() - 0.5) * 100,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -10 - 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 8 + 4,
      alpha: 1,
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 10,
    });
  }

  const render = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.3; // gravity
      p.rotation += p.vRot;
      p.alpha -= 0.012;

      if (p.alpha > 0) {
        alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.5);
        ctx.restore();
      }
    }

    if (alive) {
      requestAnimationFrame(render);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  render();
}

// ==========================================
// 4. DEV SNIPPETS DATA (SYNTAX SPRINT)
// ==========================================
interface CodeSnippet {
  id: string;
  lang: string;
  file: string;
  code: string;
}

const DEV_SNIPPETS: CodeSnippet[] = [
  {
    id: "react-hook",
    lang: "React",
    file: "useUserProfile.ts",
    code: "const [user, setUser] = useState<User | null>(null);",
  },
  {
    id: "ts-filter",
    lang: "TypeScript",
    file: "analytics.ts",
    code: "return items.filter(x => x.active).map(x => x.id);",
  },
  {
    id: "git-commit",
    lang: "Git",
    file: "terminal",
    code: 'git commit -m "fix(auth): resolve memory leak in worker"',
  },
  {
    id: "async-fetch",
    lang: "TypeScript",
    file: "apiClient.ts",
    code: "const res = await fetch('/api/v1/auth/session', { method: 'POST' });",
  },
  {
    id: "docker-cli",
    lang: "Docker",
    file: "deploy.sh",
    code: "docker compose up -d --build --remove-orphans",
  },
  {
    id: "sql-query",
    lang: "SQL",
    file: "query.sql",
    code: "SELECT id, email, created_at FROM users WHERE is_active = true;",
  },
];

// ==========================================
// 5. MAIN APP COMPONENT
// ==========================================
export default function App() {
  const [viewMode, setViewMode] = useState<"casual" | "dev" | "syntax" | "sim">("casual");
  const [soundEnabled, setSoundEnabled] = useState(true);

  // ----------------------------------------
  // DEV GAME STATE (Syntax Sprint)
  // ----------------------------------------
  const [snippetIndex, setSnippetIndex] = useState(0);
  const [typedInput, setTypedInput] = useState("");
  const [devWpm, setDevWpm] = useState(0);
  const [devAccuracy, setDevAccuracy] = useState(100);
  const [devBestWpm, setDevBestWpm] = useState(() => {
    return parseInt(localStorage.getItem("arena_dev_best_wpm") || "0", 10);
  });
  const [devCompleted, setDevCompleted] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [completedCount, setCompletedCount] = useState(0);

  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const currentSnippet = DEV_SNIPPETS[snippetIndex];

  const handleDevInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const targetCode = currentSnippet.code;

    // Only allow typing up to target length
    if (val.length > targetCode.length) return;

    sfx.playClick();

    if (!startTime && val.length > 0) {
      setStartTime(Date.now());
    }

    setTypedInput(val);

    // Calculate real-time stats
    let correctChars = 0;
    for (let i = 0; i < val.length; i++) {
      if (val[i] === targetCode[i]) correctChars++;
    }

    const accuracy = val.length > 0 ? Math.round((correctChars / val.length) * 100) : 100;
    setDevAccuracy(accuracy);

    if (startTime) {
      const minutes = (Date.now() - startTime) / 60000;
      if (minutes > 0.01) {
        const words = correctChars / 5;
        const currentWpm = Math.round(words / minutes);
        setDevWpm(currentWpm);
      }
    }

    // Check completion
    if (val === targetCode) {
      sfx.playVictory();
      launchConfetti();
      setDevCompleted(true);
      const minutes = ((Date.now() - (startTime || Date.now())) || 1000) / 60000;
      const finalWpm = Math.max(10, Math.round((targetCode.length / 5) / minutes));
      setDevWpm(finalWpm);
      setCompletedCount((prev) => prev + 1);

      if (finalWpm > devBestWpm) {
        setDevBestWpm(finalWpm);
        localStorage.setItem("arena_dev_best_wpm", finalWpm.toString());
      }
    }
  };

  const nextDevSnippet = () => {
    setSnippetIndex((prev) => (prev + 1) % DEV_SNIPPETS.length);
    setTypedInput("");
    setStartTime(null);
    setDevCompleted(false);
    if (hiddenInputRef.current) {
      hiddenInputRef.current.focus();
    }
  };

  const restartDev = () => {
    setTypedInput("");
    setStartTime(null);
    setDevCompleted(false);
    setDevWpm(0);
    setDevAccuracy(100);
    if (hiddenInputRef.current) {
      hiddenInputRef.current.focus();
    }
  };

  const handleTowerEvent = (e: TowerEvent) => {
    if (e === "place") sfx.playClick();
    else if (e === "perfect") sfx.playCorrect();
    else if (e === "fail") sfx.playWrong();
    else if (e === "levelup" || e === "milestone") {
      sfx.playVictory();
      launchConfetti();
    }
  };

  const handleSimEvent = (e: SimEvent) => {
    if (e === "coin") sfx.playCorrect();
    else if (e === "gold") sfx.playVictory();
    else if (e === "hit") sfx.playWrong();
    else if (e === "end") {
      sfx.playVictory();
      launchConfetti();
    } else sfx.playClick();
  };

  const toggleSound = () => {
    const nextState = !soundEnabled;
    setSoundEnabled(nextState);
    sfx.enabled = nextState;
  };

  return (
    <>
      <canvas id="confetti-canvas" />

      <div className="app-container">
        {/* Navigation / Header */}
        <header className="top-nav">
          <div className="brand">
            <span className="brand-icon" aria-hidden="true">
              ⚔️
            </span>
            <div>
              <h1 className="brand-title">DUAL ARENA</h1>
              <p className="brand-subtitle">Tower Stack, Git Quest, Syntax Sprint &amp; the City Simulation</p>
            </div>
          </div>

          <div className="header-controls">
            <div className="view-toggle" role="group" aria-label="Layout view switch">
              <button
                id="view-casual-btn"
                className={`toggle-btn ${viewMode === "casual" ? "active" : ""}`}
                onClick={() => setViewMode("casual")}
              >
                🎮 Casual
              </button>
              <button
                id="view-dev-btn"
                className={`toggle-btn ${viewMode === "dev" ? "active" : ""}`}
                onClick={() => setViewMode("dev")}
              >
                💻 Dev · Git Quest
              </button>
              <button
                id="view-syntax-btn"
                className={`toggle-btn ${viewMode === "syntax" ? "active" : ""}`}
                onClick={() => setViewMode("syntax")}
              >
                ⌨️ Syntax Sprint
              </button>
              <button
                id="view-sim-btn"
                className={`toggle-btn ${viewMode === "sim" ? "active" : ""}`}
                onClick={() => setViewMode("sim")}
              >
                🏙️ Simulation
              </button>
            </div>

            <button
              id="sound-toggle-btn"
              className="icon-btn"
              onClick={toggleSound}
              title={soundEnabled ? "Mute audio" : "Unmute audio"}
            >
              <span>{soundEnabled ? "🔊" : "🔇"}</span>
              <span>{soundEnabled ? "Sound ON" : "Sound OFF"}</span>
            </button>
          </div>
        </header>

        {/* Main Arena */}
        <main className={`arena-grid view-${viewMode}`}>
          {viewMode === "casual" && <TowerStack onEvent={handleTowerEvent} />}

          {/* ======================================= */}
          {/* DEV GAME (GIT QUEST)                    */}
          {/* ======================================= */}
          {viewMode === "dev" && (
            <section className="arena-card dev" aria-labelledby="gitquest-title">
              <div className="card-header">
                <div>
                  <span className="tag-badge tag-dev">⚡ For 10x Developers</span>
                  <h2 id="gitquest-title" className="game-title">
                    Git Quest
                  </h2>
                  <p className="game-desc">Rescue broken repos by typing real git commands. Match the target graph to win.</p>
                </div>
              </div>
              <GitQuest
                fx={{
                  click: () => sfx.playClick(),
                  error: () => sfx.playWrong(),
                  win: () => {
                    sfx.playVictory();
                    launchConfetti();
                  },
                }}
              />
            </section>
          )}

          {/* ======================================= */}
          {/* DEV GAME (SYNTAX SPRINT)                */}
          {/* ======================================= */}
          {viewMode === "syntax" && (
            <section className="arena-card dev" aria-labelledby="dev-game-title">
              <div className="card-header">
                <div>
                  <span className="tag-badge tag-dev">⚡ For 10x Developers</span>
                  <h2 id="dev-game-title" className="game-title">
                    Syntax Sprint
                  </h2>
                  <p className="game-desc">Type the authentic code snippet as fast and accurately as you can.</p>
                </div>

                <button
                  id="focus-terminal-btn"
                  className="btn-action btn-dev-focus"
                  onClick={() => hiddenInputRef.current?.focus()}
                >
                  ⌨️ Click to Type
                </button>
              </div>

              {/* Dev Stats */}
              <div className="stats-bar">
                <div className="stat-item">
                  <span className="stat-label">Speed</span>
                  <span className="stat-val dev-val">{devWpm} WPM</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Accuracy</span>
                  <span className="stat-val dev-val">{devAccuracy}%</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Best Speed</span>
                  <span className="stat-val">{devBestWpm} WPM</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Solved</span>
                  <span className="stat-val">{completedCount}</span>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="timer-track" aria-hidden="true">
                <div
                  className="timer-fill dev"
                  style={{
                    width: `${Math.min(100, (typedInput.length / currentSnippet.code.length) * 100)}%`,
                  }}
                />
              </div>

              {/* Code Terminal Box */}
              <div
                className="dev-terminal"
                onClick={() => hiddenInputRef.current?.focus()}
                role="region"
                aria-label="Code Editor Terminal"
              >
                <div className="terminal-header">
                  <div className="terminal-dots">
                    <span className="dot dot-red" />
                    <span className="dot dot-yellow" />
                    <span className="dot dot-green" />
                  </div>
                  <span className="terminal-filename">{currentSnippet.file}</span>
                  <span className="terminal-lang">{currentSnippet.lang}</span>
                </div>

                <div className="terminal-body">
                  <input
                    ref={hiddenInputRef}
                    id="dev-code-input"
                    className="hidden-type-input"
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    value={typedInput}
                    onChange={handleDevInputChange}
                    disabled={devCompleted}
                    aria-label="Type snippet code here"
                  />

                  <div className="code-display" aria-hidden="true">
                    {currentSnippet.code.split("").map((char, index) => {
                      let charClass = "char-pending";

                      if (index < typedInput.length) {
                        charClass = typedInput[index] === char ? "char-correct" : "char-incorrect";
                      } else if (index === typedInput.length) {
                        charClass = "char-current";
                      }

                      return (
                        <span key={index} className={charClass}>
                          {char}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Bottom Snippet Controls */}
              <div className="dev-actions">
                <div className="snippet-nav">
                  <button id="dev-restart-btn" className="btn-action" onClick={restartDev}>
                    ↺ Reset Snippet
                  </button>
                  <button id="dev-skip-btn" className="btn-action" onClick={nextDevSnippet}>
                    ⏩ Next Snippet ({snippetIndex + 1}/{DEV_SNIPPETS.length})
                  </button>
                </div>
              </div>

              {/* Completion Overlay */}
              {devCompleted && (
                <div className="overlay-screen" role="dialog" aria-modal="true">
                  <div className="modal-icon">🚀</div>
                  <h3 className="modal-title">Code Deployed!</h3>
                  <p className="modal-subtitle">You typed the entire syntax with zero compilation errors.</p>
                  <div className="score-badge-big dev-val">{devWpm} WPM</div>
                  <button id="dev-next-challenge-btn" className="btn-play-again btn-play-dev" onClick={nextDevSnippet}>
                    Next Challenge →
                  </button>
                </div>
              )}
            </section>
          )}

          {/* ======================================= */}
          {/* SIMULATION (OPEN-WORLD COIN RUN)        */}
          {/* ======================================= */}
          {viewMode === "sim" && <Simulation onEvent={handleSimEvent} />}
        </main>

        {/* Global Footer */}
        <footer className="arena-footer">
          <span>Dual Arena</span>
          <span>•</span>
          <span>Built with React + TypeScript + Vite</span>
          <span>•</span>
          <span>Mechanical audio & confetti synthesized in browser</span>
        </footer>
      </div>
    </>
  );
}
