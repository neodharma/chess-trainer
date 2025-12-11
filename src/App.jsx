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

  // History System
  const [gameHistory, setGameHistory] = useState([]); 
  const [historyIndex, setHistoryIndex] = useState(0); 

  // Options
  const [includeRooks, setIncludeRooks] = useState(true);
  const [includeBishops, setIncludeBishops] = useState(true);
  const [includePawns, setIncludePawns] = useState(true);
  const [jumpId, setJumpId] = useState("");
  
  // Sidebar
  const [sidebarHistory, setSidebarHistory] = useState([]);

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
  
  const isReplayingRef = useRef(false);

  useEffect(() => { playerColorRef.current = playerColor; }, [playerColor]);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
  useEffect(() => { gameHistoryRef.current = gameHistory; }, [gameHistory]);

  // HANDLE RESIZE
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 800);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

// KEYBOARD SHORTCUTS
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in the Jump ID input
      if (e.target.tagName === "INPUT") return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigateHistory(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateHistory(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); // Prevent scrolling up
        navigateHistory("start");
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); // Prevent scrolling down
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
      let targetIndex = historyIndexRef.current; // Use Ref to get current position

      // 1. Determine the Basic Step
      let step = 0;
      if (direction === "start") targetIndex = 0;
      else if (direction === "end") targetIndex = historyLen - 1;
      else {
          step = direction; // -1 or +1
          targetIndex += step;
      }

      // 2. Bounds Check (Initial)
      if (targetIndex < 0) targetIndex = 0;
      if (targetIndex >= historyLen) targetIndex = historyLen - 1;

      // 3. Smart Skip Logic (Skip Opponent's moves)
      // Only skip if we are moving via arrow keys (step !== 0)
      if (step !== 0 && targetIndex > 0 && targetIndex < historyLen - 1) {
          const snapshot = gameHistoryRef.current[targetIndex];
          // Peek at the board state of the target index
          const fenColor = snapshot.fen.split(' ')[1] === 'w' ? 'white' : 'black';
          
          // If the target state is NOT our turn to move, skip it to get to our turn
          if (fenColor !== playerColorRef.current) {
               targetIndex += step;
          }
      }

      // 4. Final Safety Clamp
      if (targetIndex < 0) targetIndex = 0;
      if (targetIndex >= historyLen) targetIndex = historyLen - 1;

      // 5. Execute Update
      if (targetIndex === historyIndexRef.current) return;

      isReplayingRef.current = true;

      const snapshot = gameHistoryRef.current[targetIndex];
      const tempGame = new Chess(snapshot.fen);
      chessRef.current = tempGame;
      
      setHistoryIndex(targetIndex);
      updateBoardVisuals();
      setGameOver(null); 

      setEngineStatus("Reviewing...");
      // Optional: Only eval if we stopped on a valid move
      engine.current?.postMessage(`position fen ${tempGame.fen()}`);
      engine.current?.postMessage("go depth 12");
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
                    engine.current?.postMessage("go depth 12"); 
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

  function loadRandomScenario() {
    if (scenarios.length === 0) return;

    let pool = scenarios;

    if (!includeRooks) {
        pool = pool.filter(s => !s.tags || !s.tags.includes('rook_endgame'));
    }
    if (!includeBishops) {
        pool = pool.filter(s => !s.tags || !s.tags.includes('bishop_endgame'));
    }
    if (!includePawns) {
        pool = pool.filter(s => !s.tags || !s.tags.includes('pawn_endgame'));
    }

    if (pool.length === 0) {
        if (scenarios.length > 0) pool = scenarios; 
        else return;
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
    setCurrentScenario(scenario);
    setCurrentEval(null);

    setSidebarHistory(prev => {
        const filtered = prev.filter(s => s.id !== scenario.id);
        return [scenario, ...filtered].slice(0, 10);
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

  function retryScenario() {
      if (!currentScenario) return;
      loadScenario(currentScenario);
  }

  function toDests(chess) {
    const dests = new Map();
    chess.moves({ verbose: true }).forEach((move) => {
      if (!dests.has(move.from)) dests.set(move.from, []);
      dests.get(move.from).push(move.to);
    });
    return dests;
  }

  // --- DYNAMIC STYLES ---
  const boardSize = isMobile ? "90vw" : "500px";
  
  const responsiveStyles = {
      mainLayout: {
          display: "flex", 
          flexDirection: isMobile ? "column" : "row", // Stack on mobile
          gap: "30px", 
          alignItems: "center", // Center items in column mode
          width: "100%", 
          maxWidth: "900px", 
          justifyContent: "center"
      },
      sidebar: {
          width: isMobile ? "90vw" : "200px", // Full width on mobile
          backgroundColor: "#222", 
          borderRadius: "8px", 
          padding: "15px",
          border: "1px solid #333", 
          height: isMobile ? "auto" : "500px", // Auto height on mobile
          maxHeight: isMobile ? "300px" : "500px",
          display: "flex", 
          flexDirection: "column"
      },
      board: {
          width: boardSize, 
          height: boardSize // Keep square aspect ratio
      }
  };

  return (
    <div style={styles.appContainer}>
      <h2 style={styles.header}>♟️ BENNETT'S ENDGAME DOJO</h2>

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
                        <span style={styles.turnBadge}>
                            {turnInfo === 'white' ? "⚪ White" : "⚫ Black"}
                        </span>
                    </div>
                ) : (
                    <p style={{color: "#777"}}>Loading Dojo...</p>
                )}
            </div>

            <div style={{...styles.boardContainer, width: boardSize, height: boardSize}}>
                {/* GAME OVER MODAL */}
                {gameOver !== null && (
                    <div style={styles.overlay}>
                        <div style={styles.countdownText}>{gameOver.title}</div>
                        <div style={{fontSize: "22px", color: "#ddd", marginTop: "10px"}}>{gameOver.result}</div>
                        <button style={styles.primaryButton} onClick={loadRandomScenario}>
                             New Game 🎲
                        </button>
                    </div>
                )}
                
                {/* We pass width/height to the wrapper div so Chessground knows its bounds */}
                <div ref={boardRef} style={{width: "100%", height: "100%"}} />
            </div>

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

            {currentScenario && currentScenario.players && (
                <div style={styles.metadata}>
                    {currentScenario.players} ({currentScenario.year || "Unknown"})
                </div>
            )}

            <div style={styles.optionsPanel}>
                <label style={styles.checkboxLabel}>
                    <input type="checkbox" checked={includeRooks} onChange={(e) => setIncludeRooks(e.target.checked)} />
                    Rook-Only
                </label>

                <label style={styles.checkboxLabel}>
                    <input type="checkbox" checked={includeBishops} onChange={(e) => setIncludeBishops(e.target.checked)} />
                    Bishop-Only
                </label>

                <label style={styles.checkboxLabel}>
                    <input type="checkbox" checked={includePawns} onChange={(e) => setIncludePawns(e.target.checked)} />
                    Pawn-Only
                </label>
            </div>

            <div style={styles.controls}>
                <button style={styles.primaryButton} onClick={loadRandomScenario}>
                    Load Random 🎲
                </button>
                <button style={styles.secondaryButton} onClick={retryScenario}>
                    Reset Position ↺
                </button>
            </div>
            
            <div style={styles.engineInfo}>
                {currentEval !== null && (
                    <span style={{color: currentEval > 0 ? "#90EE90" : "#FF7F7F", fontWeight: "bold"}}>
                        Eval: {currentEval > 0 ? "+" : ""}{currentEval.toFixed(2)}
                    </span>
                )}
            </div>
        </div>

        <div style={responsiveStyles.sidebar}>
            <h3 style={styles.sidebarTitle}>Recent History</h3>
            <div style={styles.historyList}>
                {sidebarHistory.length === 0 && <span style={{color: "#555", fontStyle: "italic", fontSize: "14px"}}>No games yet</span>}
                {sidebarHistory.map((item) => (
                    <div 
                        key={item.id} 
                        style={currentScenario && currentScenario.id === item.id ? styles.historyItemActive : styles.historyItem}
                        onClick={() => loadScenario(item)}
                    >
                        <span style={styles.historyId}>#{item.id}</span>
                        <div style={styles.historyMeta}>
                            <span>{item.players ? item.players.split(" vs ")[0] : "Unknown"}...</span>
                            <span style={{fontSize: "10px", color: "#666"}}>({item.year || "?"})</span>
                        </div>
                    </div>
                ))}
            </div>

            <div style={styles.jumpSection}>
                <span style={{fontSize: "12px", color: "#888", marginBottom: "5px"}}>Jump to ID:</span>
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
    fontFamily: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    backgroundColor: "#1a1a1a", color: "#eee", minHeight: "100vh", width: "100vw", boxSizing: "border-box",
    paddingBottom: "50px" // Add scroll space at bottom
  },
  header: {
    fontSize: "clamp(20px, 5vw, 24px)", // Responsive font size
    fontWeight: "800", margin: "0 0 15px 0",
    letterSpacing: "1px", textTransform: "uppercase", color: "#d4a34b", textAlign: "center"
  },
  gameColumn: {
      display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: "500px"
  },
  navBar: {
      display: "flex", gap: "2px", marginTop: "10px", backgroundColor: "#333", borderRadius: "6px", overflow: "hidden"
  },
  navButton: {
      backgroundColor: "transparent", border: "none", color: "#eee", fontSize: "18px", 
      padding: "5px 15px", cursor: "pointer", transition: "background 0.2s"
  },
  disabledNav: {
      opacity: 0.3, cursor: "not-allowed"
  },
  sidebarTitle: {
      margin: "0 0 15px 0", fontSize: "16px", color: "#ccc", borderBottom: "1px solid #444", paddingBottom: "10px"
  },
  historyList: {
      flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px"
  },
  historyItem: {
      backgroundColor: "#333", padding: "8px", borderRadius: "4px", cursor: "pointer",
      borderLeft: "3px solid transparent", transition: "background 0.2s"
  },
  historyItemActive: {
      backgroundColor: "#444", padding: "8px", borderRadius: "4px", cursor: "pointer",
      borderLeft: "3px solid #d4a34b"
  },
  historyId: { fontWeight: "bold", color: "#d4a34b", fontSize: "12px", display: "block" },
  historyMeta: { fontSize: "12px", color: "#aaa", display: "flex", justifyContent: "space-between" },
  jumpSection: {
      marginTop: "15px", borderTop: "1px solid #444", paddingTop: "15px", display: "flex", flexDirection: "column"
  },
  infoBar: {
    height: "50px", marginBottom: "5px", display: "flex", alignItems: "center", justifyContent: "center", width: "100%"
  },
  scenarioBox: {
    display: "flex", gap: "10px", alignItems: "center", backgroundColor: "#333",
    padding: "8px 16px", borderRadius: "20px", fontSize: "14px", border: "1px solid #444"
  },
  scenarioId: { fontWeight: "bold", color: "#d4a34b" },
  initialEval: { color: "#aaa", fontSize: "0.9em" },
  turnBadge: {
    backgroundColor: "#222", padding: "2px 8px", borderRadius: "4px", color: "#ccc",
    fontSize: "12px", fontWeight: "600", border: "1px solid #555"
  },
  boardContainer: {
    position: "relative",
    padding: "10px", backgroundColor: "#262421", borderRadius: "4px", boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
  },
  overlay: {
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(0,0,0,0.85)", zIndex: 100,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      borderRadius: "4px"
  },
  countdownText: { fontSize: "40px", fontWeight: "bold", color: "white", textAlign: "center" },
  metadata: {
      marginTop: "10px", color: "#888", fontStyle: "italic", fontSize: "14px", textAlign: "center"
  },
  optionsPanel: {
      marginTop: "15px", display: "flex", gap: "15px", alignItems: "center", flexWrap: "wrap", justifyContent: "center"
  },
  checkboxLabel: {
      fontSize: "14px", color: "#ccc", display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none"
  },
  controls: { marginTop: "20px", display: "flex", gap: "15px" },
  primaryButton: {
    padding: "12px 24px", fontSize: "15px", fontWeight: "600", cursor: "pointer",
    backgroundColor: "#d4a34b", color: "#1a1a1a", border: "none", borderRadius: "6px", transition: "background 0.2s"
  },
  secondaryButton: {
    padding: "12px 24px", fontSize: "15px", fontWeight: "600", cursor: "pointer",
    backgroundColor: "transparent", color: "#888", border: "2px solid #444", borderRadius: "6px", transition: "border 0.2s"
  },
  jumpControls: {
      display: "flex", gap: "5px", alignItems: "center"
  },
  jumpInput: {
      padding: "8px", borderRadius: "4px", border: "1px solid #444", backgroundColor: "#222", color: "white", width: "100%", textAlign: "center"
  },
  jumpButton: {
      padding: "8px 12px", borderRadius: "4px", border: "none", backgroundColor: "#444", color: "white", cursor: "pointer", fontSize: "12px"
  },
  engineInfo: {
      marginTop: "20px", fontSize: "14px"
  }
};