import argparse
import chess
import chess.pgn
import chess.engine
import glob
import hashlib
import json
import os
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
def _has_any(board, piece_type):
    return bool(board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK))


def is_pawn_endgame(board):
    # Kings + pawns only.
    for piece_type in [chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN]:
        if _has_any(board, piece_type):
            return False
    return True


def is_rook_endgame(board):
    if not _has_any(board, chess.ROOK):
        return False
    for piece_type in [chess.KNIGHT, chess.BISHOP, chess.QUEEN]:
        if _has_any(board, piece_type):
            return False
    return True


def is_bishop_endgame(board):
    if not _has_any(board, chess.BISHOP):
        return False
    for piece_type in [chess.KNIGHT, chess.ROOK, chess.QUEEN]:
        if _has_any(board, piece_type):
            return False
    return True


def is_knight_endgame(board):
    if not _has_any(board, chess.KNIGHT):
        return False
    for piece_type in [chess.BISHOP, chess.ROOK, chess.QUEEN]:
        if _has_any(board, piece_type):
            return False
    return True


def get_tags_for_board(board):
    tags = []
    if is_pawn_endgame(board): tags.append("pawn_endgame")
    if is_rook_endgame(board): tags.append("rook_endgame")
    if is_bishop_endgame(board): tags.append("bishop_endgame")
    if is_knight_endgame(board): tags.append("knight_endgame")
    return tags


def check_future_imbalance(board, moves):
    if len(moves) < 2: return False
    board.push(moves[0])
    board.push(moves[1])
    w, b, _ = get_material_score(board)
    diff = abs(w - b)
    board.pop()
    board.pop()
    return diff >= 2


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
TRIAGE_WINDOW = 2.0  # |eval| beyond this at triage depth = skip deep pass


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
              f"{rate:.0f} g/s | Found: {g_scenarios_found} | File: {display_file}")
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
        with open(pgn_file) as f:
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
    return p.parse_args()


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
        with open(path) as f:
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

    # Write each chunk into its own subdir so worker glob('*.pgn') picks just one
    chunks_info = []
    for i, chunk in enumerate(buckets):
        if not chunk:
            continue
        sub = os.path.join(tmp_dir, f"worker-{i}")
        os.makedirs(sub, exist_ok=True)
        chunk_path = os.path.join(sub, "chunk.pgn")
        with open(chunk_path, "w") as f:
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

    g_total_games = count_total_games(pgn_files)
    print(f"🚀 Starting Miner — engine={engine_path}, depth={args.depth}, "
          f"threads={args.threads}, hash={args.hash_mb}MB")
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

        for pgn_file in pgn_files:
            g_current_file = os.path.basename(pgn_file)

            with open(pgn_file) as pgn:
                while True:
                    game = chess.pgn.read_game(pgn)
                    if game is None: break
                    g_games_processed += 1

                    if g_games_processed % 50 == 0: draw_progress_bar()

                    white_player = game.headers.get("White", "Unknown")
                    black_player = game.headers.get("Black", "Unknown")
                    date = game.headers.get("Date", "????")
                    year = date.split(".")[0] if "." in date else date
                    game_result = game.headers.get("Result", "*")

                    board = game.board()

                    for move in game.mainline_moves():
                        board.push(move)

                        # --- FAST FILTERS ---
                        # Skip queen positions — heavy_piece_endgame removed for speed
                        if _has_any(board, chess.QUEEN): continue

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
                        eval_score, is_boring, best_moves = analyze_position(
                            board, engine, depth=args.depth
                        )

                        if is_boring or eval_score is None: continue

                        seen_canon.add(canon)

                        current_tags = get_tags_for_board(board)
                        has_imbalance = check_future_imbalance(board, best_moves)

                        future_tags = []
                        if best_moves:
                            moves_pushed = 0
                            for next_move in best_moves:
                                board.push(next_move)
                                moves_pushed += 1
                                future_tags += get_tags_for_board(board)
                            for _ in range(moves_pushed):
                                board.pop()

                        all_tags = sorted(set(current_tags + future_tags))
                        eval_tag = round(abs(eval_score), 1)
                        sid = fen_id(fen)

                        g_scenarios_found += 1
                        log_to_console(
                            f"✅ Found #{g_scenarios_found} ({sid}): {fen} | "
                            f"Eval: {eval_score:.2f} | Mat: {total_material}"
                        )

                        scenarios.append({
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
                            "source_file": os.path.basename(pgn_file),
                        })

                        # Periodic checkpoint
                        if len(scenarios) % CHECKPOINT_EVERY == 0:
                            write_output(scenarios, args.output)

                        break

            log_to_console(f"   ✓ Completed file: {os.path.basename(pgn_file)}")

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
