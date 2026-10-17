import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="page">
      <section className="card" aria-labelledby="page-title">
        <div className="badge">
          <span className="badge-dot" aria-hidden="true" />
          Your project is ready
        </div>
        <p className="eyebrow">A fresh start</p>
        <h1 id="page-title">
          Build something
          <br />
          <span>great.</span>
        </h1>
        <p className="intro">
          Your React app is up and running. Edit <code>src/App.tsx</code> to
          make it yours.
        </p>

        <div className="counter" aria-live="polite">
          <span className="counter-label">Clicks so far</span>
          <strong className="counter-value">{count}</strong>
          <div className="counter-actions">
            <button
              className="button button-primary"
              onClick={() => setCount((current) => current + 1)}
            >
              Count +
            </button>
            <button
              className="button button-secondary"
              onClick={() => setCount(0)}
              disabled={count === 0}
            >
              Reset
            </button>
          </div>
        </div>

        <footer>
          <span>React</span>
          <span className="footer-divider" aria-hidden="true">
            /
          </span>
          <span>TypeScript</span>
          <span className="footer-divider" aria-hidden="true">
            /
          </span>
          <span>Vite</span>
        </footer>
      </section>
    </main>
  );
}

export default App;
