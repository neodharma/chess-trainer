import { useEffect, useRef, useState } from "react";
import { Chessground } from "chessground";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";

const NUM_WORKERS = 4;
const WS_URL = "ws://localhost:8765";
// How long to hold transient status frames so the user actually sees them
// before the next message overwrites. Without this, "new_game" lasts only
// ~100µs (between game end and first move push) and the 60Hz relay never
// catches it; "found" lasts ~1ms (between accept and break-to-next-game).
const HOLD_MS = { found: 250 };

const STATUS_LABELS = {
  playing: "playing",
  evaluating: "analyzing…",
  found: "✓ found",
  new_game: "new game",
};

const STATUS_COLORS = {
  playing: "#475569",     // neutral slate
  evaluating: "#eab308",  // amber (Stockfish thinking)
  found: "#22c55e",       // green (accepted scenario)
  new_game: "#3b82f6",    // blue (new game)
};

function Board({ workerId, state }) {
  const containerRef = useRef(null);
  const apiRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || apiRef.current) return;
    apiRef.current = Chessground(containerRef.current, {
      viewOnly: true,
      coordinates: false,
      animation: { enabled: false },
      drawable: { enabled: false },
    });
    return () => {
      apiRef.current?.destroy?.();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (apiRef.current && state?.fen) apiRef.current.set({ fen: state.fen });
  }, [state?.fen]);

  const status = state?.status || "playing";
  const accent = STATUS_COLORS[status] || STATUS_COLORS.playing;
  const isPulsing = status === "evaluating";

  return (
    <div style={{ ...styles.boardCard, borderColor: accent, boxShadow: status === "found" ? `0 0 18px ${accent}66` : "none" }}>
      <div style={styles.boardLabel}>
        <span style={styles.workerBadge}>Worker {workerId}</span>
        <span
          style={{
            ...styles.statusPill,
            color: accent,
            borderColor: accent,
            animation: isPulsing ? "vizPulse 1s ease-in-out infinite" : "none",
          }}
        >
          {STATUS_LABELS[status] || status}
        </span>
      </div>
      <div ref={containerRef} style={styles.boardSquare} />
      <div style={state?.fen ? styles.fenText : styles.fenWaiting}>
        {state?.fen ? state.fen.split(" ")[0] : "waiting…"}
      </div>
    </div>
  );
}

export default function Viz() {
  const [boardStates, setBoardStates] = useState({});
  const [connStatus, setConnStatus] = useState("connecting");
  // Per-worker hold timers: while active, defer non-"found" updates so the
  // user actually sees a "found" frame before it gets overwritten.
  const holdsRef = useRef({});
  const incomingRef = useRef({});

  useEffect(() => {
    let ws;
    let reconnectTimer;
    let cancelled = false;

    const flushWorker = (wid) => {
      const incoming = incomingRef.current[wid];
      if (incoming) {
        setBoardStates((prev) => ({ ...prev, [wid]: incoming }));
      }
    };

    const connect = () => {
      if (cancelled) return;
      setConnStatus("connecting");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => setConnStatus("connected");

      ws.onmessage = (e) => {
        try {
          const { worker, fen, status } = JSON.parse(e.data);
          const incoming = { fen, status: status || "playing" };
          incomingRef.current[worker] = incoming;

          const holdMs = HOLD_MS[incoming.status];
          if (holdMs) {
            // Apply now and lock for holdMs so the next message doesn't overwrite.
            setBoardStates((prev) => ({ ...prev, [worker]: incoming }));
            if (holdsRef.current[worker]) clearTimeout(holdsRef.current[worker]);
            holdsRef.current[worker] = setTimeout(() => {
              holdsRef.current[worker] = null;
              flushWorker(worker);
            }, holdMs);
          } else if (!holdsRef.current[worker]) {
            // No hold active — apply immediately.
            setBoardStates((prev) => ({ ...prev, [worker]: incoming }));
          }
          // else: hold active; the timeout above will flush latest after expiry.
        } catch {}
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnStatus("disconnected");
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      Object.values(holdsRef.current).forEach((t) => t && clearTimeout(t));
      ws?.close();
    };
  }, []);

  const connColor = {
    connected: "#22c55e",
    connecting: "#94a3b8",
    disconnected: "#f87171",
  }[connStatus];

  return (
    <div style={styles.page}>
      <style>{`@keyframes vizPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }`}</style>

      <header style={styles.header}>
        <h1 style={styles.title}>Miner · Live</h1>
        <div style={styles.statusBlock}>
          <span style={{ ...styles.statusDot, background: connColor }} />
          <span style={{ color: connColor, fontSize: "13px" }}>{connStatus}</span>
        </div>
      </header>

      <div style={styles.grid}>
        {Array.from({ length: NUM_WORKERS }, (_, i) => (
          <Board key={i} workerId={i} state={boardStates[i]} />
        ))}
      </div>

      <footer style={styles.footer}>
        <span style={{ color: STATUS_COLORS.playing }}>● playing</span>{"  "}
        <span style={{ color: STATUS_COLORS.evaluating }}>● analyzing</span>{"  "}
        <span style={{ color: STATUS_COLORS.found }}>● found</span>{"  "}
        <span style={{ color: STATUS_COLORS.new_game }}>● new game</span>
      </footer>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "var(--bg, #0f172a)",
    color: "var(--text, #e2e8f0)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    padding: "24px",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: "880px",
    margin: "0 auto 24px",
  },
  title: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 600,
    letterSpacing: "0.3px",
  },
  statusBlock: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  statusDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    boxShadow: "0 0 8px currentColor",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(320px, 1fr))",
    gap: "20px",
    maxWidth: "880px",
    margin: "0 auto",
  },
  boardCard: {
    background: "var(--surface, #1e293b)",
    borderRadius: "10px",
    padding: "12px",
    border: "2px solid #475569",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  boardLabel: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
  },
  workerBadge: {
    fontSize: "12px",
    fontWeight: 600,
    padding: "3px 8px",
    background: "var(--accent, #3b82f6)",
    color: "var(--bg, #0f172a)",
    borderRadius: "999px",
  },
  statusPill: {
    fontSize: "11px",
    fontWeight: 600,
    padding: "2px 8px",
    border: "1px solid",
    borderRadius: "999px",
    background: "transparent",
    textTransform: "lowercase",
    letterSpacing: "0.3px",
    minWidth: "70px",
    textAlign: "center",
  },
  fenText: {
    fontSize: "10px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--text-dim, #94a3b8)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fenWaiting: {
    fontSize: "10px",
    color: "var(--text-dim, #94a3b8)",
    fontStyle: "italic",
  },
  boardSquare: {
    width: "100%",
    aspectRatio: "1 / 1",
  },
  footer: {
    maxWidth: "880px",
    margin: "24px auto 0",
    fontSize: "11px",
    color: "var(--text-dim, #94a3b8)",
    textAlign: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};
