import { useCallback, useEffect, useRef, useState } from "react";

export type TowerEvent = "place" | "perfect" | "fail" | "milestone";

interface Block {
  x: number;
  w: number;
  hue: number;
}

interface Falling {
  x: number;
  y: number; // world y of top edge, in level space (px above ground)
  w: number;
  vy: number;
  hue: number;
}

interface Mover {
  x: number;
  w: number;
  dir: 1 | -1;
  hue: number;
}

type Status = "ready" | "playing" | "over";

const W = 400;
const H = 560;
const BLOCK_H = 28;
const GROUND = 50; // empty strip at the bottom
const START_W = 180;
const PERFECT_TOLERANCE = 5;

const hueFor = (level: number) => (level * 14 + 320) % 360;

interface Game {
  stack: Block[];
  mover: Mover;
  falling: Falling[];
  camera: number; // current camera offset in px
  combo: number;
  score: number;
  status: Status;
  flash: number; // perfect-drop flash timer (seconds)
}

function newGame(): Game {
  const base: Block = { x: (W - START_W) / 2, w: START_W, hue: hueFor(0) };
  return {
    stack: [base],
    mover: { x: 0, w: START_W, dir: 1, hue: hueFor(1) },
    falling: [],
    camera: 0,
    combo: 0,
    score: 0,
    status: "ready",
    flash: 0,
  };
}

interface Props {
  onEvent: (e: TowerEvent) => void;
}

export default function TowerStack({ onEvent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game>(newGame());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [status, setStatus] = useState<Status>("ready");
  const [best, setBest] = useState(() => parseInt(localStorage.getItem("arena_tower_best") || "0", 10));

  const drop = useCallback(() => {
    const g = gameRef.current;

    if (g.status === "ready") {
      g.status = "playing";
      setStatus("playing");
      return;
    }
    if (g.status !== "playing") return;

    const top = g.stack[g.stack.length - 1];
    const cur = g.mover;
    const level = g.stack.length; // level index of the block being dropped
    const left = Math.max(cur.x, top.x);
    const right = Math.min(cur.x + cur.w, top.x + top.w);
    const overlap = right - left;

    // Total miss: the whole block falls and the game ends.
    if (overlap <= 0) {
      g.falling.push({ x: cur.x, y: level * BLOCK_H, w: cur.w, vy: 0, hue: cur.hue });
      g.status = "over";
      g.combo = 0;
      setCombo(0);
      setStatus("over");
      onEventRef.current("fail");
      return;
    }

    let placed: Block;
    if (Math.abs(cur.x - top.x) <= PERFECT_TOLERANCE) {
      // Perfect drop: snap onto the block below, no trimming.
      placed = { x: top.x, w: top.w, hue: cur.hue };
      g.combo += 1;
      g.flash = 0.35;
      g.score += 1 + g.combo;
      onEventRef.current("perfect");
    } else {
      placed = { x: left, w: overlap, hue: cur.hue };
      // The overhanging part falls away.
      const cutW = cur.w - overlap;
      const cutX = cur.x < top.x ? cur.x : right;
      g.falling.push({ x: cutX, y: level * BLOCK_H, w: cutW, vy: 0, hue: cur.hue });
      g.combo = 0;
      g.score += 1;
      onEventRef.current("place");
    }

    g.stack.push(placed);
    if (g.score > 0 && g.stack.length % 10 === 0) onEventRef.current("milestone");

    const nextLevel = g.stack.length;
    const fromLeft = nextLevel % 2 === 0;
    g.mover = {
      x: fromLeft ? 0 : W - placed.w,
      w: placed.w,
      dir: fromLeft ? 1 : -1,
      hue: hueFor(nextLevel),
    };

    setScore(g.score);
    setCombo(g.combo);
    setBest((prev) => {
      if (g.score > prev) {
        localStorage.setItem("arena_tower_best", g.score.toString());
        return g.score;
      }
      return prev;
    });
  }, []);

  const restart = useCallback(() => {
    gameRef.current = newGame();
    gameRef.current.status = "playing";
    setScore(0);
    setCombo(0);
    setStatus("playing");
  }, []);

  // Keyboard: Space / Enter / ArrowDown drops the block.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "ArrowDown" || e.key === "Enter") {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "BUTTON" && e.key === "Enter") return; // let focused buttons work
        e.preventDefault();
        if (gameRef.current.status === "over") return;
        drop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drop]);

  // Game loop + rendering.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = performance.now();

    // Screen y of the top edge of a block at `level`, given the camera.
    const screenY = (level: number, camera: number) => H - GROUND - (level + 1) * BLOCK_H + camera;

    const drawBlock = (x: number, y: number, w: number, hue: number, alpha = 1) => {
      ctx.globalAlpha = alpha;
      const grad = ctx.createLinearGradient(0, y, 0, y + BLOCK_H);
      grad.addColorStop(0, `hsl(${hue} 85% 62%)`);
      grad.addColorStop(1, `hsl(${hue} 80% 45%)`);
      ctx.fillStyle = grad;
      ctx.shadowColor = `hsl(${hue} 90% 60%)`;
      ctx.shadowBlur = 12;
      ctx.fillRect(x, y, w, BLOCK_H - 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(x, y, w, 3);
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const g = gameRef.current;

      // --- update ---
      if (g.status === "playing") {
        const level = g.stack.length;
        const speed = Math.min(420, 150 + level * 9);
        const m = g.mover;
        m.x += m.dir * speed * dt;
        if (m.x <= 0) {
          m.x = 0;
          m.dir = 1;
        } else if (m.x + m.w >= W) {
          m.x = W - m.w;
          m.dir = -1;
        }
      }

      for (const f of g.falling) {
        f.vy += 1800 * dt;
        f.y -= f.vy * dt;
      }
      g.falling = g.falling.filter((f) => f.y > g.camera - GROUND - BLOCK_H);

      // Camera follows the tower once it climbs past ~60% of the view.
      const targetCam = Math.max(0, (g.stack.length - 9) * BLOCK_H);
      g.camera += (targetCam - g.camera) * Math.min(1, dt * 6);
      g.flash = Math.max(0, g.flash - dt);

      // --- draw ---
      ctx.clearRect(0, 0, W, H);

      // Background that darkens as the tower climbs.
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      const t = Math.min(1, g.stack.length / 60);
      sky.addColorStop(0, `hsl(${260 - t * 40} 60% ${14 - t * 8}%)`);
      sky.addColorStop(1, `hsl(${300 - t * 40} 55% ${22 - t * 10}%)`);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      // Ground
      const groundY = H - GROUND + g.camera;
      if (groundY < H) {
        ctx.fillStyle = "#1a1030";
        ctx.fillRect(0, groundY, W, H - groundY);
        ctx.fillStyle = "rgba(236,72,153,0.5)";
        ctx.fillRect(0, groundY, W, 2);
      }

      g.stack.forEach((b, i) => {
        const y = screenY(i, g.camera);
        if (y > -BLOCK_H && y < H) drawBlock(b.x, y, b.w, b.hue);
      });

      if (g.status !== "over") {
        const m = g.mover;
        drawBlock(m.x, screenY(g.stack.length, g.camera), m.w, m.hue);
      }

      for (const f of g.falling) {
        const y = H - GROUND - f.y - BLOCK_H + g.camera;
        drawBlock(f.x, y, f.w, f.hue, Math.max(0.15, 1 - f.vy / 1600));
      }

      if (g.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${g.flash * 0.5})`;
        ctx.fillRect(0, 0, W, H);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="arena-card casual" aria-labelledby="casual-game-title">
      <div className="card-header">
        <div>
          <span className="tag-badge tag-casual">👾 For Normal Humans</span>
          <h2 id="casual-game-title" className="game-title">
            Tower Stack
          </h2>
          <p className="game-desc">
            Click or press <strong>Space</strong> to drop the block. Overhang gets sliced off — stack as high as you can!
          </p>
        </div>
      </div>

      <div className="stats-bar">
        <div className="stat-item">
          <span className="stat-label">Height</span>
          <span className="stat-val casual-val">{score}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Perfect Combo</span>
          <span className="stat-val casual-val">{combo}🔥</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Best Record</span>
          <span className="stat-val">{best}</span>
        </div>
      </div>

      <div className="tower-wrap">
        <canvas
          ref={canvasRef}
          id="tower-canvas"
          className="tower-canvas"
          onPointerDown={(e) => {
            e.preventDefault();
            drop();
          }}
          aria-label="Tower Stack game board"
        />

        {status === "ready" && (
          <div className="tower-hint" aria-hidden="true">
            Tap to start
          </div>
        )}

        {status === "over" && (
          <div className="overlay-screen" role="dialog" aria-modal="true">
            <div className="modal-icon">🏗️</div>
            <h3 className="modal-title">Tower Collapsed!</h3>
            <p className="modal-subtitle">The block missed the stack completely.</p>
            <div className="score-badge-big casual-val">{score} FLOORS</div>
            <button id="tower-retry-btn" className="btn-play-again btn-play-casual" onClick={restart}>
              🔄 Play Again
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
