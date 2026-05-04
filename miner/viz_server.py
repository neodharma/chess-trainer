#!/usr/bin/env python3
"""Live miner visualization relay.

Watches public/viz/worker-*.fen files (written by miner workers when launched
with --viz) and broadcasts FEN changes to all connected WebSocket clients.

Run alongside the miner:
    miner/.venv/bin/python miner/viz_server.py

Then point the browser at http://localhost:5173/viz (Vite must also be running).
"""
import asyncio
import glob
import json
import os
import re
import sys

import websockets

VIZ_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "public", "viz")
HOST = "localhost"
PORT = 8765
POLL_HZ = 60  # internal file-poll rate; broadcast happens only on change


def read_worker_states():
    """Return {worker_id: {"fen": ..., "status": ...}} for every worker file.
    Files are JSON written by miner's write_viz(); fall back to plain-FEN
    interpretation for back-compat if the file isn't valid JSON."""
    out = {}
    for path in glob.glob(os.path.join(VIZ_DIR, "worker-*.fen")):
        m = re.search(r"worker-(\d+)\.fen$", path)
        if not m:
            continue
        try:
            with open(path) as f:
                raw = f.read().strip()
        except OSError:
            continue
        if not raw:
            continue
        try:
            state = json.loads(raw)
            if "fen" not in state:
                continue
        except json.JSONDecodeError:
            state = {"fen": raw, "status": "playing"}
        out[int(m.group(1))] = state
    return out


def state_signature(state):
    """Compact signature used for change-detection — captures both FEN and
    status so 'evaluating'/'found' transitions on the same FEN still fire."""
    return (state.get("fen"), state.get("status"))


async def broadcast_loop(clients, last_sigs):
    """Poll worker state files at POLL_HZ; push deltas to all clients."""
    interval = 1.0 / POLL_HZ
    while True:
        await asyncio.sleep(interval)
        if not clients:
            continue
        states = read_worker_states()
        for wid, state in states.items():
            sig = state_signature(state)
            if last_sigs.get(wid) == sig:
                continue
            last_sigs[wid] = sig
            msg = json.dumps({"worker": wid, **state})
            await asyncio.gather(
                *(c.send(msg) for c in list(clients)),
                return_exceptions=True,
            )


async def handler(ws, clients, last_sigs):
    clients.add(ws)
    try:
        # Send current state on connect so the page populates immediately.
        for wid, state in read_worker_states().items():
            await ws.send(json.dumps({"worker": wid, **state}))
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def main():
    if not os.path.isdir(VIZ_DIR):
        os.makedirs(VIZ_DIR, exist_ok=True)
    clients = set()
    last_sigs = {}
    asyncio.create_task(broadcast_loop(clients, last_sigs))
    print(f"viz_server listening on ws://{HOST}:{PORT} — watching {VIZ_DIR}")
    sys.stdout.flush()
    async with websockets.serve(
        lambda ws: handler(ws, clients, last_sigs),
        HOST, PORT,
    ):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nshutting down")
