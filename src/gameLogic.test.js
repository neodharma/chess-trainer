import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";
import {
  classifyMove, terminalEvalWhite, sanForUci, detectGameOver,
  gameAt, applyMoveToHistory, navigationTarget
} from "./gameLogic.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function historyFromSans(startFen, sans) {
  const game = new Chess(startFen);
  const history = [{ fen: startFen, lastMove: null }];
  for (const san of sans) {
    const move = game.move(san);
    history.push({ fen: game.fen(), lastMove: [move.from, move.to], san, color: move.color });
  }
  return history;
}

describe("classifyMove", () => {
  const base = { playedUci: "e2e4", bestUci: "d2d4", playerIsWhite: true };

  it("returns best when the played move matches the engine move, regardless of evals", () => {
    expect(classifyMove({ ...base, playedUci: "d2d4", evalBeforeWhite: null, evalAfterWhite: null }))
      .toEqual({ tier: "best", cpLoss: 0 });
  });

  it("returns null tier when eval data is missing", () => {
    expect(classifyMove({ ...base, evalBeforeWhite: null, evalAfterWhite: 0 }).tier).toBe(null);
    expect(classifyMove({ ...base, evalBeforeWhite: 0, evalAfterWhite: null }).tier).toBe(null);
  });

  it.each([
    [60, "good"],
    [61, "inaccuracy"],
    [125, "inaccuracy"],
    [126, "mistake"],
    [275, "mistake"],
    [276, "blunder"]
  ])("cp loss of %i → %s", (loss, tier) => {
    expect(classifyMove({ ...base, evalBeforeWhite: 100, evalAfterWhite: 100 - loss }).tier).toBe(tier);
  });

  it("treats an eval improvement as zero loss", () => {
    const r = classifyMove({ ...base, evalBeforeWhite: 50, evalAfterWhite: 150 });
    expect(r).toEqual(expect.objectContaining({ tier: "good", cpLoss: 0 }));
  });

  it("flips the sign for a black player", () => {
    // Black to move: eval dropping from -300 to +100 white-absolute is a 400cp loss for black
    const r = classifyMove({ ...base, playerIsWhite: false, evalBeforeWhite: -300, evalAfterWhite: 100 });
    expect(r.tier).toBe("blunder");
    expect(r.cpLoss).toBe(400);
  });

  it("caps severity at inaccuracy when the position stays decided", () => {
    expect(classifyMove({ ...base, evalBeforeWhite: 950, evalAfterWhite: 550 }).tier).toBe("inaccuracy");
    expect(classifyMove({ ...base, playerIsWhite: false, evalBeforeWhite: -950, evalAfterWhite: -550 }).tier)
      .toBe("inaccuracy");
  });

  it("clamps mate-scale scores before computing loss", () => {
    // 99997 → clamped 1000; still decided on both sides → inaccuracy at worst
    const r = classifyMove({ ...base, evalBeforeWhite: 99997, evalAfterWhite: 600 });
    expect(r.tier).toBe("inaccuracy");
    expect(r.cpLoss).toBe(400);
  });
});

describe("terminalEvalWhite / detectGameOver", () => {
  it("scores a delivered mate for the mating side", () => {
    const mate = new Chess("7k/6Q1/5K2/8/8/8/8/8 b - - 0 1"); // black to move, mated
    expect(mate.isCheckmate()).toBe(true);
    expect(terminalEvalWhite(mate)).toBe(100000);
    expect(detectGameOver(mate)).toEqual({ title: "Checkmate!", result: "White Wins" });
  });

  it("scores any draw as zero", () => {
    const stalemate = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(stalemate.isStalemate()).toBe(true);
    expect(terminalEvalWhite(stalemate)).toBe(0);
    expect(detectGameOver(stalemate)).toEqual({ title: "Draw", result: "Stalemate" });
  });

  it("returns null for a live position", () => {
    expect(detectGameOver(new Chess(START))).toBe(null);
  });
});

describe("sanForUci", () => {
  it("converts a legal UCI move to SAN", () => {
    expect(sanForUci(START, "g1f3")).toBe("Nf3");
  });
  it("returns null for illegal or missing moves", () => {
    expect(sanForUci(START, "e2e5")).toBe(null);
    expect(sanForUci(START, null)).toBe(null);
  });
});

describe("gameAt", () => {
  it("detects threefold repetition across replayed history", () => {
    const history = historyFromSans(START, [
      "Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"
    ]);
    const game = gameAt(history, history.length - 1);
    expect(game.isThreefoldRepetition()).toBe(true);
  });
});

describe("applyMoveToHistory", () => {
  it("appends a snapshot with SAN and move metadata", () => {
    const history = [{ fen: START, lastMove: null }];
    const r = applyMoveToHistory(history, 0, { from: "e2", to: "e4" }, "player");
    expect(r.history).toHaveLength(2);
    expect(r.index).toBe(1);
    expect(r.snapshot).toEqual(expect.objectContaining({
      san: "e4", moveBy: "player", color: "w", moveNumber: 1, feedback: null
    }));
  });

  it("truncates the redo tail when branching from an earlier index", () => {
    const history = historyFromSans(START, ["e4", "e5", "Nf3"]);
    const r = applyMoveToHistory(history, 1, { from: "g8", to: "f6" }, "player");
    expect(r.history).toHaveLength(3);
    expect(r.history[2].san).toBe("Nf6");
  });

  it("returns null on an illegal move (chess.js v1 throws)", () => {
    const history = [{ fen: START, lastMove: null }];
    expect(applyMoveToHistory(history, 0, { from: "e2", to: "e5" }, "player")).toBe(null);
  });
});

describe("navigationTarget", () => {
  // White player: positions where it's white's turn are the decision points
  const history = historyFromSans(START, ["e4", "e5", "Nf3", "Nc6"]);

  it("steps over positions where it is the opponent's turn", () => {
    // From index 4 (white to move), one step back over index 3 (would be white
    // to move? index 3 = after Nf3 → black to move) — stepping -1 from 4 lands
    // on 3 where black is to move; for a white player it skips to 2.
    expect(navigationTarget(history, 4, -1, "white")).toBe(2);
  });

  it("lands exactly on endpoints", () => {
    expect(navigationTarget(history, 2, "start", "white")).toBe(0);
    expect(navigationTarget(history, 0, "end", "white")).toBe(4);
  });

  it("clamps out-of-range steps", () => {
    expect(navigationTarget(history, 0, -1, "white")).toBe(0);
    expect(navigationTarget(history, 4, 1, "white")).toBe(4);
  });

  it("treats other numbers as absolute indexes", () => {
    expect(navigationTarget(history, 4, 0, "white")).toBe(0);
    expect(navigationTarget(history, 0, 3, "white")).toBe(3);
    expect(navigationTarget(history, 0, 99, "white")).toBe(4);
  });
});
