export type ViewMode = "home" | "casual" | "dev" | "syntax" | "sim";

interface GameCard {
  mode: Exclude<ViewMode, "home">;
  icon: string;
  title: string;
  tag: string;
  tagClass: string;
  desc: string;
  how: string;
  accent: string;
  best: () => string | null;
}

const readNum = (key: string) => {
  try {
    const v = parseInt(localStorage.getItem(key) || "0", 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
};

const GAMES: GameCard[] = [
  {
    mode: "casual",
    icon: "🏗️",
    title: "Tower Stack",
    tag: "🎮 Casual",
    tagClass: "tag-casual",
    desc: "Time your clicks to stack blocks as high as you can. Climb the level map and earn stars.",
    how: "Click / Space to drop",
    accent: "#ec4899",
    best: () => {
      const b = readNum("arena_tower_best");
      const l = readNum("arena_tower_best_level");
      return b ? `Best ${b} pts · Level ${Math.max(1, l)}` : null;
    },
  },
  {
    mode: "dev",
    icon: "🌿",
    title: "Git Quest",
    tag: "💻 Dev",
    tagClass: "tag-dev",
    desc: "Rescue broken repos by typing real git commands. Match the target commit graph to win.",
    how: "Type git commands",
    accent: "#10b981",
    best: () => null,
  },
  // {
  //   mode: "syntax",
  //   icon: "⌨️",
  //   title: "Syntax Sprint",
  //   tag: "💻 Dev",
  //   tagClass: "tag-dev",
  //   desc: "Type authentic code snippets as fast and accurately as you can. Chase your best WPM.",
  //   how: "Type the snippet",
  //   accent: "#06b6d4",
  //   best: () => {
  //     const w = readNum("arena_dev_best_wpm");
  //     return w ? `Best ${w} WPM` : null;
  //   },
  // },
  {
    mode: "sim",
    icon: "🏙️",
    title: "Simulation",
    tag: "🌆 3D Open World",
    tagClass: "tag-sim",
    desc: "Explore a full-screen 3D city on foot or by car. Collect coins — but if a car hits someone, it's game over.",
    how: "WASD · E to drive · M for map",
    accent: "#facc15",
    best: () => {
      const b = readNum("arena_sim_best");
      return b ? `Best ${b} coins` : null;
    },
  },
];

interface Props {
  onOpen: (mode: Exclude<ViewMode, "home">) => void;
}

export default function Home({ onOpen }: Props) {
  return (
    <section className="home" aria-labelledby="home-title">
      <div className="home-hero">
        <h2 id="home-title" className="home-title">
          Pick a game
        </h2>
        <p className="home-sub">Four games, one arena. Your best scores are saved in this browser.</p>
      </div>

      <div className="home-grid">
        {GAMES.map((g) => {
          const best = g.best();
          return (
            <button
              key={g.mode}
              id={`home-play-${g.mode}`}
              className="home-card"
              style={{ ["--accent" as string]: g.accent }}
              onClick={() => onOpen(g.mode)}
            >
              <span className="home-card-icon" aria-hidden="true">
                {g.icon}
              </span>
              <span className={`tag-badge ${g.tagClass}`}>{g.tag}</span>
              <span className="home-card-title">{g.title}</span>
              <span className="home-card-desc">{g.desc}</span>
              <span className="home-card-how">{g.how}</span>
              <span className="home-card-foot">
                <span className="home-card-best">{best ?? "Not played yet"}</span>
                <span className="home-card-play">Play →</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
