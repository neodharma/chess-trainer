import { useState, useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessground } from "chessground"; 
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";

export default function App() {
  const [engineStatus, setEngineStatus] = useState("Initializing...");
  const [scenarios, setScenarios] = useState([]);
  const [currentScenario, setCurrentScenario] = useState(null);
  
  // Game State
  const [currentEval, setCurrentEval] = useState(null);
  const [playerColor, setPlayerColor] = useState("white"); 
  const [turnInfo, setTurnInfo] = useState("white");
  const [gameOver, setGameOver] = useState(null);
  const [feedbackMessage, setFeedbackMessage] = useState("");

  // History System
  const [gameHistory, setGameHistory] = useState([]); 
  const [historyIndex, setHistoryIndex] = useState(0); 

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

  // Engine depth (12 / 18 / 24)
  const [engineDepth, setEngineDepth] = useState(() => {
    const saved = parseInt(localStorage.getItem("chess-trainer-depth"), 10);
    return [12, 18, 24].includes(saved) ? saved : 12;
  });

  // Responsive State
  const [isMobile, setIsMobile] = useState(window.innerWidth < 800);

  const chessRef = useRef(new Chess());
  const boardRef = useRef(null);
  const apiRef = useRef(null);
  const engine = useRef(null);

  // REFS
  const playerColorRef = useRef(playerColor);
  const historyIndexRef = useRef(historyIndex);
  const gameHistoryRef = useRef(gameHistory);
  const engineDepthRef = useRef(engineDepth);

  const isReplayingRef = useRef(false);

  useEffect(() => { playerColorRef.current = playerColor; }, [playerColor]);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
  useEffect(() => { gameHistoryRef.current = gameHistory; }, [gameHistory]);
  useEffect(() => {
    engineDepthRef.current = engineDepth;
    try { localStorage.setItem("chess-trainer-depth", String(engineDepth)); } catch {}
  }, [engineDepth]);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(sidebarHistory)); } catch {}
  }, [sidebarHistory]);

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
        navigateHistory(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateHistory(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); 
        navigateHistory("start");
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); 
        navigateHistory("end");
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
      if (scenarios.length > 0 && !currentScenario) {
          loadRandomScenario();
      }
  }, [scenarios]);

  // 3. ENGINE LISTENER
  useEffect(() => {
    if (!engine.current) {
      engine.current = new Worker("/stockfish-17.1-lite-single-03e3232.js");
      
      engine.current.onmessage = (event) => {
        const message = event.data;

        if (message.startsWith("info") && message.includes("score cp")) {
          const match = message.match(/score cp (-?\d+)/);
          if (match) {
            const rawCp = parseInt(match[1], 10);
            const turn = chessRef.current.turn(); 
            const absoluteCp = (turn === 'w') ? rawCp : -rawCp;
            const evalFloat = absoluteCp / 100.0;
            setCurrentEval(evalFloat);
          }
        }

        if (message.startsWith("bestmove")) {
          if (isReplayingRef.current) {
              setEngineStatus("Reviewing (Eval Only)");
              return;
          }

          const bestMove = message.split(" ")[1];
          const from = bestMove.substring(0, 2);
          const to = bestMove.substring(2, 4);
          const promo = bestMove.length > 4 ? bestMove[4] : "q";

          const isLive = historyIndexRef.current === gameHistoryRef.current.length - 1;
          
          if (isLive) {
             handleMove(from, to, promo);
             setEngineStatus("Your Turn");
          }
        }
      };

      engine.current.postMessage("uci");
      engine.current.postMessage("isready");
    }
  }, []);

  function checkGameOver(game) {
      if (game.isGameOver()) {
          setEngineStatus("Game Over");
          engine.current?.postMessage("stop");
          
          let title = "Game Over";
          let result = "Draw";

          if (game.isCheckmate()) {
              title = "Checkmate!";
              result = game.turn() === 'w' ? "Black Wins" : "White Wins";
          } else if (game.isDraw()) {
              title = "Draw";
              if (game.isStalemate()) result = "Stalemate";
              else if (game.isThreefoldRepetition()) result = "Repetition";
              else if (game.isInsufficientMaterial()) result = "Insufficient Material";
          }
          
          setGameOver({ title, result });
          return true;
      }
      return false;
  }

  function handleMove(from, to, promo = 'q') {
      const game = chessRef.current;
      const currentIndex = historyIndexRef.current;
      const currentHistory = gameHistoryRef.current;

      if (currentIndex < currentHistory.length - 1) {
          const truncated = currentHistory.slice(0, currentIndex + 1);
          setGameHistory(truncated);
          gameHistoryRef.current = truncated; 
      }

      const move = game.move({ from, to, promotion: promo });
      if (!move) return null;

      isReplayingRef.current = false;

      const newSnapshot = { fen: game.fen(), lastMove: [from, to] };
      const updatedHistory = [...gameHistoryRef.current, newSnapshot];
      
      setGameHistory(updatedHistory);
      gameHistoryRef.current = updatedHistory;
      
      const newIndex = updatedHistory.length - 1;
      setHistoryIndex(newIndex);
      historyIndexRef.current = newIndex;

      updateBoardVisuals();
      checkGameOver(game);

      return move;
  }

  function navigateHistory(direction) {
      if (gameHistoryRef.current.length === 0) return;

      const historyLen = gameHistoryRef.current.length;
      let targetIndex = historyIndexRef.current;

      let step = 0;
      if (direction === "start") targetIndex = 0;
      else if (direction === "end") targetIndex = historyLen - 1;
      else {
          step = direction;
          targetIndex += step;
      }

      if (targetIndex < 0) targetIndex = 0;
      if (targetIndex >= historyLen) targetIndex = historyLen - 1;

      if (step !== 0 && targetIndex > 0 && targetIndex < historyLen - 1) {
          const snapshot = gameHistoryRef.current[targetIndex];
          const fenColor = snapshot.fen.split(' ')[1] === 'w' ? 'white' : 'black';
          
          if (fenColor !== playerColorRef.current) {
               targetIndex += step;
          }
      }

      if (targetIndex < 0) targetIndex = 0;
      if (targetIndex >= historyLen) targetIndex = historyLen - 1;

      if (targetIndex === historyIndexRef.current) return;

      isReplayingRef.current = true;

      const snapshot = gameHistoryRef.current[targetIndex];
      const tempGame = new Chess(snapshot.fen);
      chessRef.current = tempGame;
      
      setHistoryIndex(targetIndex);
      updateBoardVisuals();
      setGameOver(null); 

      setEngineStatus("Reviewing...");
      engine.current?.postMessage(`position fen ${tempGame.fen()}`);
      engine.current?.postMessage(`go depth ${engineDepthRef.current}`);
  }

  useEffect(() => {
    if (boardRef.current && !apiRef.current) {
      const config = {
        fen: "start",
        orientation: "white",
        movable: {
          color: "white",
          free: false,
          dests: toDests(chessRef.current),
          events: {
            after: (orig, dest) => {
                const move = handleMove(orig, dest, 'q');
                if (!move) {
                    apiRef.current.set({ fen: chessRef.current.fen() });
                    return;
                }
                
                if (!chessRef.current.isGameOver()) {
                    setEngineStatus("Thinking...");
                    engine.current?.postMessage(`position fen ${chessRef.current.fen()}`);
                    engine.current?.postMessage(`go depth ${engineDepthRef.current}`); 
                }
            }
          }
        }
      };
      apiRef.current = Chessground(boardRef.current, config);
    }
  }, []);

  function updateBoardVisuals() {
    if (!apiRef.current) return;
    const game = chessRef.current;
    
    let lastMove = [];
    const currentIndex = historyIndexRef.current;
    const currentHistory = gameHistoryRef.current;
    
    if (currentHistory[currentIndex]) {
        lastMove = currentHistory[currentIndex].lastMove || [];
    }

    const turnColor = game.turn() === 'w' ? 'white' : 'black';
    setTurnInfo(turnColor);
    
    apiRef.current.set({ 
      fen: game.fen(),
      turnColor: turnColor,
      lastMove: lastMove,
      movable: { color: turnColor, dests: toDests(game) }
    });
  }

  function togglePiece(key) {
      setSelectedPieces(prev => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
      });
  }

  function loadRandomScenario() {
    if (scenarios.length === 0) return;
    setFeedbackMessage("");

    // --- MAIN FILTER LOGIC ---
    let pool = scenarios.filter(s => {
        const tags = s.tags || [];

        // 1. Piece-type chips: OR within selection. Empty set = no constraint.
        if (selectedPieces.size > 0) {
            const matched =
                (selectedPieces.has('rook')   && tags.includes('rook_endgame'))   ||
                (selectedPieces.has('bishop') && tags.includes('bishop_endgame')) ||
                (selectedPieces.has('knight') && tags.includes('knight_endgame')) ||
                (selectedPieces.has('pawn')   && tags.includes('pawn_endgame'));
            if (!matched) return false;
        }

        // 2. Independent toggles (AND with piece selection)
        if (requirePuzzle && !tags.includes('puzzle')) return false;
        if (requireImbalance && !s.imbalance) return false;

        // 3. Material Range
        const mat = s.material_points !== undefined ? s.material_points : 15;
        if (mat < minMaterial || mat > maxMaterial) return false;

        // 4. Eval Mode
        const absEval = Math.abs(s.eval || 0);
        if (filterEvalMode === "drawn") {
             if (absEval > 0.6) return false;
        } else if (filterEvalMode === "advantage") {
             if (absEval < 1.0) return false;
        }

        return true;
    });

    if (pool.length === 0) {
        setFeedbackMessage("No scenarios found matching criteria.");
        return;
    }

    const randomScenario = pool[Math.floor(Math.random() * pool.length)];
    loadScenario(randomScenario);
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

  function loadScenario(scenario) {
    setGameOver(null);
    setFeedbackMessage(""); // Clear error on success
    setCurrentScenario(scenario);
    setCurrentEval(null);

    setSidebarHistory(prev => {
        const filtered = prev.filter(s => s.id !== scenario.id);
        return [scenario, ...filtered];
    });

    const newGame = new Chess(scenario.fen);
    chessRef.current = newGame;
    
    const startSnapshot = { fen: scenario.fen, lastMove: null };
    setGameHistory([startSnapshot]);
    gameHistoryRef.current = [startSnapshot];
    setHistoryIndex(0);
    historyIndexRef.current = 0;
    
    isReplayingRef.current = false; 

    const sideToMove = newGame.turn() === 'w' ? 'white' : 'black';
    setPlayerColor(sideToMove);
    setTurnInfo(sideToMove);

    setEngineStatus("Ready");
    engine.current?.postMessage("stop");
    
    if (apiRef.current) {
        apiRef.current.set({
            fen: scenario.fen,
            orientation: sideToMove, 
            turnColor: sideToMove,
            lastMove: null,
            movable: { color: sideToMove, dests: toDests(newGame) }
        });
    }
  }

  function toDests(chess) {
    const dests = new Map();
    chess.moves({ verbose: true }).forEach((move) => {
      if (!dests.has(move.from)) dests.set(move.from, []);
      dests.get(move.from).push(move.to);
    });
    return dests;
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

  // --- DYNAMIC STYLES ---
  const boardSize = isMobile ? "90vw" : "500px";
  
  const responsiveStyles = {
      mainLayout: {
          display: "flex", 
          flexDirection: isMobile ? "column" : "row",
          gap: "30px", 
          alignItems: "center",
          width: "100%", 
          maxWidth: "900px", 
          justifyContent: "center"
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
                        {currentEval !== null && (
                        <span style={{
                            ...styles.initialEval,
                            color: currentEval > 0 ? "var(--accent2)"
                                 : currentEval < 0 ? "var(--bad)"
                                 : "var(--text)",
                            fontWeight: "bold"
                        }}>
                            Live: {currentEval > 0 ? "+" : ""}{currentEval.toFixed(2)}
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
                {gameOver !== null && (
                    <div style={styles.overlay}>
                        <div style={styles.countdownText}>{gameOver.title}</div>
                        <div style={{fontSize: "22px", color: "var(--text)", marginTop: "10px"}}>{gameOver.result}</div>
                        <button style={styles.primaryButton} onClick={loadRandomScenario}>
                             New Game 🎲
                        </button>
                    </div>
                )}
                
                <div ref={boardRef} style={{width: "100%", height: "100%"}} />
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
                    style={{...styles.navButton, ...(historyIndex <= 0 ? styles.disabledNav : {})}} 
                    onClick={() => navigateHistory("start")}
                    disabled={historyIndex <= 0}
                    title="Back to Start"
                >⏮</button>
                <button 
                    style={{...styles.navButton, ...(historyIndex <= 0 ? styles.disabledNav : {})}} 
                    onClick={() => navigateHistory(-1)}
                    disabled={historyIndex <= 0}
                    title="Undo Turn"
                >◀</button>
                <button 
                    style={{...styles.navButton, ...(historyIndex >= gameHistory.length - 1 ? styles.disabledNav : {})}} 
                    onClick={() => navigateHistory(1)}
                    disabled={historyIndex >= gameHistory.length - 1}
                    title="Redo Turn"
                >▶</button>
                <button 
                    style={{...styles.navButton, ...(historyIndex >= gameHistory.length - 1 ? styles.disabledNav : {})}} 
                    onClick={() => navigateHistory("end")}
                    disabled={historyIndex >= gameHistory.length - 1}
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
                                style={engineDepth === d ? styles.triOptionActive : styles.triOption}
                            >
                                <input
                                    type="radio"
                                    name="engineDepth"
                                    checked={engineDepth === d}
                                    onChange={() => setEngineDepth(d)}
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
  // --- TRI-STATE STYLES (still used by Engine Depth segmented control) ---
  triStateContainer: {
      display: "flex", flexDirection: "column", alignItems: "center"
  },
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
  secondaryButton: {
    padding: "12px 24px", fontSize: "15px", fontWeight: "600", cursor: "pointer",
    background: "transparent", color: "var(--text-dim)", border: "1px solid var(--surface2)",
    borderRadius: "6px", transition: "border-color 0.2s, color 0.2s", fontFamily: "inherit"
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