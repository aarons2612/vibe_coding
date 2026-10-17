import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Line } from "../../../core/git";

interface Props {
  lines: Line[];
  prompt: string;
  onSubmit: (input: string) => void;
  complete: (before: string[], partial: string) => string[];
  disabled?: boolean;
}

const commonPrefix = (xs: string[]) =>
  xs.reduce((p, x) => {
    let i = 0;
    while (i < p.length && p[i] === x[i]) i++;
    return p.slice(0, i);
  });

export default function Terminal({ lines, prompt, onSubmit, complete, disabled }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [lines, suggestions]);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const cmd = input.trim();
      setSuggestions([]);
      if (!cmd) return;
      setHistory((h) => [...h, cmd]);
      setHistIdx(-1);
      setInput("");
      onSubmit(cmd);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (!history.length) return;
      const idx =
        e.key === "ArrowUp"
          ? histIdx === -1
            ? history.length - 1
            : Math.max(0, histIdx - 1)
          : histIdx === -1
            ? -1
            : histIdx + 1 >= history.length
              ? -1
              : histIdx + 1;
      setHistIdx(idx);
      setInput(idx === -1 ? "" : history[idx]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const parts = input.split(" ");
      const partial = parts.pop() ?? "";
      const cands = complete(parts.filter(Boolean), partial).filter((c) => c.startsWith(partial));
      if (!cands.length) return;
      const prefix = cands.length === 1 ? `${cands[0]} ` : commonPrefix(cands);
      setInput([...parts, prefix].join(" "));
      setSuggestions(cands.length > 1 ? cands : []);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      onSubmit("clear");
    }
  };

  return (
    <div className="gq-terminal" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-header">
        <div className="terminal-dots">
          <span className="dot dot-red" />
          <span className="dot dot-yellow" />
          <span className="dot dot-green" />
        </div>
        <span className="terminal-filename">bash — /dungeon/repo</span>
        <span className="terminal-lang">↑↓ history · Tab completes</span>
      </div>
      <div className="gq-term-body" ref={body}>
        {lines.map((l, i) => (
          <div key={i} className={`gq-line gq-line-${l.kind}`}>
            {l.text || " "}
          </div>
        ))}
        {suggestions.length > 0 && <div className="gq-line gq-line-hint">{suggestions.join("   ")}</div>}
        <div className="gq-input-row">
          <span className="gq-prompt">{prompt}</span>
          <input
            ref={inputRef}
            className="gq-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Terminal input"
          />
        </div>
      </div>
    </div>
  );
}
