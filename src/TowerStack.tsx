import { useCallback, useEffect, useRef, useState } from "react";

export type TowerEvent = "place" | "perfect" | "fail" | "milestone" | "levelup";

interface Block {
  x: number;
  w: number;
  hue: number;
}

interface Falling {
  x: number;
  y: number; // height of the block's bottom edge above the ground (px)
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

interface Particle {
  x: number;
  y: number; // height above ground (px)
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

interface FloatText {
  text: string;
  x: number;
  y: number; // height above ground (px)
  life: number;
  color: string;
}

interface Banner {
  title: string;
  sub: string;
  t: number; // seconds remaining
}

type Status = "ready" | "playing" | "over";

const W = 400;
const H = 560;
const BLOCK_H = 28;
const GROUND = 50;
const START_W = 180;
const PERFECT_TOLERANCE = 5;
const FLOORS_PER_LEVEL = 8;

interface Theme {
  name: string;
  hue: number; // sky + block base hue
}

const THEMES: Theme[] = [
  { name: "Rookie Site", hue: 285 },
  { name: "Downtown", hue: 215 },
  { name: "Skyline", hue: 190 },
  { name: "Cloud Nine", hue: 160 },
  { name: "Sunset Ridge", hue: 25 },
  { name: "Stratosphere", hue: 335 },
  { name: "Orbit", hue: 250 },
  { name: "Deep Space", hue: 265 },
];

const themeFor = (level: number) => THEMES[(level - 1) % THEMES.length];
const levelFromFloors = (floors: number) => Math.floor(floors / FLOORS_PER_LEVEL) + 1;
const hueFor = (idx: number, level: number) => (themeFor(level).hue + idx * 9) % 360;

// Speed in px/sec: ramps within a level and jumps at each new level.
const speedFor = (floors: number) => {
  const level = levelFromFloors(floors);
  const within = floors % FLOORS_PER_LEVEL;
  return Math.min(480, 150 + (level - 1) * 40 + within * 6);
};

const NODE_GAP = 88;
const MAP_W = 220;
const nodeX = (n: number) => MAP_W / 2 + Math.sin((n - 1) * 1.15) * 58;
const starsFor = (perfects: number) => (perfects >= 4 ? 3 : perfects >= 2 ? 2 : 1);

interface Star {
  x: number;
  y: number;
  r: number;
  depth: number;
}

const STARS: Star[] = Array.from({ length: 60 }, () => ({
  x: Math.random() * W,
  y: Math.random() * H,
  r: Math.random() * 1.4 + 0.4,
  depth: Math.random() * 0.25 + 0.05,
}));

interface Game {
  stack: Block[];
  mover: Mover;
  falling: Falling[];
  particles: Particle[];
  texts: FloatText[];
  banner: Banner | null;
  camera: number;
  skyHue: number;
  combo: number;
  score: number;
  status: Status;
  flash: number;
  shake: number;
  levelPerfects: number;
}

function newGame(): Game {
  const base: Block = { x: (W - START_W) / 2, w: START_W, hue: hueFor(0, 1) };
  return {
    stack: [base],
    mover: { x: 0, w: START_W, dir: 1, hue: hueFor(1, 1) },
    falling: [],
    particles: [],
    texts: [],
    banner: { title: "LEVEL 1", sub: themeFor(1).name, t: 2.2 },
    camera: 0,
    skyHue: THEMES[0].hue,
    combo: 0,
    score: 0,
    status: "ready",
    flash: 0,
    shake: 0,
    levelPerfects: 0,
  };
}

function burst(g: Game, x0: number, x1: number, y: number, hue: number, count: number, gold = false) {
  for (let i = 0; i < count; i++) {
    g.particles.push({
      x: x0 + Math.random() * (x1 - x0),
      y,
      vx: (Math.random() - 0.5) * 220,
      vy: Math.random() * 220 + 60,
      life: 0,
      max: 0.5 + Math.random() * 0.4,
      size: Math.random() * 3 + 2,
      color: gold ? `hsl(${45 + Math.random() * 15} 100% ${60 + Math.random() * 20}%)` : `hsl(${hue} 90% 70%)`,
    });
  }
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
  const [floors, setFloors] = useState(0);
  const [status, setStatus] = useState<Status>("ready");
  const [best, setBest] = useState(() => parseInt(localStorage.getItem("arena_tower_best") || "0", 10));

  const [levelStars, setLevelStars] = useState<Record<number, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("arena_tower_stars") || "{}");
    } catch {
      return {};
    }
  });
  const mapRef = useRef<HTMLDivElement>(null);
  const [bestLevel, setBestLevel] = useState(() => parseInt(localStorage.getItem("arena_tower_best_level") || "1", 10));

  const level = levelFromFloors(floors);
  const theme = themeFor(level);
  const rungCount = Math.max(THEMES.length, level + 1, bestLevel + 1);
  const mapH = rungCount * NODE_GAP + 60;
  const nodeY = (n: number) => mapH - 50 - (n - 1) * NODE_GAP; // level 1 at the bottom
  const pathD = Array.from({ length: rungCount }, (_, i) => `${i === 0 ? "M" : "L"}${nodeX(i + 1)},${nodeY(i + 1)}`).join(" ");
  const totalStars = Object.values(levelStars).reduce((a, b) => a + b, 0);
  const progress = ((floors % FLOORS_PER_LEVEL) / FLOORS_PER_LEVEL) * 100;

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
    const idx = g.stack.length; // index of the block being dropped
    const floorsBefore = idx - 1;
    const lvl = levelFromFloors(floorsBefore);
    const bottomY = idx * BLOCK_H;
    const left = Math.max(cur.x, top.x);
    const right = Math.min(cur.x + cur.w, top.x + top.w);
    const overlap = right - left;

    // Total miss: whole block falls, tower collapses.
    if (overlap <= 0) {
      g.falling.push({ x: cur.x, y: bottomY, w: cur.w, vy: 0, hue: cur.hue });
      burst(g, cur.x, cur.x + cur.w, bottomY, 0, 24);
      g.status = "over";
      g.combo = 0;
      g.shake = 0.5;
      setCombo(0);
      setStatus("over");
      onEventRef.current("fail");
      return;
    }

    let placed: Block;
    let gained = 1;
    if (Math.abs(cur.x - top.x) <= PERFECT_TOLERANCE) {
      // Perfect: snap, keep full width. 3+ in a row regrows the block.
      g.combo += 1;
      g.levelPerfects += 1;
      const regrow = g.combo >= 3 ? 8 : 0;
      const w = Math.min(START_W, top.w + regrow);
      placed = { x: Math.max(0, Math.min(W - w, top.x - regrow / 2)), w, hue: cur.hue };
      gained = 1 + g.combo;
      g.flash = 0.3;
      burst(g, placed.x, placed.x + placed.w, bottomY, cur.hue, 22, true);
      g.texts.push({
        text: g.combo > 1 ? `PERFECT x${g.combo}` : "PERFECT!",
        x: W / 2,
        y: bottomY + 40,
        life: 0,
        color: "#fde047",
      });
      if (regrow) g.texts.push({ text: "WIDER!", x: W / 2, y: bottomY + 68, life: 0, color: "#86efac" });
      onEventRef.current("perfect");
    } else {
      placed = { x: left, w: overlap, hue: cur.hue };
      const cutW = cur.w - overlap;
      const cutX = cur.x < top.x ? cur.x : right;
      g.falling.push({ x: cutX, y: bottomY, w: cutW, vy: 0, hue: cur.hue });
      burst(g, left, right, bottomY, cur.hue, 8);
      g.combo = 0;
      g.shake = 0.12;
      onEventRef.current("place");
    }

    g.score += gained;
    g.stack.push(placed);
    const floorsNow = g.stack.length - 1;
    const newLvl = levelFromFloors(floorsNow);

    // Level up: banner, bonus, small width reward.
    if (newLvl > lvl) {
      const earned = starsFor(g.levelPerfects);
      g.levelPerfects = 0;
      setLevelStars((prev) => ({ ...prev, [lvl]: Math.max(prev[lvl] ?? 0, earned) }));
      g.texts.push({ text: "⭐".repeat(earned), x: W / 2, y: bottomY + 124, life: 0, color: "#fde047" });
      g.score += 5;
      g.banner = { title: `LEVEL ${newLvl}`, sub: themeFor(newLvl).name, t: 2.2 };
      g.texts.push({ text: "+5 LEVEL BONUS", x: W / 2, y: bottomY + 96, life: 0, color: "#67e8f9" });
      const w = Math.min(START_W, placed.w + 12);
      placed.x = Math.max(0, Math.min(W - w, placed.x - (w - placed.w) / 2));
      placed.w = w;
      onEventRef.current("levelup");
    }

    const fromLeft = g.stack.length % 2 === 0;
    g.mover = {
      x: fromLeft ? 0 : W - placed.w,
      w: placed.w,
      dir: fromLeft ? 1 : -1,
      hue: hueFor(g.stack.length, newLvl),
    };

    setScore(g.score);
    setCombo(g.combo);
    setFloors(floorsNow);
    setBestLevel((prev) => {
      if (newLvl > prev) {
        localStorage.setItem("arena_tower_best_level", newLvl.toString());
        return newLvl;
      }
      return prev;
    });
    setBest((prev) => {
      if (g.score > prev) {
        localStorage.setItem("arena_tower_best", g.score.toString());
        return g.score;
      }
      return prev;
    });
  }, []);

  const restart = useCallback(() => {
    const g = newGame();
    g.status = "playing";
    gameRef.current = g;
    setScore(0);
    setCombo(0);
    setFloors(0);
    setStatus("playing");
  }, []);

  // Persist per-level stars so the map survives refreshes.
  useEffect(() => {
    try {
      localStorage.setItem("arena_tower_stars", JSON.stringify(levelStars));
    } catch {
      /* storage unavailable */
    }
  }, [levelStars]);

  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const y = mapH - 50 - (level - 1) * NODE_GAP;
    el.scrollTo({ top: Math.max(0, y - el.clientHeight / 2), behavior: "smooth" });
  }, [level, mapH]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "ArrowDown" || e.key === "Enter") {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "BUTTON" && e.key === "Enter") return;
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

    let raf = 0;
    let last = performance.now();

    const screenY = (idx: number, camera: number) => H - GROUND - (idx + 1) * BLOCK_H + camera;
    const heightToY = (hgt: number, camera: number) => H - GROUND - hgt + camera;

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
      const floorsNow = g.stack.length - 1;
      const lvl = levelFromFloors(floorsNow);

      // ---------- update ----------
      if (g.status === "playing") {
        const speed = speedFor(floorsNow);
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

      for (const p of g.particles) {
        p.life += dt;
        p.vy -= 700 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      g.particles = g.particles.filter((p) => p.life < p.max);

      for (const t of g.texts) t.life += dt;
      g.texts = g.texts.filter((t) => t.life < 1);

      if (g.banner) {
        g.banner.t -= dt;
        if (g.banner.t <= 0) g.banner = null;
      }

      const targetCam = Math.max(0, (g.stack.length - 9) * BLOCK_H);
      g.camera += (targetCam - g.camera) * Math.min(1, dt * 6);
      g.skyHue += (themeFor(lvl).hue - g.skyHue) * Math.min(1, dt * 1.5);
      g.flash = Math.max(0, g.flash - dt);
      g.shake = Math.max(0, g.shake - dt);

      // ---------- draw ----------
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      if (g.shake > 0) ctx.translate((Math.random() - 0.5) * g.shake * 24, (Math.random() - 0.5) * g.shake * 24);

      // Sky: darker and starrier the higher the level.
      const dark = Math.min(1, (lvl - 1) / 6);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, `hsl(${g.skyHue} 60% ${16 - dark * 9}%)`);
      sky.addColorStop(1, `hsl(${g.skyHue + 40} 55% ${28 - dark * 12}%)`);
      ctx.fillStyle = sky;
      ctx.fillRect(-20, -20, W + 40, H + 40);

      const starAlpha = 0.25 + dark * 0.75;
      ctx.fillStyle = "#fff";
      for (const s of STARS) {
        const y = (((s.y + g.camera * s.depth) % H) + H) % H;
        ctx.globalAlpha = starAlpha * (0.5 + 0.5 * Math.sin(now / 600 + s.x));
        ctx.beginPath();
        ctx.arc(s.x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const groundY = H - GROUND + g.camera;
      if (groundY < H) {
        ctx.fillStyle = "#1a1030";
        ctx.fillRect(-20, groundY, W + 40, H - groundY + 20);
        ctx.fillStyle = `hsl(${g.skyHue} 80% 60% / 0.6)`;
        ctx.fillRect(-20, groundY, W + 40, 2);
      }

      // Level checkpoint lines on the tower.
      for (let l = 1; l <= floorsNow / FLOORS_PER_LEVEL; l++) {
        const y = heightToY((l * FLOORS_PER_LEVEL + 1) * BLOCK_H, g.camera);
        if (y > 0 && y < H) {
          ctx.fillStyle = "rgba(255,255,255,0.18)";
          ctx.fillRect(0, y, W, 1);
          ctx.fillStyle = "rgba(255,255,255,0.45)";
          ctx.font = "700 11px 'Plus Jakarta Sans', sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(`LEVEL ${l + 1}`, 8, y - 4);
        }
      }

      g.stack.forEach((b, i) => {
        const y = screenY(i, g.camera);
        if (y > -BLOCK_H && y < H) drawBlock(b.x, y, b.w, b.hue);
      });

      if (g.status !== "over") {
        const m = g.mover;
        const y = screenY(g.stack.length, g.camera);
        // Guide: faint column showing where the block would land.
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(m.x, y + BLOCK_H, m.w, H);
        drawBlock(m.x, y, m.w, m.hue);
      }

      for (const f of g.falling) {
        drawBlock(f.x, heightToY(f.y + BLOCK_H, g.camera), f.w, f.hue, Math.max(0.15, 1 - f.vy / 1600));
      }

      for (const p of g.particles) {
        ctx.globalAlpha = 1 - p.life / p.max;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, heightToY(p.y, g.camera), p.size, p.size);
      }
      ctx.globalAlpha = 1;

      // Floating texts
      ctx.textAlign = "center";
      for (const t of g.texts) {
        ctx.globalAlpha = 1 - t.life;
        ctx.fillStyle = t.color;
        ctx.font = "800 20px 'Plus Jakarta Sans', sans-serif";
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 6;
        ctx.fillText(t.text, t.x, heightToY(t.y + t.life * 40, g.camera));
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      if (g.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${g.flash * 0.5})`;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();

      // HUD: level pill (not shaken)
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.roundRect(10, 10, 112, 30, 15);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "800 14px 'Plus Jakarta Sans', sans-serif";
      ctx.fillText(`LV ${lvl} · ${floorsNow}F`, 22, 30);

      // Level banner
      if (g.banner) {
        const b = g.banner;
        const a = Math.min(1, b.t * 2, (2.2 - b.t) * 4);
        const scale = 0.85 + 0.15 * Math.min(1, (2.2 - b.t) * 5);
        ctx.save();
        ctx.translate(W / 2, H * 0.28);
        ctx.scale(scale, scale);
        ctx.globalAlpha = Math.max(0, a);
        ctx.textAlign = "center";
        ctx.shadowColor = `hsl(${g.skyHue} 100% 60%)`;
        ctx.shadowBlur = 24;
        ctx.fillStyle = "#fff";
        ctx.font = "900 46px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(b.title, 0, 0);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = "700 16px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(b.sub.toUpperCase(), 0, 28);
        ctx.restore();
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
            Click or press <strong>Space</strong> to drop the block. Overhang gets sliced off — land 3 perfects in a row
            to grow wider!
          </p>
        </div>
        <div className="level-badge" style={{ borderColor: `hsl(${theme.hue} 80% 60%)` }}>
          <span className="level-badge-num">LV {level}</span>
          <span className="level-badge-name">{theme.name}</span>
        </div>
      </div>

      <div className="stats-bar">
        <div className="stat-item">
          <span className="stat-label">Score</span>
          <span className="stat-val casual-val">{score}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Floors</span>
          <span className="stat-val casual-val">{floors}</span>
        </div>
        <div className={`stat-item ${combo >= 2 ? "combo-hot" : ""}`}>
          <span className="stat-label">Perfect Combo</span>
          <span className="stat-val casual-val">{combo}🔥</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Best Record</span>
          <span className="stat-val">{best}</span>
        </div>
      </div>

      <div className="timer-track" title={`Next level in ${FLOORS_PER_LEVEL - (floors % FLOORS_PER_LEVEL)} floors`}>
        <div
          className="timer-fill casual"
          style={{
            width: `${progress}%`,
            background: `linear-gradient(90deg, hsl(${theme.hue} 85% 60%), hsl(${theme.hue + 40} 85% 65%))`,
          }}
        />
      </div>

      <div className="tower-layout">
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
              <p className="modal-subtitle">
                You reached Level {level} — {theme.name}.
              </p>
              <div className="score-badge-big casual-val">{score} PTS</div>
              {score > 0 && score >= best && <p className="new-best">🏆 New best score!</p>}
              <button id="tower-retry-btn" className="btn-play-again btn-play-casual" onClick={restart}>
                🔄 Play Again
              </button>
            </div>
          )}
        </div>

        <aside className="ladder" aria-label="Level map">
          <div className="ladder-head">
            <h3 className="ladder-title">Level Map</h3>
            <span className="ladder-stars">⭐ {totalStars}</span>
          </div>
          <div className="level-map" ref={mapRef}>
            <div className="level-map-inner" style={{ height: mapH, width: MAP_W }}>
              <svg className="map-path" width={MAP_W} height={mapH} aria-hidden="true">
                <path d={pathD} />
              </svg>
              {Array.from({ length: rungCount }, (_, i) => i + 1).map((n) => {
                const t = themeFor(n);
                const state = n === level ? "current" : n < bestLevel ? "done" : "locked";
                const stars = levelStars[n] ?? 0;
                return (
                  <div
                    key={n}
                    className={`map-node node-${state}`}
                    style={{ left: nodeX(n), top: nodeY(n) }}
                    aria-current={state === "current" ? "step" : undefined}
                    title={`${t.name} — ${(n - 1) * FLOORS_PER_LEVEL}+ floors`}
                  >
                    {state === "done" && (
                      <span className="node-stars" aria-label={`${stars} stars`}>
                        {[0, 1, 2].map((k) => (
                          <span key={k} className={k < stars ? "star-on" : "star-off"}>
                            ★
                          </span>
                        ))}
                      </span>
                    )}
                    {state === "current" && (
                      <span className="node-balloon" aria-hidden="true">
                        🎈
                      </span>
                    )}
                    <span className="node-rim">
                      <span className="node-disc">{n}</span>
                    </span>
                    <span className="node-label">{t.name}</span>
                    {n === bestLevel && state !== "current" && <span className="node-best">BEST</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
