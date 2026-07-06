import { useState, useEffect, useRef } from "react";
import Board from "./Board.jsx";
import { createGameStore } from "./gameStore.js";
import { createEngineController } from "./engineController.js";
import { filterScenarios } from "./gameLogic.js";
import { useGameStore } from "./useGameStore.js";

const TIER_LABELS = {
  best: "Best!", good: "Good", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder"
};
const TIER_COLORS = {
  best: "var(--accent2)", good: "var(--text-dim)", inaccuracy: "var(--accent)",
  mistake: "var(--bad)", blunder: "var(--bad)"
};

const gameStore = createGameStore({
  createEngine: (handlers) => createEngineController({
    createWorker: () => new Worker("/stockfish-17.1-lite-single-03e3232.js"),
    ...handlers
  }),
  storage: typeof localStorage !== "undefined" ? localStorage : null
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => gameStore.dispose());
}

export default function App() {
  const game = useGameStore(gameStore);

  const [scenarios, setScenarios] = useState([]);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  // Move feedback
  const [showBest, setShowBest] = useState(false);

  // --- FILTERS ---
  // Piece-type chips: OR semantics within selection; empty set = no constraint.
  const [selectedPieces, setSelectedPieces] = useState(() => new Set());
  // Independent boolean axes (AND with the piece-type filter).
  const [requirePuzzle, setRequirePuzzle] = useState(false);
  const [requireImbalance, setRequireImbalance] = useState(false);

  const [filterEvalMode, setFilterEvalMode] = useState("drawn"); // "drawn", "advantage", "all"
  const [minMaterial, setMinMaterial] = useState(10);
  const [maxMaterial, setMaxMaterial] = useState(25);

  const [jumpId, setJumpId] = useState("");

  // Sidebar (persisted across sessions on this device)
  const HISTORY_KEY = "chess-trainer-history";
  const [sidebarHistory, setSidebarHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });

  // Responsive State
  const [isMobile, setIsMobile] = useState(window.innerWidth < 800);

  const moveListRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(sidebarHistory)); } catch {}
  }, [sidebarHistory]);

  // Keep the move log scrolled to the latest move
  useEffect(() => {
    const el = moveListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [game.history.length]);

  // HANDLE RESIZE
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 800);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // KEYBOARD SHORTCUTS
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in inputs
      if (e.target.tagName === "INPUT") return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        gameStore.navigate(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        gameStore.navigate(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        gameStore.navigate("start");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        gameStore.navigate("end");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 1. FETCH DATA
  useEffect(() => {
    fetch("/scenarios.json")
      .then((res) => res.json())
      .then((data) => setScenarios(data))
      .catch((err) => console.error(err));
  }, []);

  // 2. AUTO-LOAD
  useEffect(() => {
    if (scenarios.length > 0 && !gameStore.getState().scenario) {
      loadRandomScenario();
    }
  }, [scenarios]);

  function togglePiece(key) {
    setSelectedPieces(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function loadScenario(scenario) {
    setFeedbackMessage("");
    setSidebarHistory(prev => {
      const filtered = prev.filter(s => s.id !== scenario.id);
      return [scenario, ...filtered];
    });
    gameStore.loadScenario(scenario);
  }

  function loadRandomScenario() {
    if (scenarios.length === 0) return;
    setFeedbackMessage("");

    const pool = filterScenarios(scenarios, {
      selectedPieces, requirePuzzle, requireImbalance, minMaterial, maxMaterial, filterEvalMode
    });

    if (pool.length === 0) {
      setFeedbackMessage("No scenarios found matching criteria.");
      return;
    }

    loadScenario(pool[Math.floor(Math.random() * pool.length)]);
  }

  function jumpToScenario() {
    const id = parseInt(jumpId);
    if (!id) return;
    const found = scenarios.find(s => s.id === id);
    if (found) {
      loadScenario(found);
      setJumpId("");
    } else {
      alert(`Scenario #${id} not found.`);
    }
  }

  // --- DUAL SLIDER HANDLERS ---
  const handleMinChange = (e) => {
    const val = Math.min(Number(e.target.value), maxMaterial - 1);
    setMinMaterial(val);
  };
  const handleMaxChange = (e) => {
    const val = Math.max(Number(e.target.value), minMaterial + 1);
    setMaxMaterial(val);
  };

  const minPercent = ((minMaterial - 10) / (25 - 10)) * 100;
  const maxPercent = ((maxMaterial - 10) / (25 - 10)) * 100;

  // --- DERIVED GAME VALUES ---
  const currentScenario = game.scenario;
  const viewedSnapshot = game.history[game.index];
  const turnInfo = viewedSnapshot
    ? (viewedSnapshot.fen.split(" ")[1] === "w" ? "white" : "black")
    : game.playerColor;
  const showGameOver = game.status === "gameOver" && game.gameOverInfo;
  const atStart = game.index <= 0;
  const atEnd = game.index >= game.history.length - 1;

  // --- DYNAMIC STYLES ---
  const boardSize = isMobile ? "90vw" : "500px";

  const responsiveStyles = {
    mainLayout: {
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      gap: "30px",
      alignItems: "center",
      width: "100%",
      maxWidth: "1150px",
      justifyContent: "center"
    },
    moveLog: {
      width: isMobile ? "90vw" : "220px",
      background: "var(--surface)",
      borderRadius: "var(--radius)",
      padding: "15px",
      border: "1px solid var(--surface2)",
      height: isMobile ? "auto" : "500px",
      maxHeight: isMobile ? "260px" : "500px",
      display: "flex",
      flexDirection: "column"
    },
    sidebar: {
      width: isMobile ? "90vw" : "200px",
      background: "var(--surface)",
      borderRadius: "var(--radius)",
      padding: "15px",
      border: "1px solid var(--surface2)",
      height: isMobile ? "auto" : "500px",
      maxHeight: isMobile ? "300px" : "500px",
      display: "flex",
      flexDirection: "column"
    },
    board: {
      width: boardSize,
      height: boardSize
    }
  };

  // Pair move snapshots into "1. Kd4 Kf6" rows (index 0 is the start position)
  const moveRows = [];
  game.history.forEach((entry, index) => {
    if (!entry.san) return;
    const last = moveRows[moveRows.length - 1];
    if (entry.color === "w") {
      moveRows.push({ num: entry.moveNumber, white: { entry, index }, black: null });
    } else if (last && last.white && !last.black) {
      last.black = { entry, index };
    } else {
      moveRows.push({ num: entry.moveNumber, white: null, black: { entry, index } });
    }
  });

  const renderMoveCell = (cell, isWhiteCell) => {
    // Black-first rows show "…" in the white slot; an unplayed black slot stays blank
    if (!cell) return <span style={styles.moveCell}>{isWhiteCell ? "…" : ""}</span>;
    const { entry, index } = cell;
    const fb = entry.moveBy === "player" ? entry.feedback : null;
    return (
      <span
        style={index === game.index ? styles.moveCellActive : styles.moveCell}
        onClick={() => gameStore.navigate(index)}
      >
        <span style={styles.moveSanRow}>
          {entry.san}
          {fb?.tier && (
            <span style={{ ...styles.feedbackBadge, color: TIER_COLORS[fb.tier] }}>
              {TIER_LABELS[fb.tier]}
            </span>
          )}
        </span>
        {showBest && fb?.bestMoveSan && (
          <span style={styles.bestHint}>best: {fb.bestMoveSan}</span>
        )}
      </span>
    );
  };

  return (
    <div style={styles.appContainer}>
      {/* CSS Injection to ensure sliders work */}
      <style>
        {`
        input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            pointer-events: all;
            width: 16px; height: 16px;
            border-radius: 50%; background: var(--accent);
            cursor: pointer; margin-top: -6px;
            box-shadow: 0 0 2px rgba(0,0,0,0.5);
        }
        input[type=range]::-moz-range-thumb {
            pointer-events: all;
            width: 16px; height: 16px;
            border: none; border-radius: 50%;
            background: var(--accent); cursor: pointer;
            box-shadow: 0 0 2px rgba(0,0,0,0.5);
        }
        `}
      </style>

      <h2 style={styles.header}>Bennett's Endgame Dojo</h2>

      <div style={responsiveStyles.mainLayout}>
        <div style={styles.gameColumn}>

            <div style={styles.infoBar}>
                {currentScenario ? (
                    <div style={styles.scenarioBox}>
                        <span style={styles.scenarioId}>#{currentScenario.id}</span>
                        {currentScenario.eval !== undefined && (
                        <span style={styles.initialEval}>
                            Init: {currentScenario.eval > 0 ? "+" : ""}{currentScenario.eval}
                        </span>
                        )}
                        {game.currentEval !== null && (
                        <span style={{
                            ...styles.initialEval,
                            color: game.currentEval > 0 ? "var(--accent2)"
                                 : game.currentEval < 0 ? "var(--bad)"
                                 : "var(--text)",
                            fontWeight: "bold"
                        }}>
                            Live: {game.currentEval > 0 ? "+" : ""}{game.currentEval.toFixed(2)}
                        </span>
                        )}
                        <span style={styles.turnBadge}>
                            {turnInfo === 'white' ? "⚪ White" : "⚫ Black"}
                        </span>
                    </div>
                ) : (
                    <p style={{color: "var(--text-dim)"}}>Loading Dojo...</p>
                )}
            </div>

            <div style={{...styles.boardContainer, width: boardSize, height: boardSize}}>
                {/* GAME OVER MODAL */}
                {showGameOver && (
                    <div style={styles.overlay}>
                        <div style={styles.countdownText}>{game.gameOverInfo.title}</div>
                        <div style={{fontSize: "22px", color: "var(--text)", marginTop: "10px"}}>{game.gameOverInfo.result}</div>
                        <button style={styles.primaryButton} onClick={loadRandomScenario}>
                             New Game 🎲
                        </button>
                    </div>
                )}

                <Board store={gameStore} state={game} />
            </div>

            {currentScenario && currentScenario.players && (
                <div style={styles.metadata}>
                    {currentScenario.players} ({currentScenario.year || "Unknown"})
                    {currentScenario.result && currentScenario.result !== "*" && (
                        <>  ·  Result: <strong>{currentScenario.result}</strong></>
                    )}
                </div>
            )}

            {/* NAV BAR */}
            <div style={styles.navBar}>
                <button
                    style={{...styles.navButton, ...(atStart ? styles.disabledNav : {})}}
                    onClick={() => gameStore.navigate("start")}
                    disabled={atStart}
                    title="Back to Start"
                >⏮</button>
                <button
                    style={{...styles.navButton, ...(atStart ? styles.disabledNav : {})}}
                    onClick={() => gameStore.navigate(-1)}
                    disabled={atStart}
                    title="Undo Turn"
                >◀</button>
                <button
                    style={{...styles.navButton, ...(atEnd ? styles.disabledNav : {})}}
                    onClick={() => gameStore.navigate(1)}
                    disabled={atEnd}
                    title="Redo Turn"
                >▶</button>
                <button
                    style={{...styles.navButton, ...(atEnd ? styles.disabledNav : {})}}
                    onClick={() => gameStore.navigate("end")}
                    disabled={atEnd}
                    title="Forward to Live"
                >⏭</button>
            </div>

            <div style={styles.optionsPanel}>

                {/* 1. PIECE-TYPE CHIPS — OR within selection; empty = no constraint */}
                <div style={styles.optionsRow}>
                    <span style={styles.labelTitle}>Piece type:</span>
                    <div style={styles.chipRow}>
                        {[
                            {key: 'rook',   label: 'Rook'},
                            {key: 'bishop', label: 'Bishop'},
                            {key: 'knight', label: 'Knight'},
                            {key: 'pawn',   label: 'Pawn'},
                        ].map(p => (
                            <button
                                key={p.key}
                                type="button"
                                style={selectedPieces.has(p.key) ? styles.chipActive : styles.chip}
                                onClick={() => togglePiece(p.key)}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 2. INDEPENDENT TOGGLES (AND with piece selection) */}
                <div style={styles.optionsRow}>
                    <button
                        type="button"
                        style={requirePuzzle ? styles.chipActive : styles.chip}
                        onClick={() => setRequirePuzzle(!requirePuzzle)}
                    >
                        Puzzles (WIP)
                    </button>
                    <button
                        type="button"
                        style={requireImbalance ? styles.chipActive : styles.chip}
                        onClick={() => setRequireImbalance(!requireImbalance)}
                    >
                        Imbalance
                    </button>
                </div>

                <div style={styles.divider}></div>

                {/* 2. EVAL MODE */}
                <div style={styles.optionsRow}>
                    <span style={styles.labelTitle}>Eval:</span>
                    <label style={styles.radioLabel}>
                        <input type="radio" name="evalMode" checked={filterEvalMode === "drawn"} onChange={() => setFilterEvalMode("drawn")} />
                        Drawn
                    </label>
                    <label style={styles.radioLabel}>
                        <input type="radio" name="evalMode" checked={filterEvalMode === "advantage"} onChange={() => setFilterEvalMode("advantage")} />
                        Advantage
                    </label>
                    <label style={styles.radioLabel}>
                        <input type="radio" name="evalMode" checked={filterEvalMode === "all"} onChange={() => setFilterEvalMode("all")} />
                        All
                    </label>
                </div>

                {/* 3. ENGINE DEPTH */}
                <div style={styles.optionsRow}>
                    <span style={styles.labelTitle}>Engine depth:</span>
                    <div style={styles.triStateGroup}>
                        {[12, 18, 24].map(d => (
                            <label
                                key={d}
                                style={game.depth === d ? styles.triOptionActive : styles.triOption}
                            >
                                <input
                                    type="radio"
                                    name="engineDepth"
                                    checked={game.depth === d}
                                    onChange={() => gameStore.setDepth(d)}
                                    style={{ display: "none" }}
                                />
                                {d}
                            </label>
                        ))}
                    </div>
                </div>

                {/* 4. MATERIAL SLIDER */}
                <div style={styles.optionsRow}>
                    <span style={styles.labelTitle}>Material ({minMaterial} - {maxMaterial}):</span>
                    <div style={styles.sliderContainer}>
                        <div style={styles.sliderTrack}></div>
                        <div
                            style={{
                                ...styles.sliderRange,
                                left: `${minPercent}%`,
                                width: `${maxPercent - minPercent}%`
                            }}
                        ></div>
                        <input
                            type="range" min="10" max="25" step="1"
                            value={minMaterial} onChange={handleMinChange}
                            style={styles.thumbInput}
                        />
                         <input
                            type="range" min="10" max="25" step="1"
                            value={maxMaterial} onChange={handleMaxChange}
                            style={styles.thumbInput}
                        />
                    </div>
                </div>

            </div>

            <div style={styles.controls}>
                <button style={styles.primaryButton} onClick={loadRandomScenario}>
                    Load Random 🎲
                </button>
            </div>

            {feedbackMessage && (
                <div style={{color: "var(--bad)", marginTop: "10px", fontSize: "14px", fontWeight: "bold"}}>
                    {feedbackMessage}
                </div>
            )}
        </div>

        <div style={responsiveStyles.moveLog}>
            <div style={styles.sidebarHeader}>
                <h3 style={styles.sidebarTitle}>Moves</h3>
                <button
                    type="button"
                    style={showBest ? styles.showBestActive : styles.clearButton}
                    onClick={() => setShowBest(v => !v)}
                    title="Reveal the engine's best move for moves that weren't best"
                >
                    Show best
                </button>
            </div>
            <div ref={moveListRef} style={styles.moveLogList}>
                {moveRows.length === 0 && (
                    <span style={{color: "var(--text-dim)", fontStyle: "italic", fontSize: "14px"}}>No moves yet</span>
                )}
                {moveRows.map((row, i) => (
                    <div key={i} style={styles.moveRow}>
                        <span style={styles.moveNum}>{row.num}.</span>
                        {renderMoveCell(row.white, true)}
                        {renderMoveCell(row.black, false)}
                    </div>
                ))}
            </div>
        </div>

        <div style={responsiveStyles.sidebar}>
            <div style={styles.sidebarHeader}>
                <h3 style={styles.sidebarTitle}>Recent History</h3>
                {sidebarHistory.length > 0 && (
                    <button
                        type="button"
                        style={styles.clearButton}
                        onClick={() => setSidebarHistory([])}
                        title="Clear history"
                    >
                        Clear
                    </button>
                )}
            </div>
            <div style={styles.historyList}>
                {sidebarHistory.length === 0 && <span style={{color: "var(--text-dim)", fontStyle: "italic", fontSize: "14px"}}>No games yet</span>}
                {sidebarHistory.map((item) => (
                    <div
                        key={item.id}
                        style={currentScenario && currentScenario.id === item.id ? styles.historyItemActive : styles.historyItem}
                        onClick={() => loadScenario(item)}
                    >
                        <span style={styles.historyId}>#{item.id}</span>
                        <div style={styles.historyMeta}>
                            <span>{item.players ? item.players.split(" vs ")[0] : "Unknown"}...</span>
                            <span style={{fontSize: "10px", color: "var(--text-dim)"}}>({item.eval_tag ? item.eval_tag : "?"})</span>
                        </div>
                    </div>
                ))}
            </div>

            <div style={styles.jumpSection}>
                <span style={{fontSize: "12px", color: "var(--text-dim)", marginBottom: "5px"}}>Jump to ID:</span>
                <div style={styles.jumpControls}>
                    <input
                        style={styles.jumpInput} placeholder="#"
                        value={jumpId} onChange={(e) => setJumpId(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && jumpToScenario()}
                    />
                    <button style={styles.jumpButton} onClick={jumpToScenario}>Go</button>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  appContainer: {
    display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "20px",
    background: "var(--bg)", color: "var(--text)", minHeight: "100vh", width: "100vw", boxSizing: "border-box",
    paddingBottom: "50px"
  },
  header: {
    fontSize: "clamp(20px, 5vw, 24px)",
    fontWeight: "700", margin: "0 0 15px 0",
    letterSpacing: "0.5px", color: "var(--text)", textAlign: "center"
  },
  gameColumn: {
      display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: "500px"
  },
  navBar: {
      display: "flex", gap: "2px", marginTop: "10px", background: "var(--surface)", borderRadius: "6px", overflow: "hidden",
      border: "1px solid var(--surface2)"
  },
  navButton: {
      background: "transparent", border: "none", color: "var(--text)", fontSize: "18px",
      padding: "5px 15px", cursor: "pointer", transition: "background 0.2s", fontFamily: "inherit"
  },
  disabledNav: {
      opacity: 0.3, cursor: "not-allowed"
  },
  sidebarHeader: {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      borderBottom: "1px solid var(--surface2)", paddingBottom: "10px", marginBottom: "15px"
  },
  sidebarTitle: {
      margin: 0, fontSize: "0.85rem", color: "var(--text-dim)",
      textTransform: "uppercase", letterSpacing: "1px"
  },
  clearButton: {
      padding: "3px 8px", borderRadius: "4px", border: "1px solid var(--surface2)",
      background: "transparent", color: "var(--text-dim)", cursor: "pointer",
      fontSize: "11px", fontFamily: "inherit"
  },
  showBestActive: {
      padding: "3px 8px", borderRadius: "4px", border: "1px solid var(--accent)",
      background: "var(--accent)", color: "var(--bg)", cursor: "pointer",
      fontSize: "11px", fontFamily: "inherit", fontWeight: "bold"
  },
  // --- MOVE LOG ---
  moveLogList: {
      flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px"
  },
  moveRow: {
      display: "flex", alignItems: "flex-start", gap: "4px", fontSize: "13px"
  },
  moveNum: {
      color: "var(--text-dim)", width: "24px", flexShrink: 0, textAlign: "right",
      paddingTop: "3px", fontSize: "12px"
  },
  moveCell: {
      flex: 1, padding: "3px 6px", borderRadius: "4px", cursor: "pointer",
      display: "flex", flexDirection: "column", color: "var(--text)"
  },
  moveCellActive: {
      flex: 1, padding: "3px 6px", borderRadius: "4px", cursor: "pointer",
      display: "flex", flexDirection: "column", color: "var(--text)",
      background: "var(--surface2)"
  },
  moveSanRow: {
      display: "flex", alignItems: "center", gap: "5px"
  },
  feedbackBadge: {
      fontSize: "10px", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.3px"
  },
  bestHint: {
      fontSize: "11px", color: "var(--accent2)", fontStyle: "italic"
  },
  historyList: {
      flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px"
  },
  historyItem: {
      background: "var(--bg)", padding: "8px", borderRadius: "4px", cursor: "pointer",
      borderLeft: "3px solid transparent", transition: "background 0.2s, border-color 0.2s"
  },
  historyItemActive: {
      background: "var(--surface2)", padding: "8px", borderRadius: "4px", cursor: "pointer",
      borderLeft: "3px solid var(--accent)"
  },
  historyId: { fontWeight: "bold", color: "var(--accent)", fontSize: "12px", display: "block" },
  historyMeta: { fontSize: "12px", color: "var(--text-dim)", display: "flex", justifyContent: "space-between" },
  jumpSection: {
      marginTop: "15px", borderTop: "1px solid var(--surface2)", paddingTop: "15px", display: "flex", flexDirection: "column"
  },
  infoBar: {
    height: "50px", marginBottom: "5px", display: "flex", alignItems: "center", justifyContent: "center", width: "100%"
  },
  scenarioBox: {
    display: "flex", gap: "10px", alignItems: "center", background: "var(--surface)",
    padding: "8px 16px", borderRadius: "20px", fontSize: "14px", border: "1px solid var(--surface2)"
  },
  scenarioId: { fontWeight: "bold", color: "var(--accent)" },
  initialEval: { color: "var(--text-dim)", fontSize: "0.9em" },
  turnBadge: {
    background: "var(--bg)", padding: "2px 8px", borderRadius: "4px", color: "var(--text)",
    fontSize: "12px", fontWeight: "600", border: "1px solid var(--surface2)"
  },
  boardContainer: {
    position: "relative",
    padding: "10px", background: "var(--surface)", borderRadius: "var(--radius)",
    border: "1px solid var(--surface2)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
  },
  overlay: {
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(15,15,16,0.88)", zIndex: 100,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      borderRadius: "var(--radius)"
  },
  countdownText: { fontSize: "40px", fontWeight: "bold", color: "var(--text)", textAlign: "center" },
  metadata: {
      marginTop: "10px", color: "var(--text-dim)", fontStyle: "italic", fontSize: "14px", textAlign: "center"
  },
  optionsPanel: {
      marginTop: "15px", display: "flex", flexDirection: "column", gap: "15px",
      width: "100%", padding: "15px", background: "var(--surface)",
      border: "1px solid var(--surface2)", borderRadius: "var(--radius)"
  },
  optionsRow: {
      display: "flex", gap: "15px", flexWrap: "wrap", justifyContent: "center", alignItems: "center"
  },
  divider: {
      height: "1px", background: "var(--surface2)", width: "100%"
  },
  radioLabel: {
      fontSize: "13px", color: "var(--text)", display: "flex", alignItems: "center", gap: "4px", cursor: "pointer"
  },
  labelTitle: {
      fontSize: "11px", color: "var(--text-dim)", fontWeight: "bold", textTransform: "uppercase",
      letterSpacing: "0.5px", marginBottom: "4px", display: "block"
  },
  // --- CHIP / PILL STYLES ---
  chipRow: {
      display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center"
  },
  chip: {
      padding: "6px 14px", fontSize: "12px",
      background: "var(--bg)", color: "var(--text-dim)",
      border: "1px solid var(--surface2)", borderRadius: "999px",
      cursor: "pointer", userSelect: "none",
      transition: "background 0.15s, color 0.15s, border-color 0.15s"
  },
  chipActive: {
      padding: "6px 14px", fontSize: "12px",
      background: "var(--accent)", color: "var(--bg)",
      border: "1px solid var(--accent)", borderRadius: "999px",
      cursor: "pointer", userSelect: "none", fontWeight: "bold",
      transition: "background 0.15s, color 0.15s, border-color 0.15s"
  },
  // --- TRI-STATE STYLES (Engine Depth segmented control) ---
  triStateGroup: {
      display: "flex", borderRadius: "4px", overflow: "hidden", border: "1px solid var(--surface2)"
  },
  triOption: {
      padding: "4px 10px", fontSize: "11px", background: "var(--bg)", color: "var(--text-dim)",
      cursor: "pointer", borderRight: "1px solid var(--surface2)", userSelect: "none"
  },
  triOptionActive: {
      padding: "4px 10px", fontSize: "11px", background: "var(--accent)", color: "var(--bg)",
      cursor: "pointer", borderRight: "1px solid var(--surface2)", fontWeight: "bold", userSelect: "none"
  },
  // --- SLIDER STYLES ---
  sliderContainer: {
      position: "relative", width: "150px", height: "20px", display: "flex", alignItems: "center"
  },
  sliderTrack: {
      position: "absolute", width: "100%", height: "4px", background: "var(--bg)",
      border: "1px solid var(--surface2)", borderRadius: "2px", zIndex: 0
  },
  sliderRange: {
      position: "absolute", height: "4px", background: "var(--accent)", borderRadius: "2px", zIndex: 1
  },
  thumbInput: {
      position: "absolute",
      width: "100%",
      pointerEvents: "none",
      appearance: "none",
      background: "transparent",
      zIndex: 2,
      margin: 0,
      height: "20px",
      WebkitAppearance: "none",
  },
  controls: { marginTop: "20px", display: "flex", gap: "15px" },
  primaryButton: {
    padding: "12px 24px", fontSize: "15px", fontWeight: "600", cursor: "pointer",
    background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: "6px",
    transition: "opacity 0.15s", fontFamily: "inherit"
  },
  jumpControls: {
      display: "flex", gap: "5px", alignItems: "center"
  },
  jumpInput: {
      padding: "8px", borderRadius: "4px", border: "1px solid var(--surface2)",
      background: "var(--bg)", color: "var(--text)", width: "100%", textAlign: "center",
      fontFamily: "inherit"
  },
  jumpButton: {
      padding: "8px 12px", borderRadius: "4px", border: "1px solid var(--surface2)",
      background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: "12px",
      fontFamily: "inherit"
  }
};
