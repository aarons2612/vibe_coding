import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type SimEvent = "start" | "coin" | "gold" | "hit" | "end" | "enter" | "exit";

// ---------------------------------------------------------------
// World layout (2D logic plane: x → three.x, y → three.z)
// ---------------------------------------------------------------
const VW = 900; // render size
const VH = 560;
const CELL = 400;
const ROAD = 100;
const BLOCK = CELL - ROAD; // 300
const COLS = 6;
const ROWS = 5;
const WORLD_W = COLS * CELL + ROAD;
const WORLD_H = ROWS * CELL + ROAD;
const ROUND_SECONDS = 120;
const COIN_TARGET = 45;
const PED_COUNT = 24;
const TRAFFIC_COUNT = 14;

const FOOT_R = 12;
const CAR_R = 18;
const PED_R = 8;
const WALK = 190;
const SPRINT = 290;
const CAR_MAX = 440;
const CAR_REV = 150;
const CAR_ACC = 280;

const RADAR = 160; // radar diameter (css px)
const RADAR_RANGE = 280; // world units from the radar centre to its edge

// Full-screen map layout (shared by drawing + click handling)
const BM_S = Math.min((VW - 330) / WORLD_W, (VH - 100) / WORLD_H);
const BM_OX = 30;
const BM_OY = 90;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number;
  height: number; // building height in 3D
}

interface BlockPos {
  x: number;
  y: number;
}

const BUILDINGS: Rect[] = [];
const PARKS: BlockPos[] = [];
const BLOCKS: BlockPos[] = [];

for (let i = 0; i < COLS; i++) {
  for (let j = 0; j < ROWS; j++) {
    const bx = i * CELL + ROAD;
    const by = j * CELL + ROAD;
    BLOCKS.push({ x: bx, y: by });
    if ((i * 3 + j * 2) % 7 === 3) {
      PARKS.push({ x: bx, y: by });
      continue;
    }
    const hue = (i * 47 + j * 83 + 20) % 360;
    const hA = 70 + ((i * 5 + j * 11) % 9) * 14;
    const hB = 60 + ((i * 7 + j * 3) % 9) * 16;
    if ((i + j) % 2 === 0) {
      BUILDINGS.push({ x: bx + 24, y: by + 24, w: 118, h: 252, hue, height: hA });
      BUILDINGS.push({ x: bx + 158, y: by + 24, w: 118, h: 252, hue: (hue + 40) % 360, height: hB });
    } else {
      BUILDINGS.push({ x: bx + 24, y: by + 24, w: 252, h: 118, hue, height: hA });
      BUILDINGS.push({ x: bx + 24, y: by + 158, w: 252, h: 118, hue: (hue + 60) % 360, height: hB });
    }
  }
}

// ---------------------------------------------------------------
// Entities
// ---------------------------------------------------------------
interface Car {
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
}

interface Ped {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  phase: number;
}

interface Coin {
  x: number;
  y: number;
  v: number;
  ph: number;
}

interface Particle {
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  vh: number;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
}

interface FloatText {
  sprite: THREE.Sprite;
  x: number;
  z: number;
  life: number;
}

type Status = "ready" | "playing" | "over";
type EndReason = "time" | "foot" | "ped";

interface Sim {
  status: Status;
  endReason: EndReason;
  time: number;
  coins: number;
  px: number;
  py: number;
  face: number;
  walk: number;
  inCar: Car | null;
  nearCar: Car | null;
  parked: Car[];
  traffic: Car[];
  peds: Ped[];
  coinList: Coin[];
  particles: Particle[];
  texts: FloatText[];
  invuln: number;
  shake: number;
  crashPed: number; // index of the pedestrian hit by the player's car, or -1
  crashT: number; // seconds since a crash ended the round
}

const PARKED: Array<[number, number, number, string]> = [
  [360, 1 * CELL + 10, 0, "#ef4444"],
  [1100, 2 * CELL + 90, Math.PI, "#3b82f6"],
  [1700, 0 * CELL + 10, 0, "#f59e0b"],
  [2000, 3 * CELL + 90, Math.PI, "#10b981"],
  [700, 4 * CELL + 10, 0, "#a855f7"],
  [2200, 1 * CELL + 90, Math.PI, "#ec4899"],
  [1300, 5 * CELL + 10, 0, "#06b6d4"],
  [520, 3 * CELL + 90, Math.PI, "#f97316"],
];

const TRAFFIC_COLORS = ["#e5e7eb", "#94a3b8", "#fbbf24", "#60a5fa", "#f87171", "#34d399", "#c084fc"];
const PED_COLORS = [0xf87171, 0x60a5fa, 0xfbbf24, 0x34d399, 0xc084fc, 0xf472b6, 0xfb923c];
const PED_LEGS = [0x2b3a67, 0x4b974b, 0x6b4423, 0x374151, 0x7c2d12];
const PED_SKINS = [0xf5cd30, 0xf1c27d, 0xd5a06a, 0xa97b50];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function inBuilding(x: number, y: number, pad: number) {
  for (const b of BUILDINGS) {
    if (x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad) return true;
  }
  return false;
}

function randomPos(avoidX: number, avoidY: number, minDist: number) {
  for (let n = 0; n < 80; n++) {
    const x = rand(30, WORLD_W - 30);
    const y = rand(30, WORLD_H - 30);
    if (inBuilding(x, y, 18)) continue;
    if (Math.hypot(x - avoidX, y - avoidY) < minDist) continue;
    return { x, y };
  }
  return { x: 450, y: 450 };
}

// Push a circle out of any building it overlaps. Returns true on contact.
function resolveCircle(p: { x: number; y: number }, r: number) {
  let hit = false;
  for (const b of BUILDINGS) {
    const nx = clamp(p.x, b.x, b.x + b.w);
    const ny = clamp(p.y, b.y, b.y + b.h);
    const dx = p.x - nx;
    const dy = p.y - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    hit = true;
    if (d2 > 0.0001) {
      const d = Math.sqrt(d2);
      p.x += (dx / d) * (r - d);
      p.y += (dy / d) * (r - d);
    } else {
      const l = p.x - b.x;
      const rr = b.x + b.w - p.x;
      const t = p.y - b.y;
      const bt = b.y + b.h - p.y;
      const m = Math.min(l, rr, t, bt);
      if (m === l) p.x = b.x - r;
      else if (m === rr) p.x = b.x + b.w + r;
      else if (m === t) p.y = b.y - r;
      else p.y = b.y + b.h + r;
    }
  }
  p.x = clamp(p.x, r, WORLD_W - r);
  p.y = clamp(p.y, r, WORLD_H - r);
  return hit;
}

function makeTraffic(avoidX: number, avoidY: number): Car[] {
  const cars: Car[] = [];
  for (let n = 0; n < TRAFFIC_COUNT; n++) {
    const horiz = Math.random() < 0.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const road = Math.floor(Math.random() * (horiz ? ROWS + 1 : COLS + 1));
    // Right-hand traffic: lanes sit at 30 / 70 inside each 100px road.
    const lane = horiz ? (dir === 1 ? 70 : 30) : dir === 1 ? 30 : 70;
    const along = rand(0, horiz ? WORLD_W : WORLD_H);
    const x = horiz ? along : road * CELL + lane;
    const y = horiz ? road * CELL + lane : along;
    if (Math.hypot(x - avoidX, y - avoidY) < 300) {
      n--;
      continue;
    }
    const angle = horiz ? (dir === 1 ? 0 : Math.PI) : dir === 1 ? Math.PI / 2 : -Math.PI / 2;
    const speed = 130 + ((road * 7 + (dir === 1 ? 3 : 0) + (horiz ? 5 : 0)) % 5) * 14;
    cars.push({ x, y, angle, speed, color: TRAFFIC_COLORS[n % TRAFFIC_COLORS.length] });
  }
  return cars;
}

function newSim(): Sim {
  const px = CELL + 50;
  const py = CELL + 50;
  const coinList: Coin[] = [];
  for (let i = 0; i < COIN_TARGET; i++) {
    const p = randomPos(px, py, 120);
    coinList.push({ x: p.x, y: p.y, v: Math.random() < 0.1 ? 5 : 1, ph: Math.random() * 6 });
  }
  const peds: Ped[] = [];
  for (let i = 0; i < PED_COUNT; i++) {
    const p = randomPos(px, py, 100);
    peds.push({ x: p.x, y: p.y, vx: 0, vy: 0, t: 0, phase: Math.random() * 6 });
  }
  return {
    status: "ready",
    endReason: "time",
    time: ROUND_SECONDS,
    coins: 0,
    px,
    py,
    face: 0,
    walk: 0,
    inCar: null,
    nearCar: null,
    parked: PARKED.map(([x, y, angle, color]) => ({ x, y, angle, speed: 0, color })),
    traffic: makeTraffic(px, py),
    peds,
    coinList,
    particles: [],
    texts: [],
    invuln: 2,
    shake: 0,
    crashPed: -1,
    crashT: 0,
  };
}

// ---------------------------------------------------------------
// Three.js model builders
// ---------------------------------------------------------------
function makeFacade(hue: number) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = `hsl(${hue} 30% 40%)`;
    x.fillRect(0, 0, 64, 64);
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 2; k++) {
        x.fillStyle = Math.random() < 0.4 ? "#fde9a6" : "#26354d";
        x.fillRect(7 + k * 30, 8 + r * 30, 20, 18);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface HumanRig {
  group: THREE.Group; // positioned + yawed
  body: THREE.Group; // tilts when knocked down
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
}

let faceTexture: THREE.CanvasTexture | null = null;
function getFaceTexture() {
  if (faceTexture) return faceTexture;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#111";
    x.beginPath();
    x.ellipse(22, 26, 4.5, 7, 0, 0, Math.PI * 2);
    x.ellipse(42, 26, 4.5, 7, 0, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#111";
    x.lineWidth = 3.5;
    x.lineCap = "round";
    x.beginPath();
    x.arc(32, 32, 15, 0.22 * Math.PI, 0.78 * Math.PI);
    x.stroke();
  }
  faceTexture = new THREE.CanvasTexture(c);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  return faceTexture;
}

// Blocky, Roblox-style avatar: cube head with a smiley, boxy torso, arms and legs.
function makeHuman(torsoColor: number, legColor: number, skinColor: number, scale = 1): HumanRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const skin = new THREE.MeshLambertMaterial({ color: skinColor });
  const torsoM = new THREE.MeshLambertMaterial({ color: torsoColor });
  const legM = new THREE.MeshLambertMaterial({ color: legColor });

  const limb = (mat: THREE.Material, h: number, py: number, pz: number) => {
    const g = new THREE.Group();
    g.position.set(0, py, pz);
    const m = new THREE.Mesh(new RoundedBoxGeometry(6, h, 6, 2, 0.9), mat);
    m.position.y = -h / 2;
    m.castShadow = true;
    g.add(m);
    body.add(g);
    return g;
  };

  const legL = limb(legM, 12, 12, -3);
  const legR = limb(legM, 12, 12, 3);
  const armL = limb(skin, 12, 24, -9);
  const armR = limb(skin, 12, 24, 9);

  const torso = new THREE.Mesh(new RoundedBoxGeometry(6, 12, 12, 2, 0.9), torsoM);
  torso.position.y = 18;
  torso.castShadow = true;
  body.add(torso);

  const head = new THREE.Mesh(new RoundedBoxGeometry(6.4, 6.4, 6.4, 3, 1.5), skin);
  head.position.y = 27.4;
  head.castShadow = true;
  body.add(head);

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(5.4, 5.4),
    new THREE.MeshBasicMaterial({ map: getFaceTexture(), transparent: true }),
  );
  face.position.set(3.25, 27.4, 0);
  face.rotation.y = Math.PI / 2;
  body.add(face);

  group.scale.setScalar(scale);
  return { group, body, legL, legR, armL, armR };
}

interface CarRig {
  group: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
}

function makeCar(color: string): CarRig {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const glass = new THREE.MeshLambertMaterial({ color: 0x0f172a });
  const dark = new THREE.MeshLambertMaterial({ color: 0x111111 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(46, 8, 24), bodyMat);
  body.position.y = 8;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(22, 8, 20), glass);
  cabin.position.set(-3, 15.5, 0);
  cabin.castShadow = true;
  group.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(18, 1.5, 17), bodyMat);
  roof.position.set(-3, 20.2, 0);
  group.add(roof);

  const wheelGeo = new THREE.CylinderGeometry(5, 5, 4, 12);
  for (const [wx, wz] of [[14, 12], [14, -12], [-14, 12], [-14, -12]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 5, wz);
    group.add(w);
  }

  const head = new THREE.MeshBasicMaterial({ color: 0xfef08a });
  const tail = new THREE.MeshBasicMaterial({ color: 0xef4444 });
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 3, 5), head);
    hl.position.set(23.2, 9, s * 8);
    group.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 3, 5), tail);
    tl.position.set(-23.2, 9, s * 8);
    group.add(tl);
  }
  return { group, bodyMat };
}

function makeTextSprite(text: string, color: string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const x = c.getContext("2d");
  if (x) {
    x.font = "800 40px 'Plus Jakarta Sans', sans-serif";
    x.textAlign = "center";
    x.lineWidth = 7;
    x.strokeStyle = "rgba(0,0,0,0.75)";
    x.strokeText(text, 128, 46);
    x.fillStyle = color;
    x.fillText(text, 128, 46);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(72, 18, 1);
  sprite.renderOrder = 10;
  return sprite;
}

interface Props {
  onEvent: (e: SimEvent) => void;
}

export default function Simulation({ onEvent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Sim>(newSim());
  const keysRef = useRef<Set<string>>(new Set());
  const yawRef = useRef(0.5); // user-controlled camera yaw (on foot)
  const dragRef = useRef<{ x: number } | null>(null);
  const bigRef = useRef<HTMLCanvasElement>(null);
  const mapOpenRef = useRef(false);
  const waypointRef = useRef<{ x: number; y: number } | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [status, setStatus] = useState<Status>("ready");
  const [mapOpen, setMapOpen] = useState(false);
  const [wpDist, setWpDist] = useState<number | null>(null);
  const [endReason, setEndReason] = useState<EndReason>("time");
  const [hud, setHud] = useState({ coins: 0, time: ROUND_SECONDS, speed: 0, near: false, inCar: false });
  const [best, setBest] = useState(() => parseInt(localStorage.getItem("arena_sim_best") || "0", 10));

  const start = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "ready") return;
    g.status = "playing";
    setStatus("playing");
    onEventRef.current("start");
  }, []);

  const toggleMap = useCallback((open?: boolean) => {
    if (gameRef.current.status !== "playing") return;
    const next = open ?? !mapOpenRef.current;
    mapOpenRef.current = next;
    keysRef.current.clear();
    setMapOpen(next);
  }, []);

  const restart = useCallback(() => {
    const old = gameRef.current;
    for (const t of old.texts) {
      t.sprite.material.map?.dispose();
      t.sprite.material.dispose();
      t.sprite.removeFromParent();
    }
    const g = newSim();
    g.status = "playing";
    gameRef.current = g;
    keysRef.current.clear();
    mapOpenRef.current = false;
    waypointRef.current = null;
    setMapOpen(false);
    setWpDist(null);
    setStatus("playing");
    setEndReason("time");
    setHud({ coins: 0, time: ROUND_SECONDS, speed: 0, near: false, inCar: false });
    onEventRef.current("start");
  }, []);

  // Keyboard input
  useEffect(() => {
    const GAME_KEYS = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "ShiftLeft", "ShiftRight", "KeyE", "KeyM", "Escape", "Space", "Enter",
    ]);
    const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

    const down = (e: KeyboardEvent) => {
      if (!GAME_KEYS.has(e.code)) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (tag === "BUTTON" && (e.code === "Enter" || e.code === "Space")) return;
      e.preventDefault();
      const g = gameRef.current;
      if (e.code === "KeyM" && !e.repeat) {
        toggleMap();
        return;
      }
      if (e.code === "Escape") {
        toggleMap(false);
        return;
      }
      if (mapOpenRef.current) return;
      keysRef.current.add(e.code);

      if (g.status === "ready" && (MOVE_KEYS.has(e.code) || e.code === "Enter" || e.code === "Space")) {
        start();
        return;
      }
      if (e.code === "KeyE" && !e.repeat && g.status === "playing") {
        if (g.inCar) {
          const c = g.inCar;
          const side = c.angle + Math.PI / 2;
          const p = { x: c.x + Math.cos(side) * 34, y: c.y + Math.sin(side) * 34 };
          resolveCircle(p, FOOT_R);
          g.px = p.x;
          g.py = p.y;
          g.face = c.angle;
          // Camera orbit starts from where it was looking.
          c.speed = 0;
          g.inCar = null;
          onEventRef.current("exit");
        } else if (g.nearCar) {
          g.inCar = g.nearCar;
          g.nearCar = null;
          onEventRef.current("enter");
        }
      }
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const blur = () => keysRef.current.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [start, toggleMap]);

  // 3D scene + game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const mini = miniRef.current;
    const big = bigRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(VW, VH, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const SKY = 0x9ec9f0;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 450, 1500);

    const camera = new THREE.PerspectiveCamera(60, VW / VH, 1, 4000);

    // Lights
    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a5568, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -300;
    sun.shadow.camera.right = 300;
    sun.shadow.camera.top = 300;
    sun.shadow.camera.bottom = -300;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 1400;
    sun.shadow.bias = -0.0006;
    scene.add(sun);
    scene.add(sun.target);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // Ground
    const grass = new THREE.Mesh(
      track(new THREE.PlaneGeometry(9000, 9000)),
      track(new THREE.MeshLambertMaterial({ color: 0x3f7d4a })),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(WORLD_W / 2, -1, WORLD_H / 2);
    scene.add(grass);

    const asphalt = new THREE.Mesh(
      track(new THREE.PlaneGeometry(WORLD_W, WORLD_H)),
      track(new THREE.MeshLambertMaterial({ color: 0x2e323d })),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.set(WORLD_W / 2, 0, WORLD_H / 2);
    asphalt.receiveShadow = true;
    scene.add(asphalt);

    // Road markings (instanced)
    const dummy = new THREE.Object3D();
    const dashH: THREE.Vector3[] = [];
    const dashV: THREE.Vector3[] = [];
    for (let j = 0; j <= ROWS; j++) {
      for (let x = 9; x < WORLD_W; x += 34) {
        if (x % CELL < ROAD) continue;
        dashH.push(new THREE.Vector3(x, 0.2, j * CELL + ROAD / 2));
      }
    }
    for (let i = 0; i <= COLS; i++) {
      for (let y = 9; y < WORLD_H; y += 34) {
        if (y % CELL < ROAD) continue;
        dashV.push(new THREE.Vector3(i * CELL + ROAD / 2, 0.2, y));
      }
    }
    const yellow = track(new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
    const dashesH = new THREE.InstancedMesh(track(new THREE.BoxGeometry(18, 0.3, 3)), yellow, dashH.length);
    dashH.forEach((p, k) => {
      dummy.position.copy(p);
      dummy.updateMatrix();
      dashesH.setMatrixAt(k, dummy.matrix);
    });
    scene.add(dashesH);
    const dashesV = new THREE.InstancedMesh(track(new THREE.BoxGeometry(3, 0.3, 18)), yellow, dashV.length);
    dashV.forEach((p, k) => {
      dummy.position.copy(p);
      dummy.updateMatrix();
      dashesV.setMatrixAt(k, dummy.matrix);
    });
    scene.add(dashesV);

    const stripes: Array<[number, number, number, number]> = [];
    for (let i = 0; i <= COLS; i++) {
      for (let j = 0; j <= ROWS; j++) {
        const ox = i * CELL;
        const oy = j * CELL;
        for (let k = 0; k < 6; k++) {
          stripes.push([ox + 12 + k * 15, oy + 6, 8, 9]);
          stripes.push([ox + 12 + k * 15, oy + ROAD - 6, 8, 9]);
          stripes.push([ox + 6, oy + 12 + k * 15, 9, 8]);
          stripes.push([ox + ROAD - 6, oy + 12 + k * 15, 9, 8]);
        }
      }
    }
    const white = track(new THREE.MeshBasicMaterial({ color: 0xd9dee6 }));
    const zebra = new THREE.InstancedMesh(track(new THREE.BoxGeometry(1, 0.25, 1)), white, stripes.length);
    stripes.forEach(([sx, sz, w, d], k) => {
      dummy.position.set(sx, 0.2, sz);
      dummy.scale.set(w, 1, d);
      dummy.updateMatrix();
      zebra.setMatrixAt(k, dummy.matrix);
    });
    dummy.scale.set(1, 1, 1);
    scene.add(zebra);

    // Sidewalk blocks
    const walkMat = track(new THREE.MeshLambertMaterial({ color: 0x9aa2af }));
    const walkGeo = track(new THREE.BoxGeometry(BLOCK, 2, BLOCK));
    for (const b of BLOCKS) {
      const m = new THREE.Mesh(walkGeo, walkMat);
      m.position.set(b.x + BLOCK / 2, 1, b.y + BLOCK / 2);
      m.receiveShadow = true;
      scene.add(m);
    }

    // Parks
    const parkMat = track(new THREE.MeshLambertMaterial({ color: 0x2f8a4b }));
    const pathMat = track(new THREE.MeshLambertMaterial({ color: 0xc8b88a }));
    const trunkMat = track(new THREE.MeshLambertMaterial({ color: 0x6b4423 }));
    const leafMats = [0x1f7a3a, 0x2c9a50, 0x37a85c].map((c) => track(new THREE.MeshLambertMaterial({ color: c })));
    const trunkGeo = track(new THREE.CylinderGeometry(3, 4, 18, 8));
    const leafGeo = track(new THREE.ConeGeometry(16, 38, 10));
    const waterMat = track(new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
    for (const p of PARKS) {
      const lawn = new THREE.Mesh(track(new THREE.BoxGeometry(BLOCK - 20, 1, BLOCK - 20)), parkMat);
      lawn.position.set(p.x + BLOCK / 2, 2.3, p.y + BLOCK / 2);
      lawn.receiveShadow = true;
      scene.add(lawn);
      const pathA = new THREE.Mesh(track(new THREE.BoxGeometry(BLOCK - 20, 1, 16)), pathMat);
      pathA.position.set(p.x + BLOCK / 2, 2.9, p.y + BLOCK / 2);
      scene.add(pathA);
      const pathB = new THREE.Mesh(track(new THREE.BoxGeometry(16, 1, BLOCK - 20)), pathMat);
      pathB.position.set(p.x + BLOCK / 2, 2.9, p.y + BLOCK / 2);
      scene.add(pathB);
      const fountain = new THREE.Mesh(track(new THREE.CylinderGeometry(24, 26, 8, 24)), waterMat);
      fountain.position.set(p.x + BLOCK / 2, 6, p.y + BLOCK / 2);
      fountain.castShadow = true;
      scene.add(fountain);
      const jet = new THREE.Mesh(track(new THREE.CylinderGeometry(3, 5, 22, 10)), pathMat);
      jet.position.set(p.x + BLOCK / 2, 16, p.y + BLOCK / 2);
      scene.add(jet);
      [[50, 50], [250, 60], [60, 245], [245, 240], [100, 110], [200, 190]].forEach(([tx, ty], k) => {
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(p.x + tx, 12, p.y + ty);
        trunk.castShadow = true;
        scene.add(trunk);
        const leaves = new THREE.Mesh(leafGeo, leafMats[k % 3]);
        leaves.position.set(p.x + tx, 40, p.y + ty);
        leaves.castShadow = true;
        scene.add(leaves);
      });
    }

    // Buildings with lit-window facades
    const facadeCache = new Map<number, THREE.CanvasTexture>();
    const facadeFor = (hue: number, rx: number, ry: number) => {
      const key = Math.round(hue / 30) * 30;
      let base = facadeCache.get(key);
      if (!base) {
        base = track(makeFacade(key));
        facadeCache.set(key, base);
      }
      const t = base.clone();
      t.repeat.set(rx, ry);
      t.needsUpdate = true;
      return track(t);
    };
    for (const b of BUILDINGS) {
      const ry = Math.max(1, Math.round(b.height / 56));
      const sideX = track(new THREE.MeshLambertMaterial({ map: facadeFor(b.hue, Math.max(1, Math.round(b.h / 56)), ry) }));
      const sideZ = track(new THREE.MeshLambertMaterial({ map: facadeFor(b.hue, Math.max(1, Math.round(b.w / 56)), ry) }));
      const roof = track(new THREE.MeshLambertMaterial({ color: new THREE.Color(`hsl(${b.hue}, 18%, 30%)`) }));
      const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(b.w, b.height, b.h)), [sideX, sideX, roof, roof, sideZ, sideZ]);
      mesh.position.set(b.x + b.w / 2, b.height / 2 + 2, b.y + b.h / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const ac = new THREE.Mesh(track(new THREE.BoxGeometry(18, 8, 18)), roof);
      ac.position.set(b.x + b.w * 0.3, b.height + 6, b.y + b.h * 0.35);
      ac.castShadow = true;
      scene.add(ac);
    }

    // Coins
    const g0 = gameRef.current;
    const coinMeshes: THREE.Mesh[] = g0.coinList.map(() => {
      const m = new THREE.Mesh(track(new THREE.CylinderGeometry(1, 1, 0.25, 20)), track(new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0xb88900, metalness: 0.6, roughness: 0.3 })));
      m.rotation.z = Math.PI / 2;
      m.castShadow = true;
      scene.add(m);
      return m;
    });
    const goldMat = track(new THREE.MeshStandardMaterial({ color: 0xfb923c, emissive: 0xc2410c, metalness: 0.6, roughness: 0.3 }));
    const yellowCoinMat = coinMeshes[0].material as THREE.MeshStandardMaterial;
    const coinPivots = coinMeshes.map((m) => {
      const p = new THREE.Group();
      scene.remove(m);
      p.add(m);
      scene.add(p);
      return p;
    });

    // Vehicles
    const parkedRigs = g0.parked.map((c) => {
      const r = makeCar(c.color);
      scene.add(r.group);
      return r;
    });
    const trafficRigs = g0.traffic.map((c) => {
      const r = makeCar(c.color);
      scene.add(r.group);
      return r;
    });

    // Pedestrians + the player
    const pedRigs = g0.peds.map((_, i) => {
      const r = makeHuman(PED_COLORS[i % PED_COLORS.length], PED_LEGS[i % PED_LEGS.length], PED_SKINS[i % PED_SKINS.length], 1.2);
      scene.add(r.group);
      return r;
    });
    const player = makeHuman(0x0d69ac, 0x4b974b, 0xf5cd30, 1.4);
    scene.add(player.group);

    // Particles (instanced cubes)
    const MAXP = 260;
    const partMesh = new THREE.InstancedMesh(track(new THREE.BoxGeometry(1, 1, 1)), track(new THREE.MeshBasicMaterial()), MAXP);
    partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    partMesh.frustumCulled = false;
    for (let i = 0; i < MAXP; i++) partMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    scene.add(partMesh);

    const sparks = (g: Sim, x: number, z: number, h: number, color: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(40, 150);
        g.particles.push({
          x, z, h,
          vx: Math.cos(a) * s,
          vz: Math.sin(a) * s,
          vh: rand(60, 200),
          life: 0,
          max: rand(0.4, 0.8),
          size: rand(2, 4.5),
          color: new THREE.Color(color),
        });
      }
    };
    const addText = (g: Sim, text: string, color: string, x: number, z: number) => {
      const sprite = makeTextSprite(text, color);
      scene.add(sprite);
      g.texts.push({ sprite, x, z, life: 0 });
    };

    // Radar + full map canvases (2D overlays)
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rctx = mini ? mini.getContext("2d") : null;
    if (mini) {
      mini.width = RADAR * dpr;
      mini.height = RADAR * dpr;
    }
    const bctx = big ? big.getContext("2d") : null;
    if (big) {
      big.width = VW * dpr;
      big.height = VH * dpr;
    }

    // Waypoint beam (shown in the 3D world when a waypoint is set)
    const beamMat = track(new THREE.MeshBasicMaterial({ color: 0xff3d9a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    const beam = new THREE.Mesh(track(new THREE.CylinderGeometry(7, 7, 700, 20, 1, true)), beamMat);
    beam.visible = false;
    scene.add(beam);
    const ringMat = track(new THREE.MeshBasicMaterial({ color: 0xff3d9a, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    const wpRing = new THREE.Mesh(track(new THREE.RingGeometry(14, 20, 32)), ringMat);
    wpRing.rotation.x = -Math.PI / 2;
    wpRing.visible = false;
    scene.add(wpRing);

    // Smoothed camera state
    const camPos = new THREE.Vector3(CELL + 50, 120, CELL + 200);
    const camLook = new THREE.Vector3(CELL + 50, 20, CELL + 50);
    let camYaw = yawRef.current;
    let lastCarYaw = 0;

    let raf = 0;
    let last = performance.now();
    let hudTimer = 0;

    const endRound = (g: Sim, reason: EndReason) => {
      if (g.status !== "playing") return;
      g.status = "over";
      g.endReason = reason;
      g.crashT = 0;
      keysRef.current.clear();
      mapOpenRef.current = false;
      setMapOpen(false);
      const final = g.coins;
      setStatus("over");
      setEndReason(reason);
      setHud({ coins: final, time: Math.max(0, Math.ceil(g.time)), speed: 0, near: false, inCar: !!g.inCar });
      setBest((prev) => {
        if (final > prev) {
          localStorage.setItem("arena_sim_best", final.toString());
          return final;
        }
        return prev;
      });
      onEventRef.current(reason === "time" ? "end" : "hit");
    };

    const frame = (now: number) => {
      const rawDt = Math.min(0.05, (now - last) / 1000);
      const dt = mapOpenRef.current ? 0 : rawDt;
      last = now;
      const g = gameRef.current;
      const keys = keysRef.current;
      const playing = g.status === "playing";

      const ix = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      const iy = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
      const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");

      // ---------- player ----------
      let moving = false;
      if (playing) {
        g.time -= dt;
        if (g.inCar) {
          const car = g.inCar;
          const throttle = -iy;
          if (throttle > 0) car.speed += CAR_ACC * dt;
          else if (throttle < 0) car.speed -= (car.speed > 0 ? 560 : CAR_ACC) * dt;
          else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 180 * dt);
          car.speed = clamp(car.speed, -CAR_REV, CAR_MAX);
          car.angle += ix * 2.5 * Math.min(1, Math.abs(car.speed) / 140) * Math.sign(car.speed) * dt;
          car.x += Math.cos(car.angle) * car.speed * dt;
          car.y += Math.sin(car.angle) * car.speed * dt;
          if (resolveCircle(car, CAR_R)) {
            if (Math.abs(car.speed) > 120) g.shake = 0.2;
            car.speed *= -0.25;
          }
          g.px = car.x;
          g.py = car.y;
          g.face = car.angle;
        } else {
          // Movement is relative to the camera.
          const fx = -Math.sin(camYaw);
          const fz = -Math.cos(camYaw);
          const rx = Math.cos(camYaw);
          const rz = -Math.sin(camYaw);
          let dx = fx * -iy + rx * ix;
          let dy = fz * -iy + rz * ix;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            dx /= len;
            dy /= len;
            moving = true;
            const sp = sprint ? SPRINT : WALK;
            const p = { x: g.px + dx * sp * dt, y: g.py + dy * sp * dt };
            resolveCircle(p, FOOT_R);
            g.px = p.x;
            g.py = p.y;
            const target = Math.atan2(dy, dx);
            g.face += angleDiff(target, g.face) * Math.min(1, dt * 14);
            g.walk += dt * (sprint ? 20 : 13);
          }
        }
      }

      // Nearest parked car (to hop into)
      g.nearCar = null;
      if (!g.inCar && playing) {
        let bd = 50;
        for (const c of g.parked) {
          const d = Math.hypot(c.x - g.px, c.y - g.py);
          if (d < bd) {
            bd = d;
            g.nearCar = c;
          }
        }
      }

      // ---------- traffic ----------
      for (const c of g.traffic) {
        c.x += Math.cos(c.angle) * c.speed * dt;
        c.y += Math.sin(c.angle) * c.speed * dt;
        if (c.x > WORLD_W + 60) c.x = -60;
        else if (c.x < -60) c.x = WORLD_W + 60;
        if (c.y > WORLD_H + 60) c.y = -60;
        else if (c.y < -60) c.y = WORLD_H + 60;
      }

      // ---------- pedestrians ----------
      g.peds.forEach((p, idx) => {
        if (idx === g.crashPed) return; // knocked down
        p.t -= dt;
        if (p.t <= 0) {
          const a = Math.random() * Math.PI * 2;
          const s = Math.random() < 0.3 ? 0 : rand(25, 50);
          p.vx = Math.cos(a) * s;
          p.vy = Math.sin(a) * s;
          p.t = rand(1, 3);
        }
        const dpx = p.x - g.px;
        const dpy = p.y - g.py;
        const dist = Math.hypot(dpx, dpy);
        let vx = p.vx;
        let vy = p.vy;
        const scare = g.inCar ? 90 : 70;
        if (dist < scare && dist > 0.1 && g.status === "playing") {
          vx = (dpx / dist) * 110;
          vy = (dpy / dist) * 110;
        }
        p.x += vx * dt;
        p.y += vy * dt;
        p.phase += dt * (Math.hypot(vx, vy) > 5 ? 10 : 0);
        if (resolveCircle(p, PED_R)) p.t = 0;
      });

      // ---------- hazards ----------
      g.invuln = Math.max(0, g.invuln - dt);
      if (playing) {
        const pr = g.inCar ? CAR_R : FOOT_R;

        // Driving into a pedestrian ends the round.
        if (g.inCar && Math.abs(g.inCar.speed) > 30) {
          for (let k = 0; k < g.peds.length; k++) {
            const p = g.peds[k];
            if (Math.hypot(p.x - g.px, p.y - g.py) < CAR_R + PED_R) {
              g.crashPed = k;
              g.shake = 0.7;
              sparks(g, p.x, p.y, 20, 0xf87171, 24);
              endRound(g, "ped");
              break;
            }
          }
        }

        // Traffic hitting the player.
        if (g.status === "playing" && g.invuln <= 0) {
          for (const c of g.traffic) {
            const dx = g.px - c.x;
            const dy = g.py - c.y;
            const d = Math.hypot(dx, dy);
            if (d >= pr + CAR_R) continue;
            if (!g.inCar) {
              g.shake = 0.7;
              sparks(g, g.px, g.py, 20, 0xf87171, 28);
              endRound(g, "foot"); // a car hit the person: game over
            } else {
              const loss = Math.min(g.coins, 3);
              g.coins -= loss;
              g.invuln = 1.5;
              g.shake = 0.4;
              const nx = d > 0.1 ? dx / d : 1;
              const ny = d > 0.1 ? dy / d : 0;
              g.inCar.speed *= -0.4;
              g.inCar.x += nx * 40;
              g.inCar.y += ny * 40;
              resolveCircle(g.inCar, CAR_R);
              g.px = g.inCar.x;
              g.py = g.inCar.y;
              sparks(g, g.px, g.py, 14, 0xfbbf24, 18);
              addText(g, loss ? `-${loss} coins` : "CRASH!", "#f87171", g.px, g.py);
              onEventRef.current("hit");
            }
            break;
          }
        }
      }

      // ---------- coins ----------
      if (g.status === "playing") {
        const pr = g.inCar ? CAR_R : FOOT_R;
        for (const c of g.coinList) {
          if (Math.hypot(c.x - g.px, c.y - g.py) < pr + 12) {
            g.coins += c.v;
            const gold = c.v > 1;
            sparks(g, c.x, c.y, 14, gold ? 0xfb923c : 0xfde047, gold ? 18 : 10);
            addText(g, `+${c.v}`, gold ? "#fb923c" : "#fde047", c.x, c.y);
            const np = randomPos(g.px, g.py, 300);
            c.x = np.x;
            c.y = np.y;
            c.v = Math.random() < 0.1 ? 5 : 1;
            onEventRef.current(gold ? "gold" : "coin");
          }
        }
      }

      g.shake = Math.max(0, g.shake - dt);
      if (g.status === "over") g.crashT += dt;

      // ---------- round end by time ----------
      if (g.status === "playing" && g.time <= 0) {
        g.time = 0;
        endRound(g, "time");
      }

      // ---------- HUD (throttled) ----------
      hudTimer += dt;
      if (hudTimer > 0.1 && g.status === "playing") {
        hudTimer = 0;
        setHud({
          coins: g.coins,
          time: Math.ceil(g.time),
          speed: g.inCar ? Math.round(Math.abs(g.inCar.speed) * 0.3) : 0,
          near: !!g.nearCar,
          inCar: !!g.inCar,
        });
        const w = waypointRef.current;
        setWpDist(w ? Math.round(Math.hypot(w.x - g.px, w.y - g.py) / 5) : null);
      }

      // ================= SYNC SCENE =================
      // Player
      player.group.visible = !g.inCar;
      player.group.position.set(g.px, 0, g.py);
      player.group.rotation.y = -g.face;
      const sw = moving ? Math.sin(g.walk) * 0.9 : 0;
      player.legL.rotation.z = sw;
      player.legR.rotation.z = -sw;
      player.armL.rotation.z = -sw;
      player.armR.rotation.z = sw;
      const blink = g.invuln > 0 && g.status === "playing" && Math.floor(now / 90) % 2 === 0;
      if (blink) player.group.visible = false;
      // Knocked-down animation
      const fall = g.status === "over" && g.endReason === "foot" ? Math.min(1, g.crashT * 3) : 0;
      player.body.rotation.z = -fall * (Math.PI / 2);
      player.body.position.y = fall * 5;

      // Vehicles
      g.parked.forEach((c, i) => {
        const r = parkedRigs[i];
        r.group.position.set(c.x, 2, c.y);
        r.group.rotation.y = -c.angle;
        r.bodyMat.emissive.setHex(c === g.nearCar ? 0x6b5d00 : 0x000000);
      });
      g.traffic.forEach((c, i) => {
        const r = trafficRigs[i];
        r.group.position.set(c.x, 2, c.y);
        r.group.rotation.y = -c.angle;
        r.bodyMat.color.set(c.color);
      });

      // Pedestrians
      g.peds.forEach((p, i) => {
        const r = pedRigs[i];
        r.group.position.set(p.x, 0, p.y);
        const spd = Math.hypot(p.vx, p.vy);
        if (spd > 5) r.group.rotation.y = -Math.atan2(p.vy, p.vx);
        const s = spd > 5 ? Math.sin(p.phase) * 0.8 : 0;
        r.legL.rotation.z = s;
        r.legR.rotation.z = -s;
        r.armL.rotation.z = -s;
        r.armR.rotation.z = s;
        const down = i === g.crashPed ? Math.min(1, g.crashT * 3 + 0.3) : 0;
        r.body.rotation.z = -down * (Math.PI / 2);
        r.body.position.y = down * 5;
      });

      // Coins
      g.coinList.forEach((c, i) => {
        const gold = c.v > 1;
        const pivot = coinPivots[i];
        const m = coinMeshes[i];
        const s = gold ? 11 : 8;
        m.scale.set(s, s, s);
        m.material = gold ? goldMat : yellowCoinMat;
        pivot.position.set(c.x, 18 + Math.sin(now / 280 + c.ph) * 3, c.y);
        pivot.rotation.y = now / 450 + c.ph;
      });

      // Particles
      for (const p of g.particles) {
        p.life += dt;
        p.vh -= 420 * dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.h = Math.max(0.5, p.h + p.vh * dt);
        p.vx *= 0.97;
        p.vz *= 0.97;
      }
      g.particles = g.particles.filter((p) => p.life < p.max);
      for (let i = 0; i < MAXP; i++) {
        const p = g.particles[i];
        if (p) {
          const k = 1 - p.life / p.max;
          dummy.position.set(p.x, p.h, p.z);
          dummy.scale.setScalar(p.size * (0.4 + k * 0.6));
          partMesh.setColorAt(i, p.color);
        } else {
          dummy.position.set(0, -50, 0);
          dummy.scale.setScalar(0.0001);
        }
        dummy.updateMatrix();
        partMesh.setMatrixAt(i, dummy.matrix);
      }
      partMesh.instanceMatrix.needsUpdate = true;
      if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true;
      dummy.scale.set(1, 1, 1);

      // Floating texts
      for (const t of g.texts) {
        t.life += dt;
        t.sprite.position.set(t.x, 38 + t.life * 40, t.z);
        t.sprite.material.opacity = Math.max(0, 1 - t.life);
      }
      g.texts = g.texts.filter((t) => {
        if (t.life < 1) return true;
        t.sprite.material.map?.dispose();
        t.sprite.material.dispose();
        t.sprite.removeFromParent();
        return false;
      });

      // Waypoint beam
      const wp0 = waypointRef.current;
      if (wp0 && g.status === "playing" && Math.hypot(wp0.x - g.px, wp0.y - g.py) < 40) {
        waypointRef.current = null;
        setWpDist(null);
        addText(g, "ARRIVED", "#f472b6", g.px, g.py);
      }
      const wp = waypointRef.current;
      beam.visible = !!wp;
      wpRing.visible = !!wp;
      if (wp) {
        beam.position.set(wp.x, 350, wp.y);
        wpRing.position.set(wp.x, 3, wp.y);
        const pulse = 1 + Math.sin(now / 220) * 0.18;
        wpRing.scale.set(pulse, pulse, 1);
        beamMat.opacity = 0.28 + Math.sin(now / 300) * 0.08;
      }

      // ---------- Camera ----------
      let targetYaw = camYaw;
      let dist = 140;
      let height = 105;
      let lookUp = 20;
      const subject = g.inCar ?? null;
      if (subject) {
        // Chase camera: sit behind the car and follow its heading.
        const fx = Math.cos(subject.angle);
        const fz = Math.sin(subject.angle);
        const carYaw = Math.atan2(-fx, -fz);
        // Keep the yaw continuous across the ±π wrap.
        lastCarYaw += angleDiff(carYaw, lastCarYaw);
        targetYaw = lastCarYaw;
        dist = 125 + Math.min(40, Math.abs(subject.speed) * 0.1);
        height = 65;
        lookUp = 14;
      } else {
        if (g.status === "ready") yawRef.current += dt * 0.15; // idle orbit
        targetYaw = yawRef.current;
        lastCarYaw = camYaw;
      }
      camYaw += angleDiff(targetYaw, camYaw) * Math.min(1, dt * (subject ? 5 : 10));

      const tx = g.px + Math.sin(camYaw) * dist;
      const tz = g.py + Math.cos(camYaw) * dist;
      const k = Math.min(1, dt * 7);
      camPos.x += (tx - camPos.x) * k;
      camPos.y += (height - camPos.y) * k;
      camPos.z += (tz - camPos.z) * k;
      const ahead = subject ? 45 : 0;
      camLook.x += (g.px + Math.cos(g.face) * ahead - camLook.x) * k;
      camLook.y += (lookUp - camLook.y) * k;
      camLook.z += (g.py + Math.sin(g.face) * ahead - camLook.z) * k;

      camera.position.copy(camPos);
      if (g.shake > 0) {
        camera.position.x += (Math.random() - 0.5) * g.shake * 16;
        camera.position.y += (Math.random() - 0.5) * g.shake * 16;
      }
      camera.lookAt(camLook);

      sun.position.set(g.px + 180, 420, g.py + 140);
      sun.target.position.set(g.px, 0, g.py);

      renderer.render(scene, camera);

      // ---------- GTA-style radar (rotates with the camera) ----------
      if (rctx) {
        const RR = RADAR / 2;
        const sc = RR / RADAR_RANGE;
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, RADAR, RADAR);
        rctx.save();
        rctx.beginPath();
        rctx.arc(RR, RR, RR - 2, 0, Math.PI * 2);
        rctx.clip();
        rctx.fillStyle = "#161b26";
        rctx.fillRect(0, 0, RADAR, RADAR);
        rctx.translate(RR, RR);
        rctx.rotate(camYaw);
        rctx.scale(sc, sc);
        rctx.translate(-g.px, -g.py);
        rctx.fillStyle = "#4a505e"; // roads
        rctx.fillRect(0, 0, WORLD_W, WORLD_H);
        rctx.fillStyle = "#6b7280"; // sidewalks
        for (const b of BLOCKS) rctx.fillRect(b.x + 3, b.y + 3, BLOCK - 6, BLOCK - 6);
        rctx.fillStyle = "#3f8a52"; // parks
        for (const pk of PARKS) rctx.fillRect(pk.x + 8, pk.y + 8, BLOCK - 16, BLOCK - 16);
        for (const b of BUILDINGS) {
          rctx.fillStyle = `hsl(${b.hue} 25% 42%)`;
          rctx.fillRect(b.x, b.y, b.w, b.h);
        }
        for (const c of g.coinList) {
          rctx.fillStyle = c.v > 1 ? "#fb923c" : "#fde047";
          rctx.beginPath();
          rctx.arc(c.x, c.y, (c.v > 1 ? 16 : 12) , 0, Math.PI * 2);
          rctx.fill();
        }
        rctx.fillStyle = "#e5e7eb";
        for (const c of g.traffic) rctx.fillRect(c.x - 12, c.y - 8, 24, 16);
        rctx.fillStyle = "#38bdf8";
        for (const c of g.parked) rctx.fillRect(c.x - 14, c.y - 9, 28, 18);
        rctx.save();
        rctx.translate(g.px, g.py);
        rctx.rotate(g.face);
        rctx.fillStyle = "#ef4444";
        rctx.strokeStyle = "#fff";
        rctx.lineWidth = 5;
        rctx.beginPath();
        rctx.moveTo(30, 0);
        rctx.lineTo(-20, 18);
        rctx.lineTo(-10, 0);
        rctx.lineTo(-20, -18);
        rctx.closePath();
        rctx.fill();
        rctx.stroke();
        rctx.restore();
        rctx.restore();

        // Waypoint marker (clamped to the radar edge)
        const wr = waypointRef.current;
        if (wr) {
          const dx = wr.x - g.px;
          const dy = wr.y - g.py;
          let rx = (dx * Math.cos(camYaw) - dy * Math.sin(camYaw)) * sc;
          let ry = (dx * Math.sin(camYaw) + dy * Math.cos(camYaw)) * sc;
          const rl = Math.hypot(rx, ry);
          const lim = RR - 9;
          if (rl > lim) {
            rx = (rx / rl) * lim;
            ry = (ry / rl) * lim;
          }
          rctx.save();
          rctx.translate(RR + rx, RR + ry);
          rctx.rotate(Math.PI / 4);
          rctx.fillStyle = "#ff3d9a";
          rctx.strokeStyle = "#fff";
          rctx.lineWidth = 2;
          rctx.fillRect(-5, -5, 10, 10);
          rctx.strokeRect(-5, -5, 10, 10);
          rctx.restore();
        }

        // Ring + north marker
        rctx.strokeStyle = "rgba(255,255,255,0.9)";
        rctx.lineWidth = 3;
        rctx.beginPath();
        rctx.arc(RR, RR, RR - 2, 0, Math.PI * 2);
        rctx.stroke();
        const nx = RR + Math.sin(camYaw) * (RR - 13);
        const ny = RR - Math.cos(camYaw) * (RR - 13);
        rctx.fillStyle = "rgba(0,0,0,0.65)";
        rctx.beginPath();
        rctx.arc(nx, ny, 8, 0, Math.PI * 2);
        rctx.fill();
        rctx.fillStyle = "#fff";
        rctx.font = "800 11px 'Plus Jakarta Sans', sans-serif";
        rctx.textAlign = "center";
        rctx.textBaseline = "middle";
        rctx.fillText("N", nx, ny + 0.5);
      }

      // ---------- Full-screen map (M) ----------
      if (bctx && mapOpenRef.current) {
        const S = BM_S;
        const c = bctx;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = "#0e2438";
        c.fillRect(0, 0, VW, VH);
        c.textBaseline = "alphabetic";
        c.textAlign = "left";
        c.fillStyle = "#fff";
        c.font = "800 24px 'Plus Jakarta Sans', sans-serif";
        c.fillText("COIN CITY", BM_OX, 46);
        c.fillStyle = "rgba(255,255,255,0.65)";
        c.font = "600 12px 'Plus Jakarta Sans', sans-serif";
        c.fillText("Click the map to set a waypoint  ·  click it again to clear  ·  M / Esc to close", BM_OX, 68);

        c.save();
        c.translate(BM_OX, BM_OY);
        c.scale(S, S);
        c.fillStyle = "#f6f3ea"; // roads
        c.fillRect(0, 0, WORLD_W, WORLD_H);
        for (const b of BLOCKS) {
          c.fillStyle = "#d8d1ba";
          c.fillRect(b.x + 5, b.y + 5, BLOCK - 10, BLOCK - 10);
        }
        for (const pk of PARKS) {
          c.fillStyle = "#a6d08b";
          c.fillRect(pk.x + 5, pk.y + 5, BLOCK - 10, BLOCK - 10);
          c.fillStyle = "#86c3e6";
          c.beginPath();
          c.arc(pk.x + BLOCK / 2, pk.y + BLOCK / 2, 26, 0, Math.PI * 2);
          c.fill();
        }
        for (const b of BUILDINGS) {
          c.fillStyle = "#b9b198";
          c.fillRect(b.x, b.y, b.w, b.h);
        }
        const blip = (x: number, y: number, r: number, color: string) => {
          c.fillStyle = color;
          c.strokeStyle = "rgba(0,0,0,0.55)";
          c.lineWidth = 1.2 / S;
          c.beginPath();
          c.arc(x, y, r / S, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        };
        for (const co of g.coinList) blip(co.x, co.y, co.v > 1 ? 4.2 : 3, co.v > 1 ? "#fb923c" : "#facc15");
        c.fillStyle = "#2563eb";
        for (const pc of g.parked) c.fillRect(pc.x - 7 / S, pc.y - 4 / S, 14 / S, 8 / S);
        c.restore();

        // Street names
        c.fillStyle = "#7a7560";
        c.font = "700 8px 'Plus Jakarta Sans', sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        for (let j = 0; j <= ROWS; j++) {
          const y = BM_OY + (j * CELL + ROAD / 2) * S;
          c.fillText(`AVENUE ${j + 1}`, BM_OX + WORLD_W * S * 0.3, y);
          c.fillText(`AVENUE ${j + 1}`, BM_OX + WORLD_W * S * 0.78, y);
        }
        for (let i = 0; i <= COLS; i++) {
          const x = BM_OX + (i * CELL + ROAD / 2) * S;
          for (const fy of [0.3, 0.78]) {
            c.save();
            c.translate(x, BM_OY + WORLD_H * S * fy);
            c.rotate(-Math.PI / 2);
            c.fillText(`STREET ${i + 1}`, 0, 0);
            c.restore();
          }
        }
        c.fillStyle = "#3f7a3f";
        c.font = "800 8px 'Plus Jakarta Sans', sans-serif";
        for (const pk of PARKS) c.fillText("FOUNTAIN PARK", BM_OX + (pk.x + BLOCK / 2) * S, BM_OY + (pk.y + BLOCK / 2 + 46) * S);

        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 2;
        c.strokeRect(BM_OX, BM_OY, WORLD_W * S, WORLD_H * S);

        // Waypoint pin
        const wm = waypointRef.current;
        if (wm) {
          const wx = BM_OX + wm.x * S;
          const wy = BM_OY + wm.y * S;
          c.fillStyle = "#ff3d9a";
          c.strokeStyle = "#fff";
          c.lineWidth = 2;
          c.beginPath();
          c.arc(wx, wy - 12, 6, 0, Math.PI * 2);
          c.fill();
          c.stroke();
          c.beginPath();
          c.moveTo(wx - 4, wy - 8);
          c.lineTo(wx, wy);
          c.lineTo(wx + 4, wy - 8);
          c.fill();
        }

        // Player blip
        const ppx = BM_OX + g.px * S;
        const ppy = BM_OY + g.py * S;
        const pulse = 8 + ((now / 60) % 12);
        c.strokeStyle = `rgba(239,68,68,${1 - (pulse - 8) / 12})`;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(ppx, ppy, pulse, 0, Math.PI * 2);
        c.stroke();
        c.save();
        c.translate(ppx, ppy);
        c.rotate(g.face);
        c.fillStyle = "#ef4444";
        c.strokeStyle = "#fff";
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(9, 0);
        c.lineTo(-6, 6);
        c.lineTo(-3, 0);
        c.lineTo(-6, -6);
        c.closePath();
        c.fill();
        c.stroke();
        c.restore();

        // Side panel: legend + trip info
        const px0 = BM_OX + WORLD_W * S + 28;
        c.textAlign = "left";
        c.textBaseline = "alphabetic";
        c.fillStyle = "rgba(255,255,255,0.08)";
        c.beginPath();
        c.roundRect(px0 - 12, BM_OY, VW - px0 - 18, WORLD_H * S, 14);
        c.fill();
        c.fillStyle = "#fff";
        c.font = "800 13px 'Plus Jakarta Sans', sans-serif";
        c.fillText("LEGEND", px0, BM_OY + 26);
        const items: Array<[string, string, string]> = [
          ["circle", "#facc15", "Coin  (+1)"],
          ["circle", "#fb923c", "Gold coin  (+5)"],
          ["car", "#2563eb", "Parked car  (press E)"],
          ["arrow", "#ef4444", "You"],
          ["pin", "#ff3d9a", "Waypoint"],
          ["square", "#a6d08b", "Park"],
        ];
        items.forEach(([kind, col, label], idx) => {
          const iy2 = BM_OY + 52 + idx * 28;
          c.fillStyle = col;
          c.strokeStyle = "rgba(255,255,255,0.8)";
          c.lineWidth = 1.5;
          if (kind === "circle") {
            c.beginPath();
            c.arc(px0 + 8, iy2 - 4, 6, 0, Math.PI * 2);
            c.fill();
            c.stroke();
          } else if (kind === "car") {
            c.fillRect(px0, iy2 - 9, 16, 10);
          } else if (kind === "square") {
            c.fillRect(px0, iy2 - 10, 16, 12);
          } else if (kind === "arrow") {
            c.beginPath();
            c.moveTo(px0 + 16, iy2 - 4);
            c.lineTo(px0, iy2 + 3);
            c.lineTo(px0 + 4, iy2 - 4);
            c.lineTo(px0, iy2 - 11);
            c.closePath();
            c.fill();
            c.stroke();
          } else {
            c.beginPath();
            c.arc(px0 + 8, iy2 - 8, 5, 0, Math.PI * 2);
            c.fill();
            c.stroke();
            c.beginPath();
            c.moveTo(px0 + 4, iy2 - 5);
            c.lineTo(px0 + 8, iy2 + 2);
            c.lineTo(px0 + 12, iy2 - 5);
            c.fill();
          }
          c.fillStyle = "rgba(255,255,255,0.85)";
          c.font = "600 12px 'Plus Jakarta Sans', sans-serif";
          c.fillText(label, px0 + 26, iy2);
        });

        const base = BM_OY + 52 + items.length * 28 + 24;
        c.fillStyle = "#fff";
        c.font = "800 13px 'Plus Jakarta Sans', sans-serif";
        c.fillText("TRIP", px0, base);
        c.font = "600 12px 'Plus Jakarta Sans', sans-serif";
        c.fillStyle = "rgba(255,255,255,0.85)";
        c.fillText(`Coins: ${g.coins}`, px0, base + 24);
        c.fillText(`Time left: ${Math.max(0, Math.ceil(g.time))}s`, px0, base + 46);
        const wd = waypointRef.current;
        c.fillText(wd ? `Waypoint: ${Math.round(Math.hypot(wd.x - g.px, wd.y - g.py) / 5)} m` : "Waypoint: none", px0, base + 68);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      for (const t of gameRef.current.texts) {
        t.sprite.material.map?.dispose();
        t.sprite.material.dispose();
      }
      gameRef.current.texts = [];
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    };
  }, []);

  const urgent = status === "playing" && hud.time <= 10;

  const endTitle = endReason === "time" ? "Time's Up!" : endReason === "foot" ? "Hit by a Car!" : "Game Over!";
  const endText =
    endReason === "time"
      ? "Nice run through the city."
      : endReason === "foot"
        ? "A car ran into you — watch the traffic."
        : "Your car hit a pedestrian. Drive carefully!";

  return (
    <section className="arena-card sim" aria-labelledby="sim-game-title">
      <div className="card-header">
        <div>
          <span className="tag-badge tag-sim">🏙️ 3D Open World</span>
          <h2 id="sim-game-title" className="game-title">
            Simulation
          </h2>
          <p className="game-desc">
            Roam the 3D city on foot or by car and grab as many coins as you can in {ROUND_SECONDS} seconds. If a car
            hits a person, it's game over!
          </p>
        </div>
      </div>

      <div className="stats-bar">
        <div className="stat-item">
          <span className="stat-label">Coins</span>
          <span className="stat-val sim-val">🪙 {hud.coins}</span>
        </div>
        <div className={`stat-item ${urgent ? "combo-hot" : ""}`}>
          <span className="stat-label">Time</span>
          <span className="stat-val sim-val">⏱ {hud.time}s</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">{hud.inCar ? "Speed" : "On foot"}</span>
          <span className="stat-val sim-val">{hud.inCar ? `${hud.speed} km/h` : "🚶"}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Best Record</span>
          <span className="stat-val">{best}</span>
        </div>
      </div>

      <div className="sim-wrap">
        <canvas
          ref={canvasRef}
          id="sim-canvas"
          className="sim-canvas"
          aria-label="3D city simulation game board"
          onPointerDown={(e) => {
            dragRef.current = { x: e.clientX };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            yawRef.current -= (e.clientX - dragRef.current.x) * 0.008;
            dragRef.current.x = e.clientX;
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        />
        <canvas ref={miniRef} className="sim-minimap" aria-hidden="true" />
        {status === "playing" && wpDist !== null && <div className="sim-wp-chip">📍 {wpDist} m</div>}
        {status === "playing" && (
          <button className="sim-map-btn" id="sim-map-btn" onClick={() => toggleMap()}>
            🗺 Map <kbd>M</kbd>
          </button>
        )}
        <canvas
          ref={bigRef}
          className={`sim-bigmap ${mapOpen ? "open" : ""}`}
          aria-label="City map"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const cx = ((e.clientX - rect.left) / rect.width) * VW;
            const cy = ((e.clientY - rect.top) / rect.height) * VH;
            const wx = (cx - BM_OX) / BM_S;
            const wy = (cy - BM_OY) / BM_S;
            if (wx < 0 || wy < 0 || wx > WORLD_W || wy > WORLD_H) return;
            const cur = waypointRef.current;
            if (cur && Math.hypot(cur.x - wx, cur.y - wy) < 60) waypointRef.current = null;
            else waypointRef.current = { x: wx, y: wy };
            onEventRef.current("enter");
          }}
        />

        {status === "playing" && !mapOpen && hud.near && !hud.inCar && <div className="sim-prompt">Press <kbd>E</kbd> to drive</div>}
        {status === "playing" && !mapOpen && hud.inCar && <div className="sim-prompt">Press <kbd>E</kbd> to get out</div>}

        {status === "ready" && (
          <div className="overlay-screen" role="dialog" aria-modal="true">
            <div className="modal-icon">🏙️</div>
            <h3 className="modal-title">Welcome to the City</h3>
            <p className="modal-subtitle">
              Collect coins before time runs out. Hop into any parked car with E — but if a car hits a person, the game
              is over.
            </p>
            <button id="sim-start-btn" className="btn-play-again btn-play-sim" onClick={start}>
              ▶ Start Exploring
            </button>
          </div>
        )}

        {status === "over" && (
          <div className={`overlay-screen ${endReason !== "time" ? "overlay-crash" : ""}`} role="dialog" aria-modal="true">
            <div className="modal-icon">{endReason === "time" ? "⏱️" : "🚨"}</div>
            <h3 className="modal-title">{endTitle}</h3>
            <p className="modal-subtitle">{endText}</p>
            <div className="score-badge-big sim-val">🪙 {hud.coins}</div>
            {hud.coins > 0 && hud.coins >= best && <p className="new-best">🏆 New best score!</p>}
            <button id="sim-retry-btn" className="btn-play-again btn-play-sim" onClick={restart}>
              🔄 Play Again
            </button>
          </div>
        )}
      </div>

      <div className="sim-keys">
        <span>
          <kbd>W</kbd>
          <kbd>A</kbd>
          <kbd>S</kbd>
          <kbd>D</kbd> / arrows — move or drive
        </span>
        <span>
          <kbd>Shift</kbd> — sprint
        </span>
        <span>
          <kbd>E</kbd> — enter / exit car
        </span>
        <span>
          <kbd>M</kbd> — full map &amp; waypoint
        </span>
        <span>🖱 drag — rotate camera (on foot)</span>
      </div>
    </section>
  );
}
