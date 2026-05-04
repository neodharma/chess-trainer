import argparse
import chess
import chess.pgn
import chess.engine
import glob
import hashlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time

# --- DEFAULTS ---
DEFAULT_DEPTH = 18
# Conservative default: leave headroom for the OS so the machine stays usable
# during long mining runs. On a 10-core M-series, 4 threads = P-cores only.
# Override with --threads when you want to push harder.
DEFAULT_THREADS = max(1, min(4, (os.cpu_count() or 4)))
DEFAULT_HASH_MB = 512
DEFAULT_INPUT = "."
DEFAULT_OUTPUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "public", "scenarios.json"
)
# Write to disk every N new scenarios so long runs are resumable on crash.
CHECKPOINT_EVERY = 50

# --- CRITERIA ---
MIN_TOTAL_POINTS = 10
MAX_TOTAL_POINTS = 25
MIN_SIDE_POINTS = 3

# --- GLOBAL STATE FOR PROGRESS BAR ---
g_start_time = 0
g_total_games = 0
g_games_processed = 0
g_scenarios_found = 0
g_current_file = ""


def find_engine(explicit_path=None):
    """Locate a Stockfish binary across platforms.
    Priority: explicit arg -> STOCKFISH_PATH env -> PATH -> common install locations.
    """
    if explicit_path:
        return explicit_path if os.path.exists(explicit_path) else None
    env_path = os.environ.get("STOCKFISH_PATH")
    if env_path and os.path.exists(env_path):
        return env_path
    found = shutil.which("stockfish")
    if found:
        return found
    candidates = [
        "/opt/homebrew/bin/stockfish",  # macOS Apple silicon (brew)
        "/usr/local/bin/stockfish",      # macOS Intel (brew) / Linux
        "/usr/bin/stockfish",            # Linux apt
        r"C:\Users\benmc\Documents\stockfish\stockfish-windows-x86-64-avx2.exe",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def find_syzygy(explicit_path=None):
    """Locate a Syzygy tablebase directory.
    Priority: explicit arg -> SYZYGY_PATH env -> common locations.
    Returns None if no directory containing .rtbw files is found.
    """
    candidates = []
    if explicit_path:
        candidates.append(explicit_path)
    env_path = os.environ.get("SYZYGY_PATH")
    if env_path:
        candidates.append(env_path)
    candidates.extend([
        os.path.expanduser("~/.syzygy/3-4-5"),
        os.path.expanduser("~/.syzygy"),
        os.path.expanduser("~/syzygy"),
        "/opt/syzygy",
        "/usr/local/share/syzygy",
    ])
    for p in candidates:
        if not p:
            continue
        if os.path.isdir(p) and any(f.endswith(".rtbw") for f in os.listdir(p)):
            return p
    return None


def get_material_score(board):
    values = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
    w_score = 0
    b_score = 0
    for piece_type, value in values.items():
        w_score += len(board.pieces(piece_type, chess.WHITE)) * value
        b_score += len(board.pieces(piece_type, chess.BLACK)) * value
    return w_score, b_score, w_score + b_score


# --- TAGGING LOGIC ---
# Each tag is mutually exclusive: it requires the relevant piece to be present
# AND for the other major/minor categories to be absent. A position that doesn't
# fit any (e.g. K+R+B vs K) gets no piece-type tag.
# Uses python-chess's built-in piece-type bitmasks (board.queens, .rooks, etc.) —
# these are 64-bit ints, so truthy-checks are a single int comparison.
def is_pawn_endgame(board):
    return not (board.knights or board.bishops or board.rooks or board.queens)


def is_rook_endgame(board):
    return bool(board.rooks) and not (board.knights or board.bishops or board.queens)


def is_bishop_endgame(board):
    return bool(board.bishops) and not (board.knights or board.rooks or board.queens)


def is_knight_endgame(board):
    return bool(board.knights) and not (board.bishops or board.rooks or board.queens)


def get_tags_for_board(board):
    tags = []
    if is_pawn_endgame(board): tags.append("pawn_endgame")
    if is_rook_endgame(board): tags.append("rook_endgame")
    if is_bishop_endgame(board): tags.append("bishop_endgame")
    if is_knight_endgame(board): tags.append("knight_endgame")
    return tags


# --- DESCRIPTION ---
def piece_breakdown(board, color):
    """e.g. 'K+R+3P' for King + 1 Rook + 3 Pawns."""
    parts = ["K"]
    for pt, sym in [(chess.QUEEN, 'Q'), (chess.ROOK, 'R'),
                    (chess.BISHOP, 'B'), (chess.KNIGHT, 'N'),
                    (chess.PAWN, 'P')]:
        n = len(board.pieces(pt, color))
        if n == 1:
            parts.append(sym)
        elif n > 1:
            parts.append(f"{n}{sym}")
    return "+".join(parts)


def make_description(board, game_result):
    side = "White" if board.turn == chess.WHITE else "Black"
    w = piece_breakdown(board, chess.WHITE)
    b = piece_breakdown(board, chess.BLACK)
    return (f"Move {board.fullmove_number}, {side} to move "
            f"· {w} vs {b} · Game: {game_result}")


def fen_canonical(fen):
    """Strip halfmove/fullmove counters: position-based identity rather than path-based."""
    parts = fen.split()
    return " ".join(parts[:4]) if len(parts) >= 4 else fen


def fen_id(fen):
    """Stable 8-char hex id from canonical FEN."""
    return hashlib.sha1(fen_canonical(fen).encode()).hexdigest()[:8]


# --- ENGINE ANALYSIS ---
# Two-pass: shallow triage first, then full depth only on candidates.
# Stockfish's transposition table persists across analyse() calls on the same
# position, so the deep pass reuses the shallow pass's work — triage is nearly
# free for accepted positions, but cuts the deep pass entirely for rejected ones.
TRIAGE_DEPTH = 10
# |eval| beyond this at triage depth = skip deep pass. Set 0.2 above the
# widest accept threshold (1.5) — shallow eval is noisy by ~0.2 pawns,
# so anything beyond 1.7 is very unlikely to fall back into the accept band.
TRIAGE_WINDOW = 1.7

# --- PUZZLE DETECTION ---
# A "puzzle" is a drawn position where exactly one legal move keeps the eval
# in the drawn band [-0.6, 0.6] and every other move gives the opponent at
# least advantage-magnitude (white-eval ≥ 1.0 in the opponent's favor —
# includes mate threats and crushing positions). Loose semantics: moves that
# land in the (0.6, 1.0) "small edge" gap zone disqualify the puzzle.
DRAWN_LO, DRAWN_HI = -0.6, 0.6
PUZZLE_OPPONENT_ADV = 1.0
DEFAULT_PUZZLE_DEPTH = 14


def detect_puzzle_move(board, engine, depth):
    """Return UCI of the unique drawing move, or None if no such move exists.
    Uses Stockfish multipv=K to evaluate every legal move in one search."""
    legal = list(board.legal_moves)
    if len(legal) <= 1:
        return None  # no choice → not a puzzle

    try:
        infos = engine.analyse(board, chess.engine.Limit(depth=depth),
                               multipv=len(legal))
    except chess.engine.EngineError:
        return None
    if isinstance(infos, dict):
        infos = [infos]

    drawn_move = None
    for info in infos:
        pv = info.get("pv", [])
        if not pv:
            return None
        move = pv[0]
        score = info["score"].white()
        if score.is_mate():
            ev = 1000.0 if score.mate() > 0 else -1000.0
        else:
            ev = score.score() / 100.0

        if DRAWN_LO <= ev <= DRAWN_HI:
            if drawn_move is not None:
                return None  # second drawn move → no unique solution
            drawn_move = move
            continue

        # Non-drawn: must be advantage-or-worse for the opponent.
        # board.turn is the current mover; after `move`, opponent has the move.
        if board.turn == chess.WHITE:
            # opponent = black; advantage for black ⇒ ev ≤ -1.0
            if ev > -PUZZLE_OPPONENT_ADV:
                return None
        else:
            # opponent = white; advantage for white ⇒ ev ≥ 1.0
            if ev < PUZZLE_OPPONENT_ADV:
                return None

    return drawn_move.uci() if drawn_move else None


def analyze_position(board, engine, depth):
    try:
        # Pass 1: shallow triage
        shallow = engine.analyse(board, chess.engine.Limit(depth=TRIAGE_DEPTH))
        s_score = shallow["score"].white()
        if s_score.is_mate():
            return None, True, []
        s_eval = s_score.score() / 100.0
        if not (-TRIAGE_WINDOW <= s_eval <= TRIAGE_WINDOW):
            return None, True, []

        # Pass 2: deep eval (transposition table primed by triage)
        info = engine.analyse(board, chess.engine.Limit(depth=depth))
        score_obj = info["score"].white()
        if score_obj.is_mate():
            return None, True, []

        eval_decimal = score_obj.score() / 100.0
        is_drawn = -0.6 <= eval_decimal <= 0.6
        is_white_adv = (1.0 <= eval_decimal <= 1.5) and (board.turn == chess.WHITE)
        is_black_adv = (-1.5 <= eval_decimal <= -1.0) and (board.turn == chess.BLACK)

        if not (is_drawn or is_white_adv or is_black_adv):
            return None, True, []

        pv_line = info.get("pv", [])
        best_moves = pv_line[:2] if len(pv_line) >= 1 else []
        return eval_decimal, False, best_moves
    except Exception:
        return None, True, []


# --- CONSOLE UI ---
def draw_progress_bar():
    elapsed = time.time() - g_start_time
    rate = g_games_processed / elapsed if elapsed > 0 else 0
    percent = (g_games_processed / g_total_games) * 100 if g_total_games > 0 else 0

    bar_length = 25
    filled_length = int(bar_length * g_games_processed // g_total_games) if g_total_games > 0 else 0
    bar = "█" * filled_length + "-" * (bar_length - filled_length)

    display_file = (g_current_file[:15] + '..') if len(g_current_file) > 15 else g_current_file
    status = (f"\r[{bar}] {percent:.1f}% | {g_games_processed}/{g_total_games} | "
              f"{rate:.1f} g/s | Found: {g_scenarios_found} | File: {display_file}")
    sys.stdout.write(f"{status:<120}")
    sys.stdout.flush()


def log_to_console(message):
    sys.stdout.write("\r" + " " * 120 + "\r")
    print(message)
    draw_progress_bar()


def count_total_games(pgn_files):
    print("🔍 Pre-scanning files to count total games...")
    total = 0
    for pgn_file in pgn_files:
        with open(pgn_file, encoding="latin-1") as f:
            total += sum(1 for line in f if line.startswith("[Event "))
    print(f"✅ Total Games Detected: {total}\n")
    return total


def parse_args():
    p = argparse.ArgumentParser(description="Mine endgame scenarios from PGN files.")
    p.add_argument("--depth", type=int, default=DEFAULT_DEPTH,
                   help=f"Stockfish search depth (default: {DEFAULT_DEPTH})")
    p.add_argument("--engine-path", default=None,
                   help="Path to Stockfish binary (else auto-discovered)")
    p.add_argument("--input", default=DEFAULT_INPUT,
                   help="Directory containing .pgn files (default: current dir)")
    p.add_argument("--output", default=DEFAULT_OUTPUT,
                   help="Output JSON path (default: ../public/scenarios.json)")
    p.add_argument("--threads", type=int, default=DEFAULT_THREADS,
                   help=f"Stockfish threads (default: {DEFAULT_THREADS})")
    p.add_argument("--hash", type=int, default=DEFAULT_HASH_MB, dest="hash_mb",
                   help=f"Stockfish hash size in MB (default: {DEFAULT_HASH_MB})")
    p.add_argument("--fresh", action="store_true",
                   help="Ignore any existing output file and start from scratch")
    p.add_argument("--workers", type=int, default=1,
                   help="Number of parallel mining subprocesses (default: 1). "
                        "Each worker gets --threads / --workers Stockfish threads. "
                        "Workers run with --fresh; existing output is preserved by merging at the end.")
    p.add_argument("--syzygy-path", default=None,
                   help="Path to Syzygy tablebase directory (else auto-discovered). "
                        "Speeds up endgame eval significantly when ≤7 pieces.")
    p.add_argument("--no-syzygy", action="store_true",
                   help="Disable Syzygy TB lookup even if a directory is found.")
    p.add_argument("--no-puzzles", action="store_true",
                   help="Disable puzzle detection (default: enabled). Puzzle "
                        "detection runs multipv eval on every legal move of "
                        "accepted drawn positions to find scenarios with a "
                        "unique drawing move; adds ~30-50%% to runtime.")
    p.add_argument("--puzzle-depth", type=int, default=DEFAULT_PUZZLE_DEPTH,
                   help=f"Search depth for puzzle multipv eval (default: "
                        f"{DEFAULT_PUZZLE_DEPTH}). Lower than main depth since "
                        f"this just classifies moves as drawn/losing.")
    p.add_argument("--sample", type=int, default=None,
                   help="Randomly sample this many GAMES from the input PGNs "
                        "before mining (off by default; useful for fast "
                        "iteration on a small representative set).")
    p.add_argument("--viz", action="store_true",
                   help="Enable live visualization: workers stream their "
                        "current FEN to public/viz/worker-N.fen so the "
                        "viz_server can broadcast over WebSocket.")
    p.add_argument("--viz-path", default=None,
                   help="(internal) Per-worker FEN output path; set by the "
                        "orchestrator when --viz is enabled.")
    return p.parse_args()


def write_viz(viz_path, fen, status="playing"):
    """Write current FEN + status atomically to viz_path. Status values:
      - 'playing'    — stepping through moves (default)
      - 'evaluating' — about to run Stockfish on a material-filter candidate
      - 'found'      — scenario accepted (eval landed in drawn/advantage band)
      - 'new_game'   — start of a new game (initial position)
    """
    if not viz_path:
        return
    try:
        with open(viz_path, "w") as f:
            json.dump({"fen": fen, "status": status}, f)
    except OSError:
        pass


def write_output(scenarios, output_path):
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(scenarios, f, indent=2)


# --- MULTI-PROCESS ORCHESTRATION ---
def collect_game_texts(pgn_files):
    """Read all PGN files and yield raw text per game (split on [Event headers)."""
    games = []
    for path in pgn_files:
        with open(path, encoding="latin-1") as f:
            text = f.read()
        chunks = re.split(r'(?=^\[Event )', text, flags=re.MULTILINE)
        games.extend(c.strip() for c in chunks if c.strip().startswith('[Event '))
    return games


def estimate_game_complexity(game_text):
    """Cheap proxy for mining cost. Long games have more endgame positions and
    more deep-eval candidates — counting move numbers ('1.', '2.', ...) approximates
    fullmove count without parsing the SAN."""
    return len(re.findall(r'\b\d+\.', game_text))


def balance_chunks(games, n):
    """Distribute games across n workers so each worker has roughly the same
    total work. Sorts by descending complexity, then round-robins into buckets
    (snake assignment): worker 0 gets longest, worker 1 gets 2nd-longest, etc.,
    wrapping around. Each bucket ends up with a balanced mix of long+short games."""
    ranked = sorted(games, key=estimate_game_complexity, reverse=True)
    buckets = [[] for _ in range(n)]
    for rank, game in enumerate(ranked):
        buckets[rank % n].append(game)
    return buckets


def merge_worker_outputs(worker_outputs, existing_scenarios, final_output):
    """Merge worker JSONs into one, dedup by canonical FEN (existing wins)."""
    merged = list(existing_scenarios)
    seen = {fen_canonical(s["fen"]) for s in merged if "fen" in s}
    for path in worker_outputs:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            data = json.load(f)
        for s in data:
            canon = fen_canonical(s.get("fen", ""))
            if not canon or canon in seen:
                continue
            seen.add(canon)
            merged.append(s)
    write_output(merged, final_output)
    return len(merged)


def orchestrate_workers(args, engine_path):
    n = args.workers
    per_worker_threads = max(1, args.threads // n)
    syzygy_path = None if args.no_syzygy else find_syzygy(args.syzygy_path)

    pgn_files = sorted(glob.glob(os.path.join(args.input, "*.pgn")))
    if not pgn_files:
        print(f"❌ ERROR: No PGN files found in {os.path.abspath(args.input)}.")
        return

    # Load existing output for merge (resume-style) unless --fresh
    existing = []
    if not args.fresh and os.path.exists(args.output):
        try:
            with open(args.output) as f:
                existing = json.load(f)
            print(f"📂 Loaded {len(existing)} existing scenarios for merge")
        except (json.JSONDecodeError, OSError) as e:
            print(f"⚠️  Could not load existing output ({e}); proceeding fresh.")
            existing = []

    print(f"🔍 Reading and balancing games across {n} chunks...")
    all_games = collect_game_texts(pgn_files)
    if args.sample and len(all_games) > args.sample:
        all_games = random.sample(all_games, args.sample)
        print(f"📋 Sampled {len(all_games)} games for this run")
    total = len(all_games)
    if total == 0:
        print("❌ ERROR: No games found in PGN files.")
        return
    buckets = balance_chunks(all_games, n)

    # Setup temp dir adjacent to output
    out_dir = os.path.dirname(os.path.abspath(args.output)) or "."
    tmp_dir = os.path.join(out_dir, ".miner-tmp")
    if os.path.exists(tmp_dir):
        shutil.rmtree(tmp_dir)
    os.makedirs(tmp_dir, exist_ok=True)

    # Live viz: always write to <project>/public/viz/ regardless of --output,
    # since viz_server.py watches that fixed path.
    viz_dir = None
    if args.viz:
        viz_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "..", "public", "viz")
        os.makedirs(viz_dir, exist_ok=True)
        for stale in glob.glob(os.path.join(viz_dir, "worker-*.fen")):
            try: os.remove(stale)
            except OSError: pass

    # Write each chunk into its own subdir so worker glob('*.pgn') picks just one
    chunks_info = []
    for i, chunk in enumerate(buckets):
        if not chunk:
            continue
        sub = os.path.join(tmp_dir, f"worker-{i}")
        os.makedirs(sub, exist_ok=True)
        chunk_path = os.path.join(sub, "chunk.pgn")
        with open(chunk_path, "w", encoding="latin-1") as f:
            f.write("\n\n".join(chunk) + "\n")
        out_path = os.path.join(tmp_dir, f"output-{i}.json")
        log_path = os.path.join(tmp_dir, f"worker-{i}.log")
        # Sum moves as a complexity-balance sanity check
        chunk_moves = sum(estimate_game_complexity(g) for g in chunk)
        chunks_info.append((i, sub, out_path, log_path, len(chunk), chunk_moves))

    print(f"🚀 Spawning {len(chunks_info)} workers — "
          f"{per_worker_threads} threads each, {args.hash_mb} MB hash each")
    if syzygy_path:
        print(f"   syzygy: {syzygy_path}")
    print(f"   total: {total} games | output → {os.path.abspath(args.output)}\n")

    procs = []
    start = time.time()
    for i, sub, out_path, log_path, count, moves in chunks_info:
        cmd = [
            sys.executable, os.path.abspath(__file__),
            "--input", sub,
            "--output", out_path,
            "--workers", "1",
            "--threads", str(per_worker_threads),
            "--depth", str(args.depth),
            "--hash", str(args.hash_mb),
            "--engine-path", engine_path,
            "--fresh",
        ]
        if syzygy_path:
            cmd += ["--syzygy-path", syzygy_path]
        elif args.no_syzygy:
            cmd += ["--no-syzygy"]
        if args.no_puzzles:
            cmd += ["--no-puzzles"]
        else:
            cmd += ["--puzzle-depth", str(args.puzzle_depth)]
        if viz_dir:
            cmd += ["--viz-path", os.path.join(viz_dir, f"worker-{i}.fen")]
        # Note: --sample is NOT propagated; the orchestrator already sampled.
        log_file = open(log_path, "w")
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
        procs.append((proc, log_file, log_path, i, count, moves))
        print(f"   ▶ worker {i}: {count} games, ~{moves} moves (PID {proc.pid})")

    # Poll-style wait so we can show "first done" timing
    print(f"\n⏳ Waiting for workers...")
    remaining = set(range(len(procs)))
    while remaining:
        time.sleep(2)
        for idx in list(remaining):
            proc, log_file, log_path, i, count, moves = procs[idx]
            if proc.poll() is not None:
                log_file.close()
                elapsed = time.time() - start
                rc = proc.returncode
                status = "✓" if rc == 0 else f"✗ (rc={rc})"
                # Surface final scenario count from worker log if available
                worker_count = "?"
                try:
                    with open(log_path) as f:
                        for line in f:
                            m = re.search(r"Saved (\d+) scenarios", line)
                            if m:
                                worker_count = m.group(1)
                except OSError:
                    pass
                print(f"   {status} worker {i} done at {elapsed:.0f}s "
                      f"({count} games → {worker_count} scenarios)")
                remaining.discard(idx)

    total_elapsed = time.time() - start

    print(f"\n🔗 Merging worker outputs...")
    worker_outputs = [info[2] for info in chunks_info]
    final_count = merge_worker_outputs(worker_outputs, existing, args.output)

    print(f"💾 Done in {total_elapsed:.0f}s — "
          f"{final_count} unique scenarios → {os.path.abspath(args.output)}")
    print(f"   (worker logs preserved in {tmp_dir} — delete when satisfied)")


def mine_games():
    global g_start_time, g_total_games, g_games_processed, g_scenarios_found, g_current_file
    args = parse_args()

    engine_path = find_engine(args.engine_path)
    if not engine_path:
        print("❌ ERROR: Stockfish not found. Install via `brew install stockfish`, "
              "set the STOCKFISH_PATH env var, or pass --engine-path.")
        return

    # Multi-worker mode: orchestrate subprocesses and exit.
    if args.workers > 1:
        orchestrate_workers(args, engine_path)
        return

    pgn_files = sorted(glob.glob(os.path.join(args.input, "*.pgn")))
    if not pgn_files:
        print(f"❌ ERROR: No PGN files found in {os.path.abspath(args.input)}.")
        return

    syzygy_path = None if args.no_syzygy else find_syzygy(args.syzygy_path)

    # In --sample mode we materialize all game texts in memory so we can
    # randomly subsample. Otherwise stream from files for memory efficiency.
    sampled_texts = None
    if args.sample:
        all_texts = collect_game_texts(pgn_files)
        if len(all_texts) > args.sample:
            all_texts = random.sample(all_texts, args.sample)
        sampled_texts = all_texts
        g_total_games = len(sampled_texts)
        print(f"📋 Sampled {g_total_games} games for this run\n")
    else:
        g_total_games = count_total_games(pgn_files)

    puzzles_enabled = not args.no_puzzles
    print(f"🚀 Starting Miner — engine={engine_path}, depth={args.depth}, "
          f"threads={args.threads}, hash={args.hash_mb}MB, "
          f"puzzles={'on (depth=' + str(args.puzzle_depth) + ')' if puzzles_enabled else 'off'}")
    if syzygy_path:
        n_tb = sum(1 for f in os.listdir(syzygy_path) if f.endswith(".rtbw"))
        print(f"   syzygy: {syzygy_path} ({n_tb} WDL tables)")
    elif args.no_syzygy:
        print(f"   syzygy: disabled")
    else:
        print(f"   syzygy: not found (skip ≤7-piece TB acceleration)")
    print(f"   output → {os.path.abspath(args.output)}")

    # Resume: load existing scenarios so we don't redo work
    scenarios = []
    seen_canon = set()
    if not args.fresh and os.path.exists(args.output):
        try:
            with open(args.output) as f:
                scenarios = json.load(f)
            seen_canon = {fen_canonical(s["fen"]) for s in scenarios if "fen" in s}
            g_scenarios_found = len(scenarios)
            print(f"   resuming with {len(scenarios)} existing scenarios "
                  f"({len(seen_canon)} canonical positions already seen)")
        except (json.JSONDecodeError, OSError) as e:
            print(f"⚠️  Could not load existing output ({e}); starting fresh.")
            scenarios = []
            seen_canon = set()
    print()
    g_start_time = time.time()

    try:
        engine = chess.engine.SimpleEngine.popen_uci(engine_path)
        engine_opts = {"Threads": args.threads, "Hash": args.hash_mb}
        if syzygy_path:
            engine_opts["SyzygyPath"] = syzygy_path
        try:
            engine.configure(engine_opts)
        except chess.engine.EngineError as e:
            print(f"⚠️  Engine config warning: {e}")

        # Build a unified (source_label, game) iterator covering both modes.
        def games_iter():
            if sampled_texts is not None:
                for text in sampled_texts:
                    g = chess.pgn.read_game(io.StringIO(text))
                    if g is not None:
                        yield "(sampled)", g
                return
            for pgn_file in pgn_files:
                with open(pgn_file, encoding="latin-1") as pgn:
                    while True:
                        g = chess.pgn.read_game(pgn)
                        if g is None:
                            break
                        yield os.path.basename(pgn_file), g

        last_label = None
        for source_label, game in games_iter():
            if source_label != last_label:
                if last_label is not None and last_label != "(sampled)":
                    log_to_console(f"   ✓ Completed file: {last_label}")
                last_label = source_label
                g_current_file = source_label
            g_games_processed += 1

            if g_games_processed % 50 == 0: draw_progress_bar()

            white_player = game.headers.get("White", "Unknown")
            black_player = game.headers.get("Black", "Unknown")
            date = game.headers.get("Date", "????")
            year = date.split(".")[0] if "." in date else date
            game_result = game.headers.get("Result", "*")

            board = game.board()
            write_viz(args.viz_path, board.fen(), "new_game")

            for move in game.mainline_moves():
                board.push(move)
                write_viz(args.viz_path, board.fen(), "playing")

                # --- FAST FILTERS ---
                # Skip queen positions — heavy_piece_endgame removed for speed
                if board.queens: continue

                w_score, b_score, total_material = get_material_score(board)

                if not (MIN_TOTAL_POINTS <= total_material <= MAX_TOTAL_POINTS): continue
                if w_score < MIN_SIDE_POINTS or b_score < MIN_SIDE_POINTS: continue
                if (len(board.pieces(chess.PAWN, chess.WHITE))
                        + len(board.pieces(chess.PAWN, chess.BLACK))) < 2: continue

                # --- DEDUP (cheap reject of already-seen positions, before engine) ---
                fen = board.fen()
                canon = fen_canonical(fen)
                if canon in seen_canon: continue

                # --- ENGINE FILTER (two-pass: shallow triage, then deep) ---
                write_viz(args.viz_path, fen, "evaluating")
                eval_score, is_boring, best_moves = analyze_position(
                    board, engine, depth=args.depth
                )

                if is_boring or eval_score is None: continue

                seen_canon.add(canon)

                current_tags = get_tags_for_board(board)

                # Single push/pop pass — collect future tags AND compute
                # imbalance from the same traversal of best_moves[:2].
                future_tags = []
                has_imbalance = False
                moves_pushed = 0
                for next_move in best_moves[:2]:
                    board.push(next_move)
                    moves_pushed += 1
                    future_tags += get_tags_for_board(board)
                if moves_pushed >= 2:
                    w, b, _ = get_material_score(board)
                    has_imbalance = abs(w - b) >= 2
                for _ in range(moves_pushed):
                    board.pop()

                # Puzzle detection: only meaningful on drawn-eval positions.
                puzzle_move = None
                if puzzles_enabled and DRAWN_LO <= eval_score <= DRAWN_HI:
                    puzzle_move = detect_puzzle_move(board, engine, args.puzzle_depth)

                all_tags = list(current_tags + future_tags)
                if puzzle_move:
                    all_tags.append("puzzle")
                all_tags = sorted(set(all_tags))
                eval_tag = round(abs(eval_score), 1)
                sid = fen_id(fen)

                g_scenarios_found += 1
                tag_marker = " 🧩" if puzzle_move else ""
                log_to_console(
                    f"✅ Found #{g_scenarios_found} ({sid}){tag_marker}: {fen} | "
                    f"Eval: {eval_score:.2f} | Mat: {total_material}"
                )
                write_viz(args.viz_path, fen, "found")

                entry = {
                    "id": sid,
                    "fen": fen,
                    "eval": eval_score,
                    "eval_tag": eval_tag,
                    "material_points": total_material,
                    "imbalance": has_imbalance,
                    "turn": "white" if board.turn == chess.WHITE else "black",
                    "description": make_description(board, game_result),
                    "tags": all_tags,
                    "players": f"{white_player} vs {black_player}",
                    "year": year,
                    "result": game_result,
                    "source_file": source_label,
                }
                if puzzle_move:
                    entry["puzzle_move"] = puzzle_move
                scenarios.append(entry)

                # Periodic checkpoint
                if len(scenarios) % CHECKPOINT_EVERY == 0:
                    write_output(scenarios, args.output)

                break

        if last_label is not None and last_label != "(sampled)":
            log_to_console(f"   ✓ Completed file: {last_label}")

        engine.quit()
        sys.stdout.write("\n")
        write_output(scenarios, args.output)
        print(f"💾 Done! Saved {len(scenarios)} scenarios to {args.output}")

    except KeyboardInterrupt:
        sys.stdout.write("\n")
        print("🛑 Stopped by user. Saving current data...")
        write_output(scenarios, args.output)


if __name__ == "__main__":
    mine_games()
