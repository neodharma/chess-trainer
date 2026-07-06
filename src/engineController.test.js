import { describe, it, expect } from "vitest";
import { createEngineController, parseScore } from "./engineController.js";

const FEN_W = "8/8/8/8/8/8/4K3/4k3 w - - 0 1"; // white to move (fake fens are fine here)
const FEN_B = "8/8/8/8/8/8/4K3/4k3 b - - 0 1";

function makeFakeWorker() {
  return {
    posted: [],
    onmessage: null,
    postMessage(msg) { this.posted.push(msg); },
    emit(line) { this.onmessage({ data: line }); },
    terminate() { this.terminated = true; }
  };
}

function setup() {
  const worker = makeFakeWorker();
  const results = [];
  const infos = [];
  const engine = createEngineController({
    createWorker: () => worker,
    onResult: (r) => results.push(r),
    onInfo: (i) => infos.push(i)
  });
  return { worker, engine, results, infos };
}

describe("parseScore", () => {
  it("normalizes cp to white-absolute by side to move", () => {
    expect(parseScore("info depth 12 score cp 55 pv e2e4", "w")).toBe(55);
    expect(parseScore("info depth 12 score cp 55 pv e7e5", "b")).toBe(-55);
  });
  it("maps mate scores near ±100000, closer mates higher", () => {
    expect(parseScore("info depth 10 score mate 3 pv a1a2", "w")).toBe(99997);
    expect(parseScore("info depth 10 score mate -2 pv a1a2", "w")).toBe(-99998);
    expect(parseScore("info depth 10 score mate 3 pv a1a2", "b")).toBe(-99997);
  });
  it("returns null for lines without a score", () => {
    expect(parseScore("info depth 5 nodes 1234", "w")).toBe(null);
  });
});

describe("createEngineController", () => {
  it("posts the handshake and search commands", () => {
    const { worker, engine } = setup();
    expect(worker.posted).toEqual(["uci", "isready"]);
    engine.search({ fen: FEN_W, depth: 12, meta: { purpose: "analysis" } });
    expect(worker.posted.slice(2)).toEqual(["stop", `position fen ${FEN_W}`, "go depth 12"]);
  });

  it("attributes results to searches in FIFO order, including aborted ones", () => {
    const { worker, engine, results } = setup();
    engine.search({ fen: FEN_W, depth: 12, meta: { id: "A" } });
    worker.emit("info depth 8 score cp 40 pv e2e4");
    // Second search aborts the first; the first still emits its own bestmove
    engine.search({ fen: FEN_B, depth: 12, meta: { id: "B" } });
    worker.emit("bestmove e2e4");                       // belongs to A (aborted)
    worker.emit("info depth 12 score cp 30 pv e7e5");   // belongs to B (b to move → -30)
    worker.emit("bestmove e7e5");                       // belongs to B

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ fen: FEN_W, meta: { id: "A" }, bestUci: "e2e4", scoreWhite: 40 });
    expect(results[1]).toEqual({ fen: FEN_B, meta: { id: "B" }, bestUci: "e7e5", scoreWhite: -30 });
  });

  it("falls back to the last pv on bestmove (none)", () => {
    const { worker, engine, results } = setup();
    engine.search({ fen: FEN_W, depth: 12, meta: {} });
    worker.emit("info depth 6 score cp 10 pv d2d4 d7d5");
    worker.emit("bestmove (none)");
    expect(results[0].bestUci).toBe("d2d4");
  });

  it("exposes the in-flight search's partials via current()", () => {
    const { worker, engine } = setup();
    expect(engine.current()).toBe(null);
    engine.search({ fen: FEN_W, depth: 12, meta: { purpose: "analysis" } });
    worker.emit("info depth 9 score cp 77 pv g1f3");
    expect(engine.current()).toEqual({
      fen: FEN_W,
      meta: { purpose: "analysis" },
      lastBestUci: "g1f3",
      lastScoreWhite: 77
    });
    worker.emit("bestmove g1f3");
    expect(engine.current()).toBe(null);
  });

  it("ignores stray bestmoves when the queue is empty", () => {
    const { worker, results } = setup();
    worker.emit("bestmove e2e4");
    expect(results).toHaveLength(0);
  });
});
