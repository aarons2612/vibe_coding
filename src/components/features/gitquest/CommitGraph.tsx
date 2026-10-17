import { useEffect, useMemo, useRef } from "react";
import { headId, type RepoState } from "../../../core/git";

const LANE_COLORS = ["#10b981", "#06b6d4", "#a855f7", "#f59e0b", "#ec4899", "#3b82f6"];
const COL_W = 78;
const PILL_H = 18;
const PAD_X = 44;

interface Ref {
  label: string;
  kind: "branch" | "head" | "tag";
  active?: boolean;
}

function layout(s: RepoState) {
  const hid = headId(s);
  const tips = [...Object.values(s.branches), ...Object.values(s.tags), hid].filter((x): x is string => !!x);
  const visible = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const id = stack.pop()!;
    if (visible.has(id)) continue;
    visible.add(id);
    stack.push(...s.commits[id].parents);
  }
  const ordered = [...visible].sort((a, b) => s.commits[a].seq - s.commits[b].seq);
  const col = new Map(ordered.map((id, i) => [id, i]));

  // one lane per branch, following first parents; main first
  const lane = new Map<string, number>();
  let next = 0;
  const branchNames = Object.keys(s.branches).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
  const laneTips = [...branchNames.map((b) => s.branches[b]), hid, ...Object.values(s.tags), ...[...ordered].reverse()];
  for (const tip of laneTips) {
    if (!tip || lane.has(tip)) continue;
    const l = next++;
    let cur: string | undefined = tip;
    while (cur && !lane.has(cur)) {
      lane.set(cur, l);
      cur = s.commits[cur].parents[0];
    }
  }

  const refs = new Map<string, Ref[]>();
  const addRef = (id: string, r: Ref) => refs.set(id, [...(refs.get(id) ?? []), r]);
  for (const b of branchNames) {
    const isHead = s.head.type === "branch" && s.head.name === b;
    addRef(s.branches[b], { label: isHead ? `HEAD → ${b}` : b, kind: "branch", active: isHead });
  }
  if (s.head.type === "detached") addRef(s.head.id, { label: "HEAD", kind: "head", active: true });
  for (const [t, id] of Object.entries(s.tags)) addRef(id, { label: `🏷 ${t}`, kind: "tag" });

  const maxRefs = Math.max(1, ...[...refs.values()].map((r) => r.length));
  const laneH = 54 + maxRefs * PILL_H;
  const top = maxRefs * PILL_H + 22;
  const pos = (id: string) => ({ x: PAD_X + col.get(id)! * COL_W, y: top + lane.get(id)! * laneH });

  return {
    ordered,
    pos,
    lane,
    refs,
    hid,
    width: PAD_X * 2 + Math.max(0, ordered.length - 1) * COL_W + 40,
    height: top + Math.max(1, next) * laneH - 10,
  };
}

export default function CommitGraph({ state, title, variant }: { state: RepoState; title: string; variant: "current" | "target" }) {
  const g = useMemo(() => layout(state), [state]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" });
  }, [g.ordered.length]);

  const color = (id: string) => LANE_COLORS[(g.lane.get(id) ?? 0) % LANE_COLORS.length];

  return (
    <div className={`gq-graph gq-graph-${variant}`}>
      <div className="gq-graph-title">
        <span>{title}</span>
        <span className="gq-graph-count">
          {g.ordered.length} commit{g.ordered.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="gq-graph-scroll" ref={scroller}>
        {g.ordered.length === 0 ? (
          <div className="gq-graph-empty">{state.initialized ? "No commits yet" : "Not a git repository"}</div>
        ) : (
          <svg width={g.width} height={g.height} role="img" aria-label={`${title} commit graph`}>
            {g.ordered.flatMap((id) =>
              state.commits[id].parents.map((p, i) => {
                const a = g.pos(p);
                const b = g.pos(id);
                const mx = (a.x + b.x) / 2;
                const d = a.y === b.y ? `M${a.x},${a.y} L${b.x},${b.y}` : `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
                return <path key={`${p}-${id}`} className="gq-edge" d={d} stroke={i === 0 ? color(id) : color(p)} />;
              }),
            )}
            {g.ordered.map((id) => {
              const { x, y } = g.pos(id);
              const c = state.commits[id];
              const refs = g.refs.get(id) ?? [];
              const msg = c.message.split("\n")[0];
              return (
                <g key={id} className="gq-node" style={{ transform: `translate(${x}px, ${y}px)` }}>
                  <g className="gq-node-inner">
                    <title>{`${id} — ${c.message}`}</title>
                    {id === g.hid && <circle r={16} className="gq-head-ring" />}
                    <circle r={11} fill={color(id)} className={c.parents.length > 1 ? "gq-merge" : ""} />
                    <text y={4} className="gq-node-hash">
                      {id.slice(0, 2)}
                    </text>
                    <text y={30} className="gq-node-msg">
                      {msg.length > 11 ? `${msg.slice(0, 10)}…` : msg}
                    </text>
                    {refs.map((r, i) => {
                      const w = r.label.length * 6.6 + 14;
                      return (
                        <g key={r.label} transform={`translate(${-w / 2}, ${-22 - (i + 1) * PILL_H + 4})`}>
                          <rect width={w} height={PILL_H - 3} rx={7} className={`gq-pill gq-pill-${r.kind} ${r.active ? "active" : ""}`} />
                          <text x={w / 2} y={11.5} className="gq-pill-text">
                            {r.label}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
