# miner

Mines endgame scenarios from PGN files using Stockfish, writing results to
`../public/scenarios.json` for the trainer UI to consume.

## Setup

```bash
# Deps
python3 -m venv .venv
.venv/bin/pip install python-chess websockets

# Stockfish (auto-discovered from PATH or common install dirs)
brew install stockfish      # macOS
# or set STOCKFISH_PATH env var, or pass --engine-path

# Optional: Syzygy tablebases at ~/.syzygy/3-4-5 for faster ≤7-piece eval
```

Drop `.pgn` files (one per player/event/etc.) into this directory. They're
gitignored — bring your own corpus.

## Usage

Full mine, default settings:

```bash
.venv/bin/python miner.py --fresh --workers 4 --threads 4
```

Defaults: depth 18, puzzle detection on, output to `../public/scenarios.json`.
On a 10-core M-series, `--workers 4 --threads 4` (4 procs × 1 Stockfish thread)
gives the best throughput — game-level parallelism beats engine-level on this
workload.

### Common flags

| Flag | Default | Effect |
|---|---|---|
| `--depth N` | 18 | Stockfish search depth for the deep eval pass |
| `--workers N` | 1 | Parallel mining processes (orchestrator merges at the end) |
| `--threads N` | 4 | Total Stockfish threads, divided across workers |
| `--fresh` | off | Ignore existing output and start from scratch |
| `--sample N` | off | Randomly sample N games before mining (fast iteration) |
| `--no-puzzles` | off | Disable per-move puzzle detection (~30-50% faster) |
| `--puzzle-depth D` | 14 | Multipv eval depth for puzzle classification |
| `--viz` | off | Stream live worker state to `../public/viz/` for the dashboard |
| `--input DIR` | `.` | PGN source directory |
| `--output PATH` | `../public/scenarios.json` | Output JSON path |
| `--no-syzygy` | off | Disable tablebase lookup even if found |

### Accept criteria

A position is mined as a scenario if it:

- Has 10–25 total material points (kings + minor + major pieces)
- Has ≥ 3 points on each side
- Has ≥ 2 pawns total
- No queens
- Stockfish eval at depth 18 lands in one of:
  - **Drawn**: |eval| ≤ 0.6
  - **Advantage for side-to-move**: 1.0 ≤ |eval| ≤ 1.5

## Tools

### `status.py` — live progress dashboard

Reads `../public/.miner-tmp/worker-*.log` and shows a tabular status:

```bash
.venv/bin/python status.py
```

Wrap in a shell loop for live refresh:

```bash
while true; do clear; .venv/bin/python status.py; sleep 5; done
```

### `viz_server.py` — WebSocket relay for the live viz UI

Watches `../public/viz/worker-N.fen` files (written when miner runs with
`--viz`) and broadcasts state to the trainer's `/viz` page on `ws://localhost:8765`.

```bash
# In one terminal:
.venv/bin/python viz_server.py

# In another:
.venv/bin/python miner.py --fresh --workers 4 --threads 4 --viz [...]

# Then open http://localhost:5173/viz in the browser
```

## Output schema

Each scenario in `scenarios.json`:

```jsonc
{
  "id": "abc12345",                // sha1(canonical FEN)[:8]
  "fen": "...",                     // full FEN at the accepted position
  "eval": 0.0,                      // Stockfish eval at depth 18 (white POV)
  "eval_tag": 0.0,                  // round(|eval|, 1) for filtering
  "material_points": 22,            // total non-king material
  "imbalance": false,               // true if material diff ≥ 2 in next 2 best moves
  "turn": "white",                  // side to move
  "description": "Move 28, ...",    // human-readable summary
  "tags": ["rook_endgame", "puzzle"],
  "players": "Carlsen vs Caruana",
  "year": "2023",
  "result": "1/2-1/2",
  "source_file": "Carlsen.pgn",
  "puzzle_move": "f5e6"             // present only for "puzzle"-tagged scenarios
}
```

## Architecture notes

- **Two-pass engine eval**: shallow triage at depth 10 with a ±1.7 cutoff
  rejects most positions cheaply. Stockfish's transposition table carries over
  to the deep pass, so the triage cost is mostly recovered for accepted
  positions.
- **Multi-worker orchestration**: `--workers N` splits PGN games into N
  balanced chunks (sorted by move count, snake-distributed). Each worker
  mines independently to a temp file, then the orchestrator merges with
  canonical-FEN dedup at the end.
- **Resume on rerun**: omitting `--fresh` re-uses the existing `scenarios.json`
  as the dedup base — already-seen canonical FENs get skipped.
