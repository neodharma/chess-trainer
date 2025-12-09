import chess
import chess.pgn
import chess.engine
import json
import os
import glob
import time
import sys

# --- CONFIGURATION ---
# Use your specific path
ENGINE_PATH = r"C:\Users\benmc\Documents\stockfish\stockfish-windows-x86-64-avx2.exe"

# --- CRITERIA ---
MIN_TOTAL_POINTS = 10
MAX_TOTAL_POINTS = 20
MIN_SIDE_POINTS = 3
EVAL_WINDOW = 0.6

# --- GLOBAL STATE FOR PROGRESS BAR ---
g_start_time = 0
g_total_games = 0
g_games_processed = 0
g_scenarios_found = 0
g_current_file = ""

def get_material_score(board):
    values = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
    w_score = 0
    b_score = 0
    for piece_type, value in values.items():
        w_score += len(board.pieces(piece_type, chess.WHITE)) * value
        b_score += len(board.pieces(piece_type, chess.BLACK)) * value
    return w_score, b_score, w_score + b_score

# --- TAGGING LOGIC ---
def is_rook_endgame(board):
    for piece_type in [chess.KNIGHT, chess.BISHOP, chess.QUEEN]:
        if board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK):
            return False
    return True

def is_bishop_endgame(board):
    for piece_type in [chess.KNIGHT, chess.ROOK, chess.QUEEN]:
        if board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK):
            return False
    return True

def is_pawn_endgame(board):
    for piece_type in [chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN]:
        if board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK):
            return False
    return True

def get_tags_for_board(board):
    tags = []
    if is_rook_endgame(board): tags.append("rook_endgame")
    if is_bishop_endgame(board): tags.append("bishop_endgame")
    if is_pawn_endgame(board): tags.append("pawn_endgame")
    return tags

# --- ENGINE ANALYSIS ---
def analyze_position(board, engine, depth=15):
    try:
        info = engine.analyse(board, chess.engine.Limit(depth=depth))
        score_obj = info["score"].relative
        if score_obj.is_mate(): return None, True, []
        
        score_cp = score_obj.score()
        eval_decimal = score_cp / 100.0
        if abs(eval_decimal) > EVAL_WINDOW: return None, True, []
        
        pv_line = info.get("pv", [])
        best_moves = pv_line[:2] if len(pv_line) >= 1 else []
        
        return eval_decimal, False, best_moves
    except Exception:
        return None, True, []

# --- CONSOLE UI HELPERS ---
def format_time(seconds):
    if seconds < 60: return f"{int(seconds)}s"
    elif seconds < 3600: return f"{int(seconds // 60)}m {int(seconds % 60)}s"
    else: return f"{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"

def draw_progress_bar():
    elapsed = time.time() - g_start_time
    rate = g_games_processed / elapsed if elapsed > 0 else 0
    remaining = g_total_games - g_games_processed
    eta = remaining / rate if rate > 0 else 0
    
    percent = (g_games_processed / g_total_games) * 100 if g_total_games > 0 else 0
    bar_length = 25
    filled_length = int(bar_length * g_games_processed // g_total_games) if g_total_games > 0 else 0
    bar = "█" * filled_length + "-" * (bar_length - filled_length)
    
    display_file = (g_current_file[:15] + '..') if len(g_current_file) > 15 else g_current_file
    
    # \r goes to start of line. We print the bar without a newline.
    status = f"\r[{bar}] {percent:.1f}% | {g_games_processed}/{g_total_games} | {rate:.0f} g/s | Found: {g_scenarios_found} | File: {display_file}"
    
    # Pad with spaces to clear any previous longer lines
    sys.stdout.write(f"{status:<120}") 
    sys.stdout.flush()

def log_to_console(message):
    """Clears the progress bar, prints a message, then redraws the bar."""
    # 1. Clear current line
    sys.stdout.write("\r" + " " * 120 + "\r")
    # 2. Print message
    print(message)
    # 3. Redraw bar immediately
    draw_progress_bar()

def count_total_games(pgn_files):
    print("🔍 Pre-scanning files to count total games (this is fast)...")
    total = 0
    for pgn_file in pgn_files:
        with open(pgn_file) as f:
            count = sum(1 for line in f if line.startswith("[Event "))
            total += count
            print(f"   - {pgn_file}: {count} games")
    print(f"✅ Total Games Detected: {total}\n")
    return total

def mine_games():
    global g_start_time, g_total_games, g_games_processed, g_scenarios_found, g_current_file
    scenarios = []
    
    if not os.path.exists(ENGINE_PATH):
        print(f"❌ ERROR: Engine not found at: {ENGINE_PATH}")
        return

    pgn_files = glob.glob("*.pgn")
    if not pgn_files:
        print("❌ ERROR: No PGN files found in the current directory")
        return
    
    g_total_games = count_total_games(pgn_files)
    if g_total_games == 0:
        print("❌ No games found in PGN files.")
        return

    print(f"🚀 Starting Miner...")
    g_start_time = time.time()
    
    try:
        engine = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
        
        for pgn_file in pgn_files:
            g_current_file = pgn_file
            
            with open(pgn_file) as pgn:
                while True:
                    game = chess.pgn.read_game(pgn)
                    if game is None: break
                    
                    g_games_processed += 1
                    
                    # Update progress bar periodically
                    if g_games_processed % 50 == 0:
                        draw_progress_bar()

                    white_player = game.headers.get("White", "Unknown")
                    black_player = game.headers.get("Black", "Unknown")
                    date = game.headers.get("Date", "????")
                    year = date.split(".")[0] if "." in date else date 

                    board = game.board()
                    
                    for move in game.mainline_moves():
                        board.push(move)
                        
                        # --- FAST FILTERS ---
                        if board.pieces(chess.QUEEN, chess.WHITE) or board.pieces(chess.QUEEN, chess.BLACK): continue
                        w_score, b_score, total = get_material_score(board)
                        if not (MIN_TOTAL_POINTS <= total <= MAX_TOTAL_POINTS): continue
                        if w_score < MIN_SIDE_POINTS or b_score < MIN_SIDE_POINTS: continue
                        if (len(board.pieces(chess.PAWN, chess.WHITE)) + len(board.pieces(chess.PAWN, chess.BLACK))) < 2: continue

                        # --- ENGINE FILTER ---
                        eval_score, is_boring, best_moves = analyze_position(board, engine)

                        if not is_boring and eval_score is not None:
                            fen = board.fen()
                            if any(s['fen'] == fen for s in scenarios): continue

                            current_tags = get_tags_for_board(board)
                            future_tags = []
                            if best_moves:
                                moves_pushed = 0
                                for next_move in best_moves:
                                    board.push(next_move)
                                    moves_pushed += 1
                                    future_tags += get_tags_for_board(board)
                                
                                for _ in range(moves_pushed):
                                    board.pop()
                            
                            all_tags = list(set(current_tags + future_tags))
                            
                            g_scenarios_found += 1 # Update counter before logging
                            log_to_console(f"✅ Found #{g_scenarios_found}: {fen} | Tags: {all_tags}")
                            
                            scenarios.append({
                                "id": g_scenarios_found,
                                "fen": fen,
                                "eval": eval_score,
                                "turn": "white" if board.turn == chess.WHITE else "black",
                                "description": f"Balanced Ending ({total} pts)",
                                "tags": all_tags,
                                "players": f"{white_player} vs {black_player}",
                                "year": year,
                                "source_file": pgn_file
                            })
                            break 
            
            # Use our helper for this too so it doesn't break the bar
            log_to_console(f"   ✓ Completed file: {pgn_file}")
        
        engine.quit()
        sys.stdout.write("\n") # Move to next line cleanly
        with open("scenarios.json", "w") as f: json.dump(scenarios, f, indent=2)
        print(f"💾 Done! Saved {len(scenarios)} scenarios from {g_total_games} games.")

    except KeyboardInterrupt:
        sys.stdout.write("\n")
        print("🛑 Stopped by user. Saving current data...")
        with open("scenarios.json", "w") as f: json.dump(scenarios, f, indent=2)

if __name__ == "__main__":
    mine_games()