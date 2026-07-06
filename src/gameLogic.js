import { Chess } from "chess.js";

// Pure game/grading logic. No React, no engine, no DOM — unit-testable in Node.

export function classifyMove({ playedUci, bestUci, evalBeforeWhite, evalAfterWhite, playerIsWhite }) {
  if (bestUci && playedUci === bestUci) return { tier: "best", cpLoss: 0 };
  if (evalBeforeWhite == null || evalAfterWhite == null) return { tier: null, cpLoss: null };

  const sign = playerIsWhite ? 1 : -1;
  const clamp = (v) => Math.max(-1000, Math.min(1000, v));
  const before = clamp(sign * evalBeforeWhite);
  const after = clamp(sign * evalAfterWhite);
  const loss = Math.max(0, before - after);

  // Generous bands: adjacent searches at equal depth commonly disagree by
  // 20-40cp in endgames, and before/after come from different searches.
  let tier = loss <= 60 ? "good"
           : loss <= 125 ? "inaccuracy"
           : loss <= 275 ? "mistake"
           : "blunder";

  // Still completely winning (or hopeless) on both sides of the move: eval
  // swings in decided positions shouldn't read as blunders.
  if ((before >= 500 && after >= 500) || (before <= -500 && after <= -500)) {
    if (tier === "mistake" || tier === "blunder") tier = "inaccuracy";
  }
  return { tier, cpLoss: loss };
}

export function terminalEvalWhite(game) {
  if (game.isCheckmate()) {
    // The side to move is the one checkmated
    return game.turn() === "w" ? -100000 : 100000;
  }
  return 0; // any draw
}

export function toDests(chess) {
  const dests = new Map();
  chess.moves({ verbose: true }).forEach((move) => {
    if (!dests.has(move.from)) dests.set(move.from, []);
    dests.get(move.from).push(move.to);
  });
  return dests;
}

// SAN for a UCI move in the given position; null if the move is illegal there.
export function sanForUci(fen, uci) {
  if (!uci) return null;
  try {
    const game = new Chess(fen);
    const move = game.move({
      from: uci.substring(0, 2),
      to: uci.substring(2, 4),
      promotion: uci[4]
    });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

export function detectGameOver(game) {
  if (!game.isGameOver()) return null;

  let title = "Game Over";
  let result = "Draw";
  if (game.isCheckmate()) {
    title = "Checkmate!";
    result = game.turn() === "w" ? "Black Wins" : "White Wins";
  } else if (game.isDraw()) {
    title = "Draw";
    if (game.isStalemate()) result = "Stalemate";
    else if (game.isThreefoldRepetition()) result = "Repetition";
    else if (game.isInsufficientMaterial()) result = "Insufficient Material";
  }
  return { title, result };
}

// Chess instance for the position at `index`, rebuilt by SAN replay from the
// start snapshot so move-count-based rules (threefold repetition) survive
// navigation and branching.
export function gameAt(history, index) {
  const game = new Chess(history[0].fen);
  for (let i = 1; i <= index; i++) {
    game.move(history[i].san);
  }
  return game;
}

// Apply a move at `index` (truncating any redo tail — branching), returning the
// new history/index plus move details. Returns null for illegal moves
// (chess.js v1 throws on them).
export function applyMoveToHistory(history, index, { from, to, promotion = "q" }, moveBy) {
  const game = gameAt(history, index);
  const fenBefore = game.fen();

  let move = null;
  try {
    move = game.move({ from, to, promotion });
  } catch { /* illegal */ }
  if (!move) return null;

  const snapshot = {
    fen: game.fen(),
    lastMove: [from, to],
    san: move.san,
    moveBy,
    color: move.color,
    moveNumber: parseInt(fenBefore.split(" ")[5], 10),
    feedback: null
  };

  const newHistory = [...history.slice(0, index + 1), snapshot];
  return {
    history: newHistory,
    index: newHistory.length - 1,
    move,
    fenBefore,
    fenAfter: snapshot.fen,
    snapshot,
    game
  };
}

// Target index for relative review navigation: steps of ±1 (which skip
// positions where it is the opponent's turn, so single-stepping moves between
// the player's decision points) and the "start"/"end" endpoints. Absolute
// jumps (move-log clicks) do NOT go through this — they must land exactly on
// the clicked ply, never reinterpreted as a step.
export function navigationTarget(history, index, direction, playerColor) {
  const len = history.length;
  if (len === 0) return index;

  let target = index;
  let step = 0;
  if (direction === "start") target = 0;
  else if (direction === "end") target = len - 1;
  else if (direction === 1 || direction === -1) {
    step = direction;
    target += step;
  }

  target = Math.max(0, Math.min(len - 1, target));

  if (step !== 0 && target > 0 && target < len - 1) {
    const fenColor = history[target].fen.split(" ")[1] === "w" ? "white" : "black";
    if (fenColor !== playerColor) target += step;
  }

  return Math.max(0, Math.min(len - 1, target));
}

// Scenario pool filtering (chips OR within selection; toggles AND; material
// range; eval mode).
export function filterScenarios(scenarios, {
  selectedPieces, requirePuzzle, requireImbalance, minMaterial, maxMaterial, filterEvalMode
}) {
  return scenarios.filter(s => {
    const tags = s.tags || [];

    if (selectedPieces.size > 0) {
      const matched =
        (selectedPieces.has("rook")   && tags.includes("rook_endgame"))   ||
        (selectedPieces.has("bishop") && tags.includes("bishop_endgame")) ||
        (selectedPieces.has("knight") && tags.includes("knight_endgame")) ||
        (selectedPieces.has("pawn")   && tags.includes("pawn_endgame"));
      if (!matched) return false;
    }

    if (requirePuzzle && !tags.includes("puzzle")) return false;
    if (requireImbalance && !s.imbalance) return false;

    const mat = s.material_points !== undefined ? s.material_points : 15;
    if (mat < minMaterial || mat > maxMaterial) return false;

    const absEval = Math.abs(s.eval || 0);
    if (filterEvalMode === "drawn") {
      if (absEval > 0.6) return false;
    } else if (filterEvalMode === "advantage") {
      if (absEval < 1.0) return false;
    }

    return true;
  });
}
