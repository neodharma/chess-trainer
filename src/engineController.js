// Stockfish worker wrapper. Owns the UCI handshake, search lifecycle, and
// result attribution. No React, no game knowledge — `meta` is opaque to it.
//
// Attribution invariant: the worker answers strictly in order and emits exactly
// one "bestmove" per "go" (a stopped search still emits its own; "stop" while
// idle emits nothing). So a FIFO of descriptors pushed at go-time and popped at
// each bestmove attributes every result exactly, including partial results
// (last info line seen) from aborted searches.

export function parseScore(infoLine, sideToMove) {
  let m = infoLine.match(/score cp (-?\d+)/);
  let rel;
  if (m) {
    rel = parseInt(m[1], 10);
  } else {
    m = infoLine.match(/score mate (-?\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    rel = n > 0 ? 100000 - n : -100000 - n; // closer mates score higher
  }
  return sideToMove === "w" ? rel : -rel; // white-absolute
}

export function createEngineController({ createWorker, onResult, onInfo }) {
  const worker = createWorker();
  const queue = [];
  let counter = 0;

  worker.onmessage = (event) => {
    const message = event.data;
    const head = queue[0];

    if (message.startsWith("info") && head) {
      const score = parseScore(message, head.sideToMove);
      if (score !== null) head.lastScoreWhite = score;
      const pv = message.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
      if (pv) head.lastBestUci = pv[1];

      if (score !== null && onInfo) {
        onInfo({ fen: head.fen, meta: head.meta, scoreWhite: score, bestUci: head.lastBestUci });
      }
      return;
    }

    if (message.startsWith("bestmove")) {
      const desc = queue.shift();
      if (!desc) return;

      let bestUci = message.split(" ")[1];
      if (bestUci === "(none)") bestUci = desc.lastBestUci;

      if (onResult) {
        onResult({
          fen: desc.fen,
          meta: desc.meta,
          bestUci: bestUci || null,
          scoreWhite: desc.lastScoreWhite
        });
      }
    }
  };

  worker.postMessage("uci");
  worker.postMessage("isready");

  return {
    // Abort any in-flight search and start a new one. The aborted search's
    // bestmove still arrives first and pops its own descriptor.
    search({ fen, depth, meta }) {
      worker.postMessage("stop");
      queue.push({
        id: ++counter,
        fen,
        sideToMove: fen.split(" ")[1],
        meta,
        lastScoreWhite: null,
        lastBestUci: null
      });
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depth}`);
    },

    // Abort without starting a new search.
    stop() {
      worker.postMessage("stop");
    },

    // The in-flight search's partials (for capturing an analysis that hasn't
    // finished when the player moves). Null when idle.
    current() {
      const head = queue[0];
      if (!head) return null;
      return {
        fen: head.fen,
        meta: head.meta,
        lastBestUci: head.lastBestUci,
        lastScoreWhite: head.lastScoreWhite
      };
    },

    dispose() {
      worker.terminate?.();
    }
  };
}
