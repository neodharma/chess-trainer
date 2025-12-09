import chess
import chess.pgn
import chess.engine
import json
import os
import glob
import time
import sys

# --- CONFIGURATION ---
ENGINE_PATH = r"C:\Users\benmc\Documents\stockfish\stockfish-windows-x86-64-avx2.exe"

# --- CRITERIA ---
MIN_TOTAL_POINTS = 10
MAX_TOTAL_POINTS = 20
MIN_SIDE_POINTS = 3
EVAL_WINDOW = 0.6

def get_material_score(board):
    values = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
    w_score = 0
    b_score = 0
    for piece_type, value in values.items():
        w_score += len(board.pieces(piece_type, chess.WHITE)) * value
        b_score += len(board.pieces(piece_type, chess.BLACK)) * value
    return w_score, b_score, w_score + b_score

# --- TAGGING LOGIC (STRICT) ---
def is_rook_endgame(board):
    # 1. Must have at least one Rook
    if not (board.pieces(chess.ROOK, chess.WHITE) or board.pieces(chess.ROOK, chess.BLACK)):
        return False
    # 2. Must NOT have Knights, Bishops, Queens
    for piece_type in [chess.KNIGHT, chess.BISHOP, chess.QUEEN]:
        if board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK):
            return False
    return True

def is_bishop_endgame(board):
    # 1. Must have at least one Bishop
    if not (board.pieces(chess.BISHOP, chess.WHITE) or board.pieces(chess.BISHOP, chess.BLACK)):
        return False
    # 2. Must NOT have Knights, Rooks, Queens
    for piece_type in [chess.KNIGHT, chess.ROOK, chess.QUEEN]:
        if board.pieces(piece_type, chess.WHITE) or board.pieces(piece_type, chess.BLACK):
            return False
    return True

def is_pawn_endgame(board):
    # Must NOT have any major/minor pieces
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
        
        if score_obj.is_mate(): return None, True, None
        
        score_cp = score_obj.score()
        eval_decimal = score_cp / 100.0
        if abs(eval_decimal) > EVAL_WINDOW: return None, True, None
        
        best_move = info.get("pv", [])[0] if "pv" in info and len(info["pv"]) > 0 else None
        
        return eval_decimal, False, best_move
    except Exception:
        return None, True, None

# --- UTILS ---
def format_time(seconds):
    if seconds < 60: return f"{int(seconds)}s"
    elif seconds < 3600: return f"{int(seconds // 60)}m {int(seconds % 60)}s"
    else: return f"{int(seconds // 3600)}h {int((seconds % 3600) // 60)}m"

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

def draw_progress_bar(processed, total, start_time, found_count):
    elapsed = time.time() - start_time
    rate = processed / elapsed if elapsed > 0 else 0
    remaining = total - processed
    eta = remaining / rate if rate > 0 else 0
    
    percent = (processed / total) * 100
    bar_length = 30
    filled_length = int(bar_length * processed // total)
    bar = "█" * filled_length + "-" * (bar_length - filled_length)
    
    status = f"\r[{bar}] {percent:.1f}% | {processed}/{total} | {rate:.0f} g/s | ETA: {format_time(eta)} | Found: {found_count}"
    sys.stdout.write(f"{status:<120}") 
    sys.stdout.flush()

def mine_games():
    scenarios = []
    
    if not os.path.exists(ENGINE_PATH):
        print(f"❌ ERROR: Engine not found at: {ENGINE_PATH}")
        return

    pgn_files = glob.glob("*.pgn")
    if not pgn_files:
        print("❌ ERROR: No PGN files found in the current directory")
        return
    
    total_games = count_total_games(pgn_files)
    if total_games == 0:
        print("❌ No games found in PGN files.")
        return

    print(f"🚀 Starting Miner...")
    start_time = time.time()
    games_processed = 0
    
    try:
        engine = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
        
        for pgn_file in pgn_files:
            with open(pgn_file) as pgn:
                while True:
                    game = chess.pgn.read_game(pgn)
                    if game is None: break
                    
                    games_processed += 1
                    
                    if games_processed % 50 == 0:
                        draw_progress_bar(games_processed, total_games, start_time, len(scenarios))

                    white_player = game.headers.get("White", "Unknown")
                    black_player = game.headers.get("Black", "Unknown")
                    date = game.headers.get("Date", "????")
                    year = date.split(".")[0] if "." in date else date 

                    board = game.board()
                    
                    for move in game.mainline_moves():
                        board.push(move)
                        
                        if board.pieces(chess.QUEEN, chess.WHITE) or board.pieces(chess.QUEEN, chess.BLACK): continue
                        w_score, b_score, total = get_material_score(board)
                        if not (MIN_TOTAL_POINTS <= total <= MAX_TOTAL_POINTS): continue
                        if w_score < MIN_SIDE_POINTS or b_score < MIN_SIDE_POINTS: continue
                        if (len(board.pieces(chess.PAWN, chess.WHITE)) + len(board.pieces(chess.PAWN, chess.BLACK))) < 2: continue

                        eval_score, is_boring, best_move = analyze_position(board, engine)

                        if not is_boring and eval_score is not None:
                            fen = board.fen()
                            if any(s['fen'] == fen for s in scenarios): continue

                            current_tags = get_tags_for_board(board)
                            future_tags = []
                            if best_move:
                                board.push(best_move) 
                                future_tags = get_tags_for_board(board)
                                board.pop() 
                            
                            all_tags = list(set(current_tags + future_tags))

                            sys.stdout.write("\r" + " " * 120 + "\r")
                            print(f"✅ Found #{len(scenarios)+1}: {fen} | Tags: {all_tags}")
                            draw_progress_bar(games_processed, total_games, start_time, len(scenarios)+1)
                            
                            scenarios.append({
                                "id": len(scenarios) + 1,
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
            
        engine.quit()
        sys.stdout.write("\n")
        with open("scenarios.json", "w") as f: json.dump(scenarios, f, indent=2)
        print(f"💾 Done! Saved {len(scenarios)} scenarios from {total_games} games.")

    except KeyboardInterrupt:
        sys.stdout.write("\n")
        print("🛑 Stopped by user. Saving current data...")
        with open("scenarios.json", "w") as f: json.dump(scenarios, f, indent=2)

if __name__ == "__main__":
    mine_games()