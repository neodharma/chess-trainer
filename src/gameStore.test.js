import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";
import { createGameStore } from "./gameStore.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MATE_IN_1 = "7k/5Q2/5K2/8/8/8/8/8 w - - 0 1"; // Qg7#

function fenAfter(fen, sans) {
  const g = new Chess(fen);
  for (const san of sans) g.move(san);
  return g.fen();
}

// Fake engine: records search() calls; tests fire results/infos by hand.
function setup(scenarioFen = START) {
  const calls = [];
  let handlers;
  let currentStub = null;
  const store = createGameStore({
    createEngine: (h) => {
      handlers = h;
      return {
        search: (req) => calls.push(req),
        stop: () => {},
        current: () => currentStub,
        dispose: () => {}
      };
    },
    storage: null
  });
  store.loadScenario({ id: "test", fen: scenarioFen });

  return {
    store,
    calls,
    lastCall: () => calls[calls.length - 1],
    fireResult: (over = {}) => {
      const call = calls[calls.length - 1];
      handlers.onResult({ fen: call.fen, meta: call.meta, ...over });
    },
    fireResultFor: (call, over = {}) => handlers.onResult({ fen: call.fen, meta: call.meta, ...over }),
    fireInfoFor: (call, over = {}) => handlers.onInfo({ fen: call.fen, meta: call.meta, ...over }),
    fireInfo: (over = {}) => {
      const call = calls[calls.length - 1];
      handlers.onInfo({ fen: call.fen, meta: call.meta, ...over });
    },
    seedAnalysis: (bestUci, scoreWhite) => {
      // Complete the pending analysis search of the current position
      const call = calls[calls.length - 1];
      handlers.onResult({ fen: call.fen, meta: call.meta, bestUci, scoreWhite });
    },
    setCurrent: (c) => { currentStub = c; }
  };
}

describe("gameStore basic flow", () => {
  it("loads a scenario, pre-analyzes it, and plays a graded game", () => {
    const t = setup();
    const s0 = t.store.getState();
    expect(s0.status).toBe("playerTurn");
    expect(s0.playerColor).toBe("white");
    expect(t.lastCall().meta.purpose).toBe("analysis");

    t.seedAnalysis("d2d4", 30);
    const move = t.store.playMove("e2", "e4");
    expect(move.san).toBe("e4");

    let s = t.store.getState();
    expect(s.status).toBe("engineThinking");
    expect(s.history).toHaveLength(2);
    expect(t.lastCall().meta).toEqual(expect.objectContaining({ purpose: "reply", snapshotIndex: 1 }));

    // Engine answers e5; the player's move gets graded (30 → -20 = 50cp loss → good)
    t.fireResult({ bestUci: "e7e5", scoreWhite: -20 });
    s = t.store.getState();
    expect(s.status).toBe("playerTurn");
    expect(s.history).toHaveLength(3);
    expect(s.history[2].moveBy).toBe("engine");
    expect(s.history[1].feedback).toEqual(expect.objectContaining({ tier: "good", cpLoss: 50 }));
    // Pre-analysis of the player's next decision was issued
    expect(t.lastCall().meta.purpose).toBe("analysis");
  });

  it("commits Best! instantly when the played move matches the analysis", () => {
    const t = setup();
    t.seedAnalysis("e2e4", 25);
    t.store.playMove("e2", "e4");
    const s = t.store.getState();
    expect(s.history[1].feedback).toEqual(expect.objectContaining({ tier: "best", cpLoss: 0 }));
    expect(s.pendingFeedback).toBe(null);
  });

  it("grades from in-flight analysis partials when the cache is empty", () => {
    const t = setup();
    const startCall = t.lastCall();
    t.setCurrent({ fen: startCall.fen, meta: startCall.meta, lastBestUci: "d2d4", lastScoreWhite: 40 });
    t.store.playMove("e2", "e4");
    const s = t.store.getState();
    expect(s.pendingFeedback).toEqual(expect.objectContaining({ bestUci: "d2d4", evalBeforeWhite: 40 }));
    expect(s.pendingFeedback.bestMoveSan).toBe("d4");
  });
});

describe("the history-click race (reported bug)", () => {
  it("never applies a reply that arrives after navigating away, but still grades it", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");
    const replyCall = t.lastCall();

    // User clicks an earlier history entry while the engine is thinking
    t.store.navigate(0);
    let s = t.store.getState();
    expect(s.status).toBe("reviewing");
    expect(s.index).toBe(0);

    // The (aborted) reply search's bestmove lands afterwards
    t.fireResultFor(replyCall, { bestUci: "e7e5", scoreWhite: -20 });
    s = t.store.getState();
    expect(s.history).toHaveLength(2);          // move NOT applied
    expect(s.index).toBe(0);                    // review position untouched
    expect(s.status).toBe("reviewing");
    expect(s.history[1].feedback?.tier).toBe("good"); // grading still landed
  });

  it("resumes the opponent's reply when returning to the live head (stall fix)", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");
    const abortedReply = t.lastCall();
    t.store.navigate(0);                         // abort mid-think
    t.fireResultFor(abortedReply, { bestUci: "e7e5", scoreWhite: -20 }); // graded, not applied

    t.store.navigate("end");                     // back to the live head
    let s = t.store.getState();
    expect(s.status).toBe("engineThinking");     // reply re-issued, not stalled
    const resumed = t.lastCall();
    expect(resumed.meta.purpose).toBe("reply");
    expect(resumed.fen).toBe(s.history[1].fen);

    t.fireResultFor(resumed, { bestUci: "e7e5", scoreWhite: -18 });
    s = t.store.getState();
    expect(s.history).toHaveLength(3);           // engine finally replied
    expect(s.status).toBe("playerTurn");
  });

  it("discards results from a superseded scenario", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");
    const oldReply = t.lastCall();

    t.store.loadScenario({ id: "other", fen: MATE_IN_1 });
    t.fireResultFor(oldReply, { bestUci: "e7e5", scoreWhite: -20 });

    const s = t.store.getState();
    expect(s.history).toHaveLength(1);           // fresh scenario untouched
    expect(s.scenario.id).toBe("other");
    expect(s.status).toBe("playerTurn");
  });
});

describe("branching and terminal positions", () => {
  it("truncates and replies on the branch when moving from a review position", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");
    t.fireResult({ bestUci: "e7e5", scoreWhite: -20 }); // engine replies; history len 3

    t.store.navigate(0);
    const move = t.store.playMove("d2", "d4");   // branch from the start
    expect(move.san).toBe("d4");

    const s = t.store.getState();
    expect(s.history).toHaveLength(2);           // old line truncated
    expect(s.history[1].san).toBe("d4");
    expect(s.status).toBe("engineThinking");
    expect(t.lastCall().meta.purpose).toBe("reply");
    expect(t.lastCall().fen).toBe(fenAfter(START, ["d4"]));
  });

  it("handles a terminal player move: gameOver, terminal grading, no reply search", () => {
    const t = setup(MATE_IN_1);
    t.seedAnalysis("f7g7", 900);
    const callsBefore = t.calls.length;

    const move = t.store.playMove("f7", "g7");   // Qg7#
    expect(move.san).toBe("Qg7#");

    const s = t.store.getState();
    expect(s.status).toBe("gameOver");
    expect(s.gameOverInfo).toEqual({ title: "Checkmate!", result: "White Wins" });
    expect(s.history[1].feedback.tier).toBe("best");
    expect(t.calls.length).toBe(callsBefore);    // no reply/analysis issued
  });

  it("restores the game-over overlay when navigating back to a finished game", () => {
    const t = setup(MATE_IN_1);
    t.seedAnalysis("f7g7", 900);
    t.store.playMove("f7", "g7");

    t.store.navigate(0);
    expect(t.store.getState().status).toBe("reviewing");
    expect(t.store.getState().gameOverInfo).toEqual({ title: "Checkmate!", result: "White Wins" });

    t.store.navigate("end");
    const s = t.store.getState();
    expect(s.status).toBe("gameOver");
    expect(s.gameOverInfo.title).toBe("Checkmate!");
  });

  it("treats a manual opponent-piece move as the engine's move: no grading, no self-answering reply", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");                // now engineThinking, black to move

    const move = t.store.playMove("e7", "e5");   // user moves the opponent's pawn
    expect(move.san).toBe("e5");

    const s = t.store.getState();
    expect(s.status).toBe("playerTurn");
    expect(s.history[2].moveBy).toBe("engine");
    expect(s.history[2].feedback).toBe(null);
    expect(t.lastCall().meta.purpose).toBe("analysis"); // not a reply
  });
});

describe("depth and eval display", () => {
  it("applies a depth change to the next search, not the in-flight one", () => {
    const t = setup();
    t.seedAnalysis("d2d4", 30);
    t.store.playMove("e2", "e4");
    expect(t.lastCall().depth).toBe(12);

    t.store.setDepth(24);
    t.store.navigate(0);
    expect(t.lastCall().depth).toBe(24);
  });

  it("updates the eval display only for the currently viewed position", () => {
    const t = setup();
    t.fireInfo({ scoreWhite: 42 });              // analysis of the viewed start position
    expect(t.store.getState().currentEval).toBe(0.42);

    t.seedAnalysis("d2d4", 42);
    t.store.playMove("e2", "e4");
    const replyCall = t.lastCall();
    t.store.navigate(0);                         // viewing the start again; eval reset
    expect(t.store.getState().currentEval).toBe(null);

    // Info from the aborted reply search (position after e4) must not leak
    // into the display while the start position is on screen
    t.fireInfoFor(replyCall, { scoreWhite: -20 });
    expect(t.store.getState().currentEval).toBe(null);

    // Info from the review search of the viewed position does land
    t.fireInfo({ scoreWhite: 33 });
    expect(t.store.getState().currentEval).toBe(0.33);
  });
});
