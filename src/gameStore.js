import {
  classifyMove, terminalEvalWhite, sanForUci, detectGameOver,
  gameAt, applyMoveToHistory, navigationTarget
} from "./gameLogic.js";

// Single source of truth for the game. Every actor (board callbacks, engine
// callbacks, keyboard, UI clicks) reads and writes this store SYNCHRONOUSLY in
// its own tick; React subscribes via useSyncExternalStore. There are no
// secondary copies of game state, so there is no stale-mirror window.
//
// Game flow is an explicit state machine:
//   status: "loading" | "playerTurn" | "engineThinking" | "reviewing" | "gameOver"
// An engine reply is applied ONLY in engineThinking at the live head with a
// matching fen — any navigation transitions away from engineThinking in the
// click's own tick, so a late bestmove can grade the move but never mutate the
// board. Arriving at the live head RECONCILES status and engine work from
// state (restart an interrupted reply, restore game-over, refresh analysis)
// rather than relying on events not having been missed.

const DEPTHS = [12, 18, 24];
const DEPTH_KEY = "chess-trainer-depth";

export function createGameStore({ createEngine, storage = null }) {
  const listeners = new Set();

  let initialDepth = 12;
  try {
    const saved = parseInt(storage?.getItem(DEPTH_KEY), 10);
    if (DEPTHS.includes(saved)) initialDepth = saved;
  } catch { /* default */ }

  let state = {
    session: 0,
    scenario: null,
    playerColor: "white",
    status: "loading",
    history: [],
    index: 0,
    gameOverInfo: null,
    currentEval: null,
    depth: initialDepth,
    analysis: null,        // { fen, bestUci, scoreWhite } for a position analyzed for the player
    pendingFeedback: null  // player move awaiting an eval-after to grade
  };

  function setState(changes) {
    state = { ...state, ...changes };
    listeners.forEach(l => l());
  }

  const engine = createEngine({ onResult: handleResult, onInfo: handleInfo });

  function moverIsPlayer(fen) {
    return fen.split(" ")[1] === (state.playerColor === "white" ? "w" : "b");
  }

  function search(purpose, fen, extraMeta = {}) {
    engine.search({
      fen,
      depth: state.depth,
      meta: { purpose, session: state.session, ...extraMeta }
    });
  }

  // ---- Engine event handlers (sole consumers of engine results) ----

  function handleInfo({ fen, meta, scoreWhite }) {
    if (!meta || meta.session !== state.session) return;
    const viewed = state.history[state.index];
    if (!viewed || viewed.fen !== fen) return;
    const evalPawns = Math.max(-99, Math.min(99, scoreWhite / 100));
    if (evalPawns !== state.currentEval) setState({ currentEval: evalPawns });
  }

  function handleResult({ fen, meta, bestUci, scoreWhite }) {
    if (!meta || meta.session !== state.session) return;

    if (meta.purpose === "analysis" || meta.purpose === "review") {
      if (bestUci) setState({ analysis: { fen, bestUci, scoreWhite } });
      return;
    }

    // purpose === "reply": grade the player's move even if this search was
    // aborted, but apply the move ONLY when the game is still live here.
    commitFeedback(scoreWhite, meta);

    const liveIndex = state.history.length - 1;
    const stillLive = state.status === "engineThinking"
      && state.index === liveIndex
      && state.history[liveIndex]?.fen === meta.fenAfter;
    if (!stillLive || !bestUci) return;

    const applied = applyMoveToHistory(state.history, state.index, {
      from: bestUci.substring(0, 2),
      to: bestUci.substring(2, 4),
      promotion: bestUci.length > 4 ? bestUci[4] : "q"
    }, "engine");
    if (!applied) return;

    const over = detectGameOver(applied.game);
    setState({
      history: applied.history,
      index: applied.index,
      status: over ? "gameOver" : "playerTurn",
      gameOverInfo: over
    });
    if (!over) search("analysis", applied.fenAfter);
  }

  // Grade the pending player move. `meta` (from a reply search) must match the
  // pending move when provided; synchronous callers (terminal position,
  // instant "Best!") pass none.
  function commitFeedback(evalAfterWhite, meta = null) {
    const pending = state.pendingFeedback;
    if (!pending || pending.session !== state.session) return;
    if (meta && (meta.snapshotIndex !== pending.snapshotIndex || meta.fenAfter !== pending.fenAfter)) return;

    const { tier, cpLoss } = classifyMove({
      playedUci: pending.playedUci,
      bestUci: pending.bestUci,
      evalBeforeWhite: pending.evalBeforeWhite,
      evalAfterWhite,
      playerIsWhite: state.playerColor === "white"
    });

    const changes = { pendingFeedback: null };
    if (tier !== null) {
      const feedback = {
        tier,
        cpLoss,
        bestMoveSan: tier === "best" ? null : pending.bestMoveSan,
        bestMoveUci: pending.bestUci,
        evalBeforeWhite: pending.evalBeforeWhite,
        evalAfterWhite
      };
      changes.history = state.history.map((s, i) =>
        i === pending.snapshotIndex && s.fen === pending.fenAfter ? { ...s, feedback } : s
      );
    }
    setState(changes);
  }

  // ---- Actions ----

  function loadScenario(scenario) {
    engine.stop();
    const start = { fen: scenario.fen, lastMove: null };
    const playerColor = scenario.fen.split(" ")[1] === "w" ? "white" : "black";
    const over = detectGameOver(gameAt([start], 0));

    setState({
      session: state.session + 1,
      scenario,
      playerColor,
      status: over ? "gameOver" : "playerTurn",
      history: [start],
      index: 0,
      gameOverInfo: over,
      currentEval: null,
      analysis: null,
      pendingFeedback: null
    });

    if (!over) search("analysis", scenario.fen);
  }

  // The ONLY human-move entry point (board and dev hook both call this).
  // Legal from playerTurn (live move), reviewing (branch), engineThinking
  // (manual opponent move / branch), and gameOver while reviewing (branch).
  function playMove(from, to, promo = "q") {
    const st = state;
    if (st.status === "loading" || st.history.length === 0) return null;
    if (st.status === "gameOver" && st.index === st.history.length - 1) return null;

    const fenBefore = st.history[st.index].fen;
    const isPlayer = moverIsPlayer(fenBefore);

    // Capture the analysis of the pre-move position before anything can
    // overwrite it: completed cache first, else the in-flight search's partials.
    let analysis = st.analysis?.fen === fenBefore ? st.analysis : null;
    if (!analysis) {
      const cur = engine.current();
      if (cur && cur.fen === fenBefore && cur.lastBestUci
          && (cur.meta?.purpose === "analysis" || cur.meta?.purpose === "review")) {
        analysis = { fen: fenBefore, bestUci: cur.lastBestUci, scoreWhite: cur.lastScoreWhite };
      }
    }

    const applied = applyMoveToHistory(st.history, st.index, { from, to, promotion: promo },
      isPlayer ? "player" : "engine");
    if (!applied) return null;

    const over = detectGameOver(applied.game);

    let pendingFeedback = null;
    if (isPlayer) {
      const playedUci = applied.move.from + applied.move.to + (applied.move.promotion || "");
      const bestUci = analysis?.bestUci ?? null;
      pendingFeedback = {
        snapshotIndex: applied.index,
        fenAfter: applied.fenAfter,
        session: st.session,
        playedUci,
        bestUci,
        bestMoveSan: bestUci && bestUci !== playedUci ? sanForUci(fenBefore, bestUci) : null,
        evalBeforeWhite: analysis?.scoreWhite ?? null
      };
    }

    setState({
      history: applied.history,
      index: applied.index,
      status: over ? "gameOver" : (isPlayer ? "engineThinking" : "playerTurn"),
      gameOverInfo: over,
      pendingFeedback
    });

    if (isPlayer) {
      if (over) {
        commitFeedback(terminalEvalWhite(applied.game));
      } else {
        if (pendingFeedback.bestUci && pendingFeedback.playedUci === pendingFeedback.bestUci) {
          commitFeedback(null); // "Best!" needs no eval-after
        }
        search("reply", applied.fenAfter, { snapshotIndex: applied.index, fenAfter: applied.fenAfter });
      }
    } else if (!over) {
      // Manual opponent move: no grading, no self-answering reply — it's the
      // player's turn now; pre-analyze it.
      search("analysis", applied.fenAfter);
    }

    return applied.move;
  }

  // direction: -1 | 1 | "start" | "end" | absolute index
  function navigate(direction) {
    const st = state;
    if (st.history.length === 0) return;
    const target = navigationTarget(st.history, st.index, direction, st.playerColor);
    if (target === st.index) return;

    if (target < st.history.length - 1) {
      setState({ index: target, status: "reviewing", currentEval: null });
      search("review", st.history[target].fen);
      return;
    }

    reconcileAtLiveHead(target);
  }

  // Arriving at the live head from any path: derive status and engine work
  // from state. This is what makes an interrupted opponent reply resume and a
  // finished game's overlay come back.
  function reconcileAtLiveHead(target) {
    const liveFen = state.history[target].fen;
    const game = gameAt(state.history, target);
    const over = detectGameOver(game);

    if (over) {
      setState({ index: target, status: "gameOver", gameOverInfo: over, currentEval: null });
      return;
    }

    if (moverIsPlayer(liveFen)) {
      setState({ index: target, status: "playerTurn", gameOverInfo: null, currentEval: null });
      if (state.analysis?.fen !== liveFen) search("analysis", liveFen);
    } else {
      setState({ index: target, status: "engineThinking", gameOverInfo: null, currentEval: null });
      search("reply", liveFen, { snapshotIndex: target, fenAfter: liveFen });
    }
  }

  function setDepth(d) {
    if (!DEPTHS.includes(d)) return;
    setState({ depth: d });
    try { storage?.setItem(DEPTH_KEY, String(d)); } catch { /* best effort */ }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadScenario,
    playMove,
    navigate,
    setDepth,
    dispose() {
      engine.dispose();
      listeners.clear();
    }
  };
}
