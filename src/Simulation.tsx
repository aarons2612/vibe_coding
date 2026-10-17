import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export type SimEvent = "start" | "coin" | "gold" | "hit" | "end" | "enter" | "exit";

// ---------------------------------------------------------------
// World layout (2D logic plane: x → three.x, y → three.z)
// ---------------------------------------------------------------
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

const RADAR = 170; // radar diameter (css px)
const RADAR_RANGE = 280; // world units from the radar centre to its edge

type CamMode = "chase" | "far" | "first";
const CAM_MODES: CamMode[] = ["chase", "far", "first"];
const CAM_LABEL: Record<CamMode, string> = { chase: "Chase", far: "Overview", first: "First person" };

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
    const hA = 80 + ((i * 5 + j * 11) % 9) * 16;
    const hB = 64 + ((i * 7 + j * 3) % 9) * 18;
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
// Three.js helpers
// ---------------------------------------------------------------
interface FacadePair {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

// Wall texture + matching "lit windows" emissive texture (same window pattern).
function makeFacadePair(hue: number): FacadePair {
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    return c;
  };
  const dc = mk();
  const ec = mk();
  const d = dc.getContext("2d");
  const e = ec.getContext("2d");
  if (d && e) {
    d.fillStyle = `hsl(${hue} 26% 40%)`;
    d.fillRect(0, 0, 128, 128);
    d.fillStyle = `hsl(${hue} 22% 33%)`;
    d.fillRect(0, 120, 128, 8); // floor band
    e.fillStyle = "#000";
    e.fillRect(0, 0, 128, 128);
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 2; k++) {
        const x = 12 + k * 60;
        const y = 12 + r * 60;
        const lit = Math.random() < 0.45;
        d.fillStyle = `hsl(${hue} 20% 22%)`; // frame
        d.fillRect(x - 3, y - 3, 46, 50);
        if (lit) {
          const warm = Math.random() < 0.7 ? "#ffd89a" : "#bfe3ff";
          d.fillStyle = warm;
          d.fillRect(x, y, 40, 44);
          e.fillStyle = warm;
          e.fillRect(x, y, 40, 44);
        } else {
          const g = d.createLinearGradient(0, y, 0, y + 44);
          g.addColorStop(0, "#32476a");
          g.addColorStop(1, "#16202f");
          d.fillStyle = g;
          d.fillRect(x, y, 40, 44);
        }
        d.fillStyle = "rgba(255,255,255,0.16)"; // glass glint
        d.fillRect(x + 4, y + 3, 6, 38);
      }
    }
  }
  const wrap = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: wrap(dc), emissive: wrap(ec) };
}

function makeAsphaltTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#3a3e49";
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const v = Math.floor(rand(40, 95));
      x.fillStyle = `rgba(${v},${v},${v + 6},${rand(0.15, 0.5)})`;
      x.fillRect(Math.random() * 256, Math.random() * 256, rand(1, 2.6), rand(1, 2.6));
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(WORLD_W / 140, WORLD_H / 140);
  return t;
}

function makeGrassTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#3a6b44";
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 3500; i++) {
      x.fillStyle = `hsla(${rand(95, 135)}, ${rand(30, 50)}%, ${rand(22, 40)}%, ${rand(0.25, 0.6)})`;
      x.fillRect(Math.random() * 256, Math.random() * 256, rand(1, 3), rand(2, 6));
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(60, 60);
  return t;
}

function makeTileTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#a2a7b3";
    x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 500; i++) {
      x.fillStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${rand(0.02, 0.08)})`;
      x.fillRect(Math.random() * 128, Math.random() * 128, rand(2, 8), rand(2, 8));
    }
    x.strokeStyle = "rgba(60,64,76,0.55)";
    x.lineWidth = 2;
    x.strokeRect(1, 1, 126, 126);
    x.beginPath();
    x.moveTo(64, 0);
    x.lineTo(64, 128);
    x.moveTo(0, 64);
    x.lineTo(128, 64);
    x.lineWidth = 1;
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(BLOCK / 56, BLOCK / 56);
  return t;
}

function makeCloudTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    for (let i = 0; i < 9; i++) {
      const cx = rand(60, 196);
      const cy = rand(50, 80);
      const r = rand(28, 52);
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, 256, 128);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
  const skin = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.55 });
  const torsoM = new THREE.MeshStandardMaterial({ color: torsoColor, roughness: 0.6 });
  const legM = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.65 });

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

  const hairColors = [0x2b1b10, 0x6b4423, 0xc9a14a, 0x111111];
  const hair = new THREE.Mesh(
    new RoundedBoxGeometry(6.9, 2.6, 6.9, 2, 0.9),
    new THREE.MeshStandardMaterial({ color: hairColors[torsoColor % hairColors.length], roughness: 0.8 }),
  );
  hair.position.set(-0.2, 30.5, 0);
  hair.castShadow = true;
  body.add(hair);

  const shoeM = new THREE.MeshStandardMaterial({ color: 0x1a1a1f, roughness: 0.6 });
  for (const leg of [legL, legR]) {
    const shoe = new THREE.Mesh(new RoundedBoxGeometry(7.6, 2.2, 6.4, 2, 0.6), shoeM);
    shoe.position.set(0.8, -11, 0);
    leg.add(shoe);
  }

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
  bodyMat: THREE.MeshPhysicalMaterial;
}

const glowWhite = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.3, 1.0), toneMapped: false });
const glowRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 0.15, 0.15), toneMapped: false });

function makeCar(color: string): CarRig {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.55,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1220, metalness: 0.2, roughness: 0.08, clearcoat: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.7 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xc7ccd6, metalness: 0.9, roughness: 0.25 });

  const lower = new THREE.Mesh(new RoundedBoxGeometry(46, 7, 24, 2, 1.5), bodyMat);
  lower.position.y = 7.5;
  lower.castShadow = true;
  group.add(lower);

  const hood = new THREE.Mesh(new RoundedBoxGeometry(14, 3, 22, 2, 1.2), bodyMat);
  hood.position.set(14, 11.8, 0);
  group.add(hood);
  const trunk = new THREE.Mesh(new RoundedBoxGeometry(10, 3, 22, 2, 1.2), bodyMat);
  trunk.position.set(-17, 11.8, 0);
  group.add(trunk);

  const cabin = new THREE.Mesh(new RoundedBoxGeometry(22, 8, 20, 2, 2), glass);
  cabin.position.set(-2.5, 15, 0);
  cabin.castShadow = true;
  group.add(cabin);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(17, 1.6, 17, 2, 0.7), bodyMat);
  roof.position.set(-3, 19.4, 0);
  group.add(roof);

  const wheelGeo = new THREE.CylinderGeometry(5.2, 5.2, 4, 16);
  const rimGeo = new THREE.CylinderGeometry(3, 3, 4.2, 10);
  for (const [wx, wz] of [[14.5, 12], [14.5, -12], [-14.5, 12], [-14.5, -12]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 5.2, wz);
    w.castShadow = true;
    group.add(w);
    const r = new THREE.Mesh(rimGeo, rim);
    r.rotation.x = Math.PI / 2;
    r.position.set(wx, 5.2, wz);
    group.add(r);
  }

  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 23), dark);
  bumperF.position.set(23.5, 6, 0);
  group.add(bumperF);
  const bumperB = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 23), dark);
  bumperB.position.set(-23.5, 6, 0);
  group.add(bumperB);

  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 5.5), glowWhite);
    hl.position.set(23.2, 9.5, s * 8);
    group.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 5.5), glowRed);
    tl.position.set(-23.2, 9.5, s * 8);
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
  sprite.scale.set(72, 18, 1);
  sprite.renderOrder = 10;
  return sprite;
}

interface Props {
  onEvent: (e: SimEvent) => void;
  onExit: () => void;
}

export default function Simulation({ onEvent, onExit }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const bigRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Sim>(newSim());
  const keysRef = useRef<Set<string>>(new Set());
  const yawRef = useRef(0.5); // world yaw on foot; offset from the car heading when driving
  const pitchRef = useRef(0); // mouse pitch (down is positive)
  const camYawRef = useRef(0.5);
  const camModeRef = useRef<CamMode>("chase");
  const mapOpenRef = useRef(false);
  const waypointRef = useRef<{ x: number; y: number } | null>(null);
  const layoutRef = useRef({ s: 0.2, ox: 40, oy: 100 });
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [status, setStatus] = useState<Status>("ready");
  const [endReason, setEndReason] = useState<EndReason>("time");
  const [mapOpen, setMapOpen] = useState(false);
  const [camMode, setCamMode] = useState<CamMode>("chase");
  const [isFs, setIsFs] = useState(false);
  const [locked, setLocked] = useState(false);
  const [wpDist, setWpDist] = useState<number | null>(null);
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
    if (next && document.pointerLockElement) document.exitPointerLock();
    setMapOpen(next);
  }, []);

  const cycleCamera = useCallback(() => {
    const next = CAM_MODES[(CAM_MODES.indexOf(camModeRef.current) + 1) % CAM_MODES.length];
    camModeRef.current = next;
    setCamMode(next);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
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
    yawRef.current = camYawRef.current;
    setMapOpen(false);
    setWpDist(null);
    setStatus("playing");
    setEndReason("time");
    setHud({ coins: 0, time: ROUND_SECONDS, speed: 0, near: false, inCar: false });
    onEventRef.current("start");
  }, []);

  const requestLock = useCallback(() => {
    const c = canvasRef.current;
    if (c && gameRef.current.status === "playing" && !mapOpenRef.current && document.pointerLockElement !== c) {
      try {
        const r = c.requestPointerLock() as unknown as Promise<void> | undefined;
        if (r && typeof r.catch === "function") r.catch(() => undefined);
      } catch {
        /* pointer lock unavailable */
      }
    }
  }, []);

  // Keyboard + mouse-look input
  useEffect(() => {
    const GAME_KEYS = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "ShiftLeft", "ShiftRight", "KeyE", "KeyM", "KeyV", "KeyF", "Escape", "Space", "Enter",
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
      if (e.code === "KeyV" && !e.repeat) {
        cycleCamera();
        return;
      }
      if (e.code === "KeyF" && !e.repeat) {
        toggleFullscreen();
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
          c.speed = 0;
          g.inCar = null;
          yawRef.current = camYawRef.current; // keep looking where we were
          onEventRef.current("exit");
        } else if (g.nearCar) {
          g.inCar = g.nearCar;
          g.nearCar = null;
          yawRef.current = 0; // becomes an offset from the car heading
          onEventRef.current("enter");
        }
      }
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const blur = () => keysRef.current.clear();

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvasRef.current || mapOpenRef.current) return;
      yawRef.current -= e.movementX * 0.0024;
      pitchRef.current = clamp(pitchRef.current + e.movementY * 0.002, -1.1, 1.2);
    };
    const onLockChange = () => setLocked(document.pointerLockElement === canvasRef.current);
    const onFs = () => setIsFs(!!document.fullscreenElement);

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.pointerLockElement) document.exitPointerLock();
      if (document.fullscreenElement) void document.exitFullscreen();
    };
  }, [start, toggleMap, cycleCamera, toggleFullscreen]);

  // Lock page scroll while the simulation owns the screen.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 3D scene + game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const mini = miniRef.current;
    const big = bigRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let vw = Math.max(320, root.clientWidth);
    let vh = Math.max(240, root.clientHeight);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(dpr);
    renderer.setSize(vw, vh, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.5;

    const scene = new THREE.Scene();
    const FOG = 0x9fb4d6;
    scene.fog = new THREE.FogExp2(FOG, 0.00045);

    const camera = new THREE.PerspectiveCamera(62, vw / vh, 1, 6000);

    // ---------- Sky + environment (dusk) ----------
    const sunVec = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 28), THREE.MathUtils.degToRad(30));
    const sky = new Sky();
    sky.scale.setScalar(4500);
    const su = sky.material.uniforms;
    su["turbidity"].value = 3;
    su["rayleigh"].value = 1.2;
    su["mieCoefficient"].value = 0.0015;
    su["mieDirectionalG"].value = 0.6;
    su["sunPosition"].value.copy(sunVec);
    scene.add(sky);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    const envRT = pmrem.fromScene(envScene);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.45;

    // ---------- Lights ----------
    scene.add(new THREE.HemisphereLight(0x8fa6d8, 0x3a2f35, 0.55));
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.camera.left = -220;
    sun.shadow.camera.right = 220;
    sun.shadow.camera.top = 220;
    sun.shadow.camera.bottom = -220;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 1500;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);
    scene.add(sun.target);

    // Headlights for the car the player drives.
    const headlight = new THREE.SpotLight(0xfff0cc, 0, 520, 0.5, 0.65, 0);
    scene.add(headlight);
    scene.add(headlight.target);

    const disposables: Array<{ dispose: () => void }> = [pmrem, envRT];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };
    const dummy = new THREE.Object3D();

    // ---------- Ground ----------
    const grass = new THREE.Mesh(
      track(new THREE.PlaneGeometry(9000, 9000)),
      track(new THREE.MeshStandardMaterial({ map: track(makeGrassTexture()), roughness: 1 })),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(WORLD_W / 2, -1, WORLD_H / 2);
    grass.receiveShadow = true;
    scene.add(grass);

    const asphalt = new THREE.Mesh(
      track(new THREE.PlaneGeometry(WORLD_W, WORLD_H)),
      track(new THREE.MeshStandardMaterial({ map: track(makeAsphaltTexture()), roughness: 0.92, metalness: 0.05 })),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.set(WORLD_W / 2, 0, WORLD_H / 2);
    asphalt.receiveShadow = true;
    scene.add(asphalt);

    // ---------- Road markings (instanced) ----------
    const markings = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      items: Array<[number, number, number, number]>, // x, z, sx, sz
    ) => {
      const mesh = new THREE.InstancedMesh(geo, mat, items.length);
      items.forEach(([x, z, sx, sz], k) => {
        dummy.position.set(x, 0.25, z);
        dummy.scale.set(sx, 1, sz);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
      });
      mesh.receiveShadow = true;
      scene.add(mesh);
      dummy.scale.set(1, 1, 1);
    };
    const unitBox = track(new THREE.BoxGeometry(1, 0.3, 1));
    const yellowMat = track(new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 }));
    const whiteMat = track(new THREE.MeshStandardMaterial({ color: 0xe2e6ee, roughness: 0.6 }));

    const dashes: Array<[number, number, number, number]> = [];
    for (let j = 0; j <= ROWS; j++) {
      for (let x = 9; x < WORLD_W; x += 34) {
        if (x % CELL < ROAD) continue;
        dashes.push([x, j * CELL + ROAD / 2, 18, 2.6]);
      }
    }
    for (let i = 0; i <= COLS; i++) {
      for (let y = 9; y < WORLD_H; y += 34) {
        if (y % CELL < ROAD) continue;
        dashes.push([i * CELL + ROAD / 2, y, 2.6, 18]);
      }
    }
    markings(unitBox, yellowMat, dashes);

    const edges: Array<[number, number, number, number]> = [];
    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const cx = i * CELL + ROAD + BLOCK / 2;
        edges.push([cx, j * CELL + 5, BLOCK - 6, 1.6]);
        edges.push([cx, j * CELL + ROAD - 5, BLOCK - 6, 1.6]);
      }
    }
    for (let i = 0; i <= COLS; i++) {
      for (let j = 0; j < ROWS; j++) {
        const cz = j * CELL + ROAD + BLOCK / 2;
        edges.push([i * CELL + 5, cz, 1.6, BLOCK - 6]);
        edges.push([i * CELL + ROAD - 5, cz, 1.6, BLOCK - 6]);
      }
    }
    markings(unitBox, whiteMat, edges);

    const stripes: Array<[number, number, number, number]> = [];
    for (let i = 0; i <= COLS; i++) {
      for (let j = 0; j <= ROWS; j++) {
        const ox = i * CELL;
        const oy = j * CELL;
        for (let k = 0; k < 6; k++) {
          stripes.push([ox + 12 + k * 15, oy + 7, 8, 10]);
          stripes.push([ox + 12 + k * 15, oy + ROAD - 7, 8, 10]);
          stripes.push([ox + 7, oy + 12 + k * 15, 10, 8]);
          stripes.push([ox + ROAD - 7, oy + 12 + k * 15, 10, 8]);
        }
      }
    }
    markings(unitBox, whiteMat, stripes);

    // ---------- Sidewalk blocks + curbs ----------
    const walkMat = track(new THREE.MeshStandardMaterial({ map: track(makeTileTexture()), roughness: 0.9 }));
    const curbMat = track(new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.8 }));
    const walkGeo = track(new THREE.BoxGeometry(BLOCK, 2, BLOCK));
    const curbGeo = track(new THREE.BoxGeometry(BLOCK + 3, 1.2, BLOCK + 3));
    for (const b of BLOCKS) {
      const curb = new THREE.Mesh(curbGeo, curbMat);
      curb.position.set(b.x + BLOCK / 2, 0.6, b.y + BLOCK / 2);
      curb.receiveShadow = true;
      scene.add(curb);
      const m = new THREE.Mesh(walkGeo, walkMat);
      m.position.set(b.x + BLOCK / 2, 1, b.y + BLOCK / 2);
      m.receiveShadow = true;
      scene.add(m);
    }

    // ---------- Street lamps + street trees (instanced) ----------
    const lampPos: Array<[number, number]> = [];
    const treePos: Array<[number, number]> = [];
    for (const b of BLOCKS) {
      for (const t of [50, 150, 250]) {
        lampPos.push([b.x + t, b.y + 8], [b.x + t, b.y + BLOCK - 8]);
        lampPos.push([b.x + 8, b.y + t], [b.x + BLOCK - 8, b.y + t]);
      }
      for (const t of [100, 200]) {
        treePos.push([b.x + t, b.y + 12], [b.x + t, b.y + BLOCK - 12]);
        treePos.push([b.x + 12, b.y + t], [b.x + BLOCK - 12, b.y + t]);
      }
    }
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x2b2f38, metalness: 0.6, roughness: 0.5 }));
    const poles = new THREE.InstancedMesh(track(new THREE.CylinderGeometry(0.9, 1.3, 30, 8)), poleMat, lampPos.length);
    const bulbMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.8), toneMapped: false }));
    const bulbs = new THREE.InstancedMesh(track(new THREE.SphereGeometry(2.3, 10, 8)), bulbMat, lampPos.length);
    lampPos.forEach(([x, z], k) => {
      dummy.position.set(x, 17, z);
      dummy.updateMatrix();
      poles.setMatrixAt(k, dummy.matrix);
      dummy.position.set(x, 33, z);
      dummy.updateMatrix();
      bulbs.setMatrixAt(k, dummy.matrix);
    });
    poles.castShadow = true;
    scene.add(poles);
    scene.add(bulbs);

    const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 1 }));
    const canopyMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
    const trunks = new THREE.InstancedMesh(track(new THREE.CylinderGeometry(1.6, 2.2, 14, 7)), trunkMat, treePos.length);
    const canopies = new THREE.InstancedMesh(track(new THREE.IcosahedronGeometry(11, 1)), canopyMat, treePos.length);
    const col = new THREE.Color();
    treePos.forEach(([x, z], k) => {
      dummy.position.set(x, 9, z);
      dummy.updateMatrix();
      trunks.setMatrixAt(k, dummy.matrix);
      const s = rand(0.85, 1.25);
      dummy.position.set(x, 24, z);
      dummy.scale.set(s, s * rand(0.9, 1.2), s);
      dummy.updateMatrix();
      canopies.setMatrixAt(k, dummy.matrix);
      col.setHSL(rand(0.24, 0.36), rand(0.45, 0.65), rand(0.22, 0.34));
      canopies.setColorAt(k, col);
    });
    dummy.scale.set(1, 1, 1);
    trunks.castShadow = true;
    canopies.castShadow = true;
    scene.add(trunks);
    scene.add(canopies);

    // ---------- Parks ----------
    const parkMat = track(new THREE.MeshStandardMaterial({ color: 0x3a8f50, roughness: 1 }));
    const pathMat = track(new THREE.MeshStandardMaterial({ color: 0xcdbd90, roughness: 0.95 }));
    const stoneMat = track(new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.6 }));
    const waterMat = track(new THREE.MeshPhysicalMaterial({ color: 0x38bdf8, roughness: 0.05, metalness: 0.1, clearcoat: 1 }));
    const parkLeaf = [0x1f7a3a, 0x2c9a50, 0x37a85c].map((c) => track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })));
    const parkTrunkGeo = track(new THREE.CylinderGeometry(3, 4, 18, 8));
    const parkLeafGeo = track(new THREE.IcosahedronGeometry(17, 1));
    for (const p of PARKS) {
      const cx = p.x + BLOCK / 2;
      const cz = p.y + BLOCK / 2;
      const lawn = new THREE.Mesh(track(new THREE.BoxGeometry(BLOCK - 20, 1, BLOCK - 20)), parkMat);
      lawn.position.set(cx, 2.3, cz);
      lawn.receiveShadow = true;
      scene.add(lawn);
      const pathA = new THREE.Mesh(track(new THREE.BoxGeometry(BLOCK - 20, 1, 16)), pathMat);
      pathA.position.set(cx, 2.9, cz);
      pathA.receiveShadow = true;
      scene.add(pathA);
      const pathB = new THREE.Mesh(track(new THREE.BoxGeometry(16, 1, BLOCK - 20)), pathMat);
      pathB.position.set(cx, 2.9, cz);
      pathB.receiveShadow = true;
      scene.add(pathB);
      const basin = new THREE.Mesh(track(new THREE.CylinderGeometry(28, 30, 8, 28)), stoneMat);
      basin.position.set(cx, 6, cz);
      basin.castShadow = true;
      basin.receiveShadow = true;
      scene.add(basin);
      const water = new THREE.Mesh(track(new THREE.CylinderGeometry(25, 25, 1, 28)), waterMat);
      water.position.set(cx, 10.2, cz);
      scene.add(water);
      const jet = new THREE.Mesh(track(new THREE.CylinderGeometry(3, 5, 24, 10)), stoneMat);
      jet.position.set(cx, 20, cz);
      jet.castShadow = true;
      scene.add(jet);
      [[50, 50], [250, 60], [60, 245], [245, 240], [100, 110], [200, 190]].forEach(([tx, ty], k) => {
        const trunk = new THREE.Mesh(parkTrunkGeo, trunkMat);
        trunk.position.set(p.x + tx, 12, p.y + ty);
        trunk.castShadow = true;
        scene.add(trunk);
        const leaves = new THREE.Mesh(parkLeafGeo, parkLeaf[k % 3]);
        leaves.position.set(p.x + tx, 36, p.y + ty);
        leaves.scale.y = 1.15;
        leaves.castShadow = true;
        scene.add(leaves);
      });
    }

    // ---------- Buildings: lit windows, crowns, antennas ----------
    const facadeCache = new Map<number, FacadePair>();
    const facadeFor = (hue: number, rx: number, ry: number) => {
      const key = Math.round(hue / 30) * 30;
      let base = facadeCache.get(key);
      if (!base) {
        base = makeFacadePair(key);
        facadeCache.set(key, base);
        track(base.map);
        track(base.emissive);
      }
      const map = base.map.clone();
      const emissive = base.emissive.clone();
      for (const t of [map, emissive]) {
        t.repeat.set(rx, ry);
        t.needsUpdate = true;
        track(t);
      }
      return { map, emissive };
    };
    const wallMat = (hue: number, rx: number, ry: number) => {
      const f = facadeFor(hue, rx, ry);
      return track(
        new THREE.MeshStandardMaterial({
          map: f.map,
          emissiveMap: f.emissive,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.8,
          roughness: 0.7,
          metalness: 0.08,
        }),
      );
    };
    const antennaMat = track(new THREE.MeshStandardMaterial({ color: 0x9aa0ac, metalness: 0.7, roughness: 0.4 }));
    const beaconMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.2, 0.2), toneMapped: false }));
    for (const b of BUILDINGS) {
      const ry = Math.max(1, Math.round(b.height / 56));
      const sideX = wallMat(b.hue, Math.max(1, Math.round(b.h / 56)), ry);
      const sideZ = wallMat(b.hue, Math.max(1, Math.round(b.w / 56)), ry);
      const roof = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(`hsl(${b.hue}, 16%, 28%)`), roughness: 0.9 }));
      const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(b.w, b.height, b.h)), [sideX, sideX, roof, roof, sideZ, sideZ]);
      mesh.position.set(b.x + b.w / 2, b.height / 2 + 2, b.y + b.h / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const contact = new THREE.Mesh(
        track(new THREE.PlaneGeometry(b.w + 16, b.h + 16)),
        track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })),
      );
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(b.x + b.w / 2, 2.15, b.y + b.h / 2);
      scene.add(contact);

      const cornice = new THREE.Mesh(track(new THREE.BoxGeometry(b.w + 4, 3, b.h + 4)), roof);
      cornice.position.set(b.x + b.w / 2, b.height + 3.5, b.y + b.h / 2);
      cornice.castShadow = true;
      scene.add(cornice);

      let topY = b.height + 5;
      if (b.height > 110) {
        const crownH = 22;
        const crownMat = wallMat(b.hue, Math.max(1, Math.round((b.w * 0.6) / 56)), 1);
        const crown = new THREE.Mesh(track(new THREE.BoxGeometry(b.w * 0.6, crownH, b.h * 0.6)), crownMat);
        crown.position.set(b.x + b.w / 2, topY + crownH / 2, b.y + b.h / 2);
        crown.castShadow = true;
        scene.add(crown);
        topY += crownH;
      }
      const ant = new THREE.Mesh(track(new THREE.CylinderGeometry(0.7, 1, 26, 6)), antennaMat);
      ant.position.set(b.x + b.w / 2, topY + 13, b.y + b.h / 2);
      scene.add(ant);
      const beacon = new THREE.Mesh(track(new THREE.SphereGeometry(1.8, 8, 6)), beaconMat);
      beacon.position.set(b.x + b.w / 2, topY + 27, b.y + b.h / 2);
      scene.add(beacon);
    }

    // ---------- Distant skyline ----------
    {
      const far = new THREE.InstancedMesh(
        track(new THREE.BoxGeometry(1, 1, 1)),
        track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, emissive: 0x2b2420, emissiveIntensity: 0.6 })),
        170,
      );
      let n = 0;
      while (n < 170) {
        const x = rand(-1500, WORLD_W + 1500);
        const z = rand(-1500, WORLD_H + 1500);
        if (x > -120 && x < WORLD_W + 120 && z > -120 && z < WORLD_H + 120) continue;
        const w = rand(70, 170);
        const d = rand(70, 170);
        const h = rand(120, 460);
        dummy.position.set(x, h / 2, z);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        far.setMatrixAt(n, dummy.matrix);
        col.setHSL(rand(0.58, 0.7), rand(0.1, 0.25), rand(0.2, 0.32));
        far.setColorAt(n, col);
        n++;
      }
      dummy.scale.set(1, 1, 1);
      scene.add(far);
    }

    // ---------- Clouds ----------
    const cloudTex = track(makeCloudTexture());
    const clouds: THREE.Sprite[] = [];
    for (let i = 0; i < 26; i++) {
      const m = track(new THREE.SpriteMaterial({ map: cloudTex, color: new THREE.Color(2.2, 2.2, 2.3), transparent: true, opacity: rand(0.35, 0.65), depthWrite: false, fog: false }));
      const sp = new THREE.Sprite(m);
      const w = rand(600, 1100);
      sp.scale.set(w, w * 0.4, 1);
      sp.position.set(rand(-1800, WORLD_W + 1800), rand(650, 950), rand(-1800, WORLD_H + 1800));
      scene.add(sp);
      clouds.push(sp);
    }

    // ---------- Coins ----------
    const g0 = gameRef.current;
    const coinGeo = track(new THREE.CylinderGeometry(1, 1, 0.28, 24));
    const yellowCoinMat = track(new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0xd9a400, emissiveIntensity: 0.5, metalness: 0.7, roughness: 0.25 }));
    const goldMat = track(new THREE.MeshStandardMaterial({ color: 0xfb923c, emissive: 0xea580c, emissiveIntensity: 0.6, metalness: 0.7, roughness: 0.25 }));
    const coinMeshes: THREE.Mesh[] = [];
    const coinPivots = g0.coinList.map(() => {
      const m = new THREE.Mesh(coinGeo, yellowCoinMat);
      m.rotation.z = Math.PI / 2;
      m.castShadow = true;
      coinMeshes.push(m);
      const p = new THREE.Group();
      p.add(m);
      scene.add(p);
      return p;
    });

    // ---------- Vehicles ----------
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

    // ---------- Pedestrians + the player ----------
    const pedRigs = g0.peds.map((_, i) => {
      const r = makeHuman(PED_COLORS[i % PED_COLORS.length], PED_LEGS[i % PED_LEGS.length], PED_SKINS[i % PED_SKINS.length], 1.0);
      scene.add(r.group);
      return r;
    });
    const player = makeHuman(0x0d69ac, 0x4b974b, 0xf5cd30, 1.15);
    scene.add(player.group);

    // ---------- Particles (instanced cubes) ----------
    const MAXP = 260;
    const partMesh = new THREE.InstancedMesh(track(new THREE.BoxGeometry(1, 1, 1)), track(new THREE.MeshBasicMaterial({ toneMapped: false })), MAXP);
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
          color: new THREE.Color(color).multiplyScalar(1.2),
        });
      }
    };
    const addText = (g: Sim, text: string, color: string, x: number, z: number) => {
      const sprite = makeTextSprite(text, color);
      scene.add(sprite);
      g.texts.push({ sprite, x, z, life: 0 });
    };

    // ---------- Waypoint beam ----------
    const beamMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.3, 0.9), transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    const beam = new THREE.Mesh(track(new THREE.CylinderGeometry(7, 7, 700, 20, 1, true)), beamMat);
    beam.visible = false;
    scene.add(beam);
    const ringMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.3, 0.9), transparent: true, opacity: 0.7, side: THREE.DoubleSide, toneMapped: false }));
    const wpRing = new THREE.Mesh(track(new THREE.RingGeometry(14, 20, 32)), ringMat);
    wpRing.rotation.x = -Math.PI / 2;
    wpRing.visible = false;
    scene.add(wpRing);

    // ---------- Post-processing (MSAA + bloom) ----------
    const target = new THREE.WebGLRenderTarget(vw * dpr, vh * dpr, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(dpr);
    composer.setSize(vw, vh);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(vw, vh), 0.12, 0.35, 2.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    disposables.push(composer, target);

    // ---------- Overlay canvases ----------
    const rctx = mini ? mini.getContext("2d") : null;
    if (mini) {
      mini.width = RADAR * dpr;
      mini.height = RADAR * dpr;
    }
    const bctx = big ? big.getContext("2d") : null;
    const sizeBig = () => {
      if (!big) return;
      big.width = Math.round(vw * dpr);
      big.height = Math.round(vh * dpr);
    };
    sizeBig();

    const resize = () => {
      vw = Math.max(320, root.clientWidth);
      vh = Math.max(240, root.clientHeight);
      renderer.setSize(vw, vh, false);
      composer.setPixelRatio(dpr);
      composer.setSize(vw, vh);
      bloom.resolution.set(vw, vh);
      camera.aspect = vw / vh;
      camera.updateProjectionMatrix();
      sizeBig();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(root);

    // ---------- Camera state ----------
    const camPos = new THREE.Vector3(CELL + 50, 120, CELL + 200);
    const camLook = new THREE.Vector3(CELL + 50, 20, CELL + 50);
    const desired = new THREE.Vector3();
    const lookT = new THREE.Vector3();
    let camYaw = yawRef.current;
    let carYawUnwrapped = 0;
    let fov = 62;

    // Shorten the camera boom if it would end up inside a building.
    const clipBoom = (lx: number, ly: number, lz: number, cx: number, cy: number, cz: number) => {
      for (let k = 1; k <= 12; k++) {
        const u = k / 12;
        const x = lx + (cx - lx) * u;
        const y = ly + (cy - ly) * u;
        const z = lz + (cz - lz) * u;
        for (const b of BUILDINGS) {
          if (x > b.x - 5 && x < b.x + b.w + 5 && z > b.y - 5 && z < b.y + b.h + 5 && y < b.height + 8) {
            return Math.max(0.12, (k - 1) / 12);
          }
        }
      }
      return 1;
    };

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
      if (document.pointerLockElement) document.exitPointerLock();
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
      last = now;
      const dt = mapOpenRef.current ? 0 : rawDt;
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
            const tgt = Math.atan2(dy, dx);
            g.face += angleDiff(tgt, g.face) * Math.min(1, dt * 14);
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
        if (idx === g.crashPed) return;
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
      const mode = camModeRef.current;
      const firstPerson = mode === "first";

      player.group.visible = !g.inCar && !firstPerson;
      player.group.position.set(g.px, 0, g.py);
      player.group.rotation.y = -g.face;
      const sw = moving ? Math.sin(g.walk) * 0.9 : 0;
      player.legL.rotation.z = sw;
      player.legR.rotation.z = -sw;
      player.armL.rotation.z = -sw;
      player.armR.rotation.z = sw;
      if (g.invuln > 0 && g.status === "playing" && Math.floor(now / 90) % 2 === 0) player.group.visible = false;
      const fall = g.status === "over" && g.endReason === "foot" ? Math.min(1, g.crashT * 3) : 0;
      player.body.rotation.z = -fall * (Math.PI / 2);
      player.body.position.y = fall * 5;
      if (fall > 0) player.group.visible = true;

      g.parked.forEach((c, i) => {
        const r = parkedRigs[i];
        r.group.position.set(c.x, 2, c.y);
        r.group.rotation.y = -c.angle;
        r.group.visible = !(firstPerson && g.inCar === c);
        r.bodyMat.emissive.setHex(c === g.nearCar ? 0x7a6500 : 0x000000);
      });
      g.traffic.forEach((c, i) => {
        const r = trafficRigs[i];
        r.group.position.set(c.x, 2, c.y);
        r.group.rotation.y = -c.angle;
        r.bodyMat.color.set(c.color);
      });

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
        beamMat.opacity = 0.2 + Math.sin(now / 300) * 0.05;
      }

      for (const cl of clouds) {
        cl.position.x += 7 * dt;
        if (cl.position.x > WORLD_W + 2000) cl.position.x = -2000;
      }

      // Headlights follow the driven car
      if (g.inCar) {
        const c = g.inCar;
        const fx = Math.cos(c.angle);
        const fz = Math.sin(c.angle);
        headlight.position.set(c.x + fx * 20, 10, c.y + fz * 20);
        headlight.target.position.set(c.x + fx * 140, 0, c.y + fz * 140);
        headlight.intensity = 6;
      } else {
        headlight.intensity = 0;
      }

      // ---------- Camera ----------
      const subject = g.inCar;
      const speedNow = subject ? Math.abs(subject.speed) : 0;

      if (!subject && g.status === "ready") yawRef.current += rawDt * 0.12; // idle orbit

      let targetYaw: number;
      if (subject) {
        // Follow the car's heading (plus the mouse-look offset, which drifts back to centre).
        const carYaw = Math.atan2(-Math.cos(subject.angle), -Math.sin(subject.angle));
        carYawUnwrapped += angleDiff(carYaw, carYawUnwrapped);
        if (dt > 0) yawRef.current *= 1 - Math.min(1, dt * 1.2);
        targetYaw = carYawUnwrapped + yawRef.current;
        camYaw += angleDiff(targetYaw, camYaw) * (1 - Math.exp(-dt * (firstPerson ? 12 : 4.5)));
      } else {
        carYawUnwrapped = camYaw;
        targetYaw = yawRef.current;
        camYaw += angleDiff(targetYaw, camYaw) * (1 - Math.exp(-dt * 24));
      }
      camYawRef.current = camYaw;

      const p = pitchRef.current;
      let targetFov = 62;
      if (firstPerson) {
        // Eyes of the character, or the driver's seat.
        const eyeH = subject ? 17 : 31;
        const fwd = subject ? 3 : 3.5;
        const baseAngle = subject ? subject.angle : g.face;
        desired.set(g.px + Math.cos(baseAngle) * fwd, eyeH, g.py + Math.sin(baseAngle) * fwd);
        const look = -p;
        const cp = Math.cos(look);
        lookT.set(desired.x - Math.sin(camYaw) * cp * 100, desired.y + Math.sin(look) * 100, desired.z - Math.cos(camYaw) * cp * 100);
        camPos.copy(desired);
        camLook.copy(lookT);
        targetFov = 80 + Math.min(14, speedNow * 0.035);
      } else {
        const far = mode === "far";
        const elev = clamp((far ? 0.95 : subject ? 0.26 : 0.4) + p, 0.06, 1.32);
        const dist = far ? 300 : subject ? 112 + Math.min(34, speedNow * 0.09) : 78;
        const upLook = far ? 4 : subject ? 14 : 22;
        const ahead = subject ? 48 : 0;
        const ax = g.px + Math.cos(g.face) * ahead;
        const az = g.py + Math.sin(g.face) * ahead;
        lookT.set(ax, upLook, az);
        const ce = Math.cos(elev);
        desired.set(g.px + Math.sin(camYaw) * ce * dist, upLook + Math.sin(elev) * dist, g.py + Math.cos(camYaw) * ce * dist);
        // Keep the lens out of walls.
        const f = clipBoom(g.px, upLook, g.py, desired.x, desired.y, desired.z);
        desired.set(g.px + (desired.x - g.px) * f, upLook + (desired.y - upLook) * f, g.py + (desired.z - g.py) * f);
        const kp = 1 - Math.exp(-dt * (f < 1 ? 22 : 9));
        camPos.lerp(desired, kp);
        camLook.lerp(lookT, 1 - Math.exp(-dt * 12));
        targetFov = (far ? 55 : 62) + Math.min(16, speedNow * 0.04);
      }

      fov += (targetFov - fov) * (1 - Math.exp(-dt * 5));
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      camera.position.copy(camPos);
      if (g.shake > 0) {
        camera.position.x += (Math.random() - 0.5) * g.shake * 14;
        camera.position.y += (Math.random() - 0.5) * g.shake * 14;
      }
      if (camPos.y < 3) camera.position.y = 3;
      camera.lookAt(camLook);

      sun.position.set(g.px + sunVec.x * 500, sunVec.y * 500 + 40, g.py + sunVec.z * 500);
      sun.target.position.set(g.px, 0, g.py);

      composer.render();

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
        rctx.fillStyle = "#4a505e";
        rctx.fillRect(0, 0, WORLD_W, WORLD_H);
        rctx.fillStyle = "#6b7280";
        for (const b of BLOCKS) rctx.fillRect(b.x + 3, b.y + 3, BLOCK - 6, BLOCK - 6);
        rctx.fillStyle = "#3f8a52";
        for (const pk of PARKS) rctx.fillRect(pk.x + 8, pk.y + 8, BLOCK - 16, BLOCK - 16);
        for (const b of BUILDINGS) {
          rctx.fillStyle = `hsl(${b.hue} 25% 42%)`;
          rctx.fillRect(b.x, b.y, b.w, b.h);
        }
        for (const c of g.coinList) {
          rctx.fillStyle = c.v > 1 ? "#fb923c" : "#fde047";
          rctx.beginPath();
          rctx.arc(c.x, c.y, c.v > 1 ? 16 : 12, 0, Math.PI * 2);
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
        const ox = 44;
        const oy = 104;
        const panelW = 300;
        const S = Math.max(0.05, Math.min((vw - ox - panelW - 56) / WORLD_W, (vh - oy - 36) / WORLD_H));
        layoutRef.current = { s: S, ox, oy };
        const c = bctx;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = "#0e2438";
        c.fillRect(0, 0, vw, vh);
        c.textBaseline = "alphabetic";
        c.textAlign = "left";
        c.fillStyle = "#fff";
        c.font = "800 28px 'Plus Jakarta Sans', sans-serif";
        c.fillText("COIN CITY", ox, 52);
        c.fillStyle = "rgba(255,255,255,0.65)";
        c.font = "600 13px 'Plus Jakarta Sans', sans-serif";
        c.fillText("Click the map to set a waypoint  ·  click it again to clear  ·  M / Esc to close", ox, 78);

        c.save();
        c.translate(ox, oy);
        c.scale(S, S);
        c.fillStyle = "#f6f3ea";
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
        for (const co of g.coinList) blip(co.x, co.y, co.v > 1 ? 4.6 : 3.4, co.v > 1 ? "#fb923c" : "#facc15");
        c.fillStyle = "#2563eb";
        for (const pc of g.parked) c.fillRect(pc.x - 8 / S, pc.y - 5 / S, 16 / S, 10 / S);
        c.restore();

        c.fillStyle = "#7a7560";
        c.font = "700 9px 'Plus Jakarta Sans', sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        for (let j = 0; j <= ROWS; j++) {
          const y = oy + (j * CELL + ROAD / 2) * S;
          c.fillText(`AVENUE ${j + 1}`, ox + WORLD_W * S * 0.3, y);
          c.fillText(`AVENUE ${j + 1}`, ox + WORLD_W * S * 0.78, y);
        }
        for (let i = 0; i <= COLS; i++) {
          const x = ox + (i * CELL + ROAD / 2) * S;
          for (const fy of [0.3, 0.78]) {
            c.save();
            c.translate(x, oy + WORLD_H * S * fy);
            c.rotate(-Math.PI / 2);
            c.fillText(`STREET ${i + 1}`, 0, 0);
            c.restore();
          }
        }
        c.fillStyle = "#3f7a3f";
        c.font = "800 9px 'Plus Jakarta Sans', sans-serif";
        for (const pk of PARKS) c.fillText("FOUNTAIN PARK", ox + (pk.x + BLOCK / 2) * S, oy + (pk.y + BLOCK / 2 + 46) * S);

        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 2;
        c.strokeRect(ox, oy, WORLD_W * S, WORLD_H * S);

        const wm = waypointRef.current;
        if (wm) {
          const wx = ox + wm.x * S;
          const wy = oy + wm.y * S;
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

        const ppx = ox + g.px * S;
        const ppy = oy + g.py * S;
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

        const px0 = ox + WORLD_W * S + 32;
        c.textAlign = "left";
        c.textBaseline = "alphabetic";
        c.fillStyle = "rgba(255,255,255,0.08)";
        c.beginPath();
        c.roundRect(px0 - 14, oy, vw - px0 - 24, WORLD_H * S, 14);
        c.fill();
        c.fillStyle = "#fff";
        c.font = "800 14px 'Plus Jakarta Sans', sans-serif";
        c.fillText("LEGEND", px0, oy + 28);
        const items: Array<[string, string, string]> = [
          ["circle", "#facc15", "Coin  (+1)"],
          ["circle", "#fb923c", "Gold coin  (+5)"],
          ["car", "#2563eb", "Parked car  (press E)"],
          ["arrow", "#ef4444", "You"],
          ["pin", "#ff3d9a", "Waypoint"],
          ["square", "#a6d08b", "Park"],
        ];
        items.forEach(([kind, colr, label], idx) => {
          const iy2 = oy + 56 + idx * 30;
          c.fillStyle = colr;
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
          c.fillStyle = "rgba(255,255,255,0.88)";
          c.font = "600 13px 'Plus Jakarta Sans', sans-serif";
          c.fillText(label, px0 + 28, iy2);
        });

        const base = oy + 56 + items.length * 30 + 26;
        c.fillStyle = "#fff";
        c.font = "800 14px 'Plus Jakarta Sans', sans-serif";
        c.fillText("TRIP", px0, base);
        c.font = "600 13px 'Plus Jakarta Sans', sans-serif";
        c.fillStyle = "rgba(255,255,255,0.88)";
        c.fillText(`Coins: ${g.coins}`, px0, base + 26);
        c.fillText(`Time left: ${Math.max(0, Math.ceil(g.time))}s`, px0, base + 50);
        const wd = waypointRef.current;
        c.fillText(wd ? `Waypoint: ${Math.round(Math.hypot(wd.x - g.px, wd.y - g.py) / 5)} m` : "Waypoint: none", px0, base + 74);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
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
    <div className="simfs" ref={rootRef}>
      <canvas
        ref={canvasRef}
        id="sim-canvas"
        className="simfs-canvas"
        aria-label="3D city simulation"
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, moved: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || document.pointerLockElement) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          d.x = e.clientX;
          d.y = e.clientY;
          d.moved += Math.abs(dx) + Math.abs(dy);
          yawRef.current -= dx * 0.006;
          pitchRef.current = clamp(pitchRef.current + dy * 0.004, -1.1, 1.2);
        }}
        onPointerUp={() => {
          const d = dragRef.current;
          dragRef.current = null;
          if (d && d.moved < 5) requestLock(); // a plain click captures the mouse
        }}
      />
      <div className="simfs-vignette" aria-hidden="true" />

      {/* HUD */}
      <div className="simfs-hud">
        <div className="simfs-chip">
          <span className="simfs-chip-label">Coins</span>
          <span className="simfs-chip-val">🪙 {hud.coins}</span>
        </div>
        <div className={`simfs-chip ${urgent ? "simfs-urgent" : ""}`}>
          <span className="simfs-chip-label">Time</span>
          <span className="simfs-chip-val">⏱ {hud.time}s</span>
        </div>
        <div className="simfs-chip">
          <span className="simfs-chip-label">Best</span>
          <span className="simfs-chip-val">🏆 {best}</span>
        </div>
      </div>

      <div className="simfs-toolbar">
        <button className="sim-map-btn" id="sim-exit-btn" onClick={onExit} title="Back to all games">
          ← Home
        </button>
        <button className="sim-map-btn" id="sim-cam-btn" onClick={cycleCamera} title="Change camera">
          🎥 {CAM_LABEL[camMode]} <kbd>V</kbd>
        </button>
        {status === "playing" && (
          <button className="sim-map-btn" id="sim-map-btn" onClick={() => toggleMap()}>
            🗺 Map <kbd>M</kbd>
          </button>
        )}
        <button className="sim-map-btn" id="sim-fs-btn" onClick={toggleFullscreen} title="Toggle fullscreen">
          {isFs ? "🗗 Exit fullscreen" : "⛶ Fullscreen"} <kbd>F</kbd>
        </button>
      </div>

      <canvas ref={miniRef} className="sim-minimap" aria-hidden="true" />
      {status === "playing" && wpDist !== null && <div className="sim-wp-chip">📍 {wpDist} m</div>}

      {status === "playing" && hud.inCar && (
        <div className="simfs-speedo" aria-label="Speed">
          <span className="simfs-speedo-num">{hud.speed}</span>
          <span className="simfs-speedo-unit">km/h</span>
        </div>
      )}

      {status === "playing" && !mapOpen && hud.near && !hud.inCar && (
        <div className="sim-prompt">
          Press <kbd>E</kbd> to drive
        </div>
      )}
      {status === "playing" && !mapOpen && hud.inCar && (
        <div className="sim-prompt">
          Press <kbd>E</kbd> to get out
        </div>
      )}
      {status === "playing" && !mapOpen && !locked && (
        <div className="simfs-lockhint">Click the scene to capture the mouse for free-look (Esc to release)</div>
      )}

      <canvas
        ref={bigRef}
        className={`sim-bigmap ${mapOpen ? "open" : ""}`}
        aria-label="City map"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const { s, ox, oy } = layoutRef.current;
          const wx = (cx - ox) / s;
          const wy = (cy - oy) / s;
          if (wx < 0 || wy < 0 || wx > WORLD_W || wy > WORLD_H) return;
          const cur = waypointRef.current;
          if (cur && Math.hypot(cur.x - wx, cur.y - wy) < 60) waypointRef.current = null;
          else waypointRef.current = { x: wx, y: wy };
          onEventRef.current("enter");
        }}
      />

      {status === "ready" && (
        <div className="overlay-screen simfs-overlay" role="dialog" aria-modal="true">
          <div className="modal-icon">🏙️</div>
          <h3 className="modal-title">Welcome to Coin City</h3>
          <p className="modal-subtitle">
            Collect coins before time runs out. Hop into any parked car with E — but if a car hits a person, the game
            is over.
          </p>
          <button id="sim-start-btn" className="btn-play-again btn-play-sim" onClick={start}>
            ▶ Start Exploring
          </button>
          <p className="simfs-tip">
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> move · <kbd>Shift</kbd> sprint · <kbd>E</kbd> car · <kbd>V</kbd> camera · <kbd>M</kbd> map · mouse to look
          </p>
        </div>
      )}

      {status === "over" && (
        <div className={`overlay-screen simfs-overlay ${endReason !== "time" ? "overlay-crash" : ""}`} role="dialog" aria-modal="true">
          <div className="modal-icon">{endReason === "time" ? "⏱️" : "🚨"}</div>
          <h3 className="modal-title">{endTitle}</h3>
          <p className="modal-subtitle">{endText}</p>
          <div className="score-badge-big sim-val">🪙 {hud.coins}</div>
          {hud.coins > 0 && hud.coins >= best && <p className="new-best">🏆 New best score!</p>}
          <div className="simfs-actions">
            <button id="sim-retry-btn" className="btn-play-again btn-play-sim" onClick={restart}>
              🔄 Play Again
            </button>
            <button id="sim-home-btn" className="btn-play-again simfs-secondary" onClick={onExit}>
              ← All games
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
