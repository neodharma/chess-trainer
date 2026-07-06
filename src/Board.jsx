import { useEffect, useRef } from "react";
import { Chessground } from "chessground";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import { gameAt, toDests } from "./gameLogic.js";

// The only chessground-aware component. Mounts the board once and keeps it in
// sync with the store snapshot; user moves flow into store.playMove — the same
// single entry point the dev E2E hook uses.
export default function Board({ store, state }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);

  useEffect(() => {
    if (hostRef.current && !apiRef.current) {
      apiRef.current = Chessground(hostRef.current, {
        fen: "start",
        orientation: "white",
        movable: {
          free: false,
          events: {
            after: (orig, dest) => {
              const move = store.playMove(orig, dest);
              if (!move) {
                // Illegal per chess.js: snap the board back to the store's truth
                const s = store.getState();
                const snap = s.history[s.index];
                if (snap) apiRef.current.set({ fen: snap.fen });
              }
            }
          }
        }
      });

      // Dev-only E2E hook: drive moves through the exact production path
      // (chessground drops synthetic mouse events unless trusted).
      if (import.meta.env.DEV) {
        window.__testMove = (orig, dest, promo) => store.playMove(orig, dest, promo);
        window.__store = store;
      }
    }
  }, [store]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || state.history.length === 0) return;

    const snap = state.history[state.index];
    const game = gameAt(state.history, state.index);
    const turnColor = game.turn() === "w" ? "white" : "black";

    api.set({
      fen: snap.fen,
      orientation: state.playerColor,
      turnColor,
      lastMove: snap.lastMove || undefined,
      movable: { color: turnColor, free: false, dests: toDests(game) }
    });
  }, [state]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
