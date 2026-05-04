#!/usr/bin/env python3
"""One-shot status of an in-flight miner run. Parses worker logs in
../public/.miner-tmp/. Run with `watch -n 2 ./status.py` for a live view."""
import glob
import os
import re
import sys

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "public", ".miner-tmp")

# Don't anchor on the bar's filler chars — the miner uses unicode block chars
# (UTF-8 multibyte) that mangle under any wrong-encoding read. Skip the bar
# contents entirely and pull just the structured fields after it.
PROGRESS_RE = re.compile(
    r"\[[^\]]*\]\s+([\d.]+)%\s+\|\s+(\d+)/(\d+)\s+\|\s+([\d.]+)\s+g/s\s+"
    r"\|\s+Found:\s+(\d+)\s+\|\s+File:\s+(\S+)"
)
DONE_RE = re.compile(r"Saved (\d+) scenarios")


def latest_progress(path):
    """Return (pct, done, total, rate, found, file, done_flag) or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    if not text:
        return None
    done_match = DONE_RE.search(text)
    # Progress bar lines are separated by \r; split both ways and find the last match.
    pieces = re.split(r"[\r\n]", text)
    for piece in reversed(pieces):
        m = PROGRESS_RE.search(piece)
        if m:
            return (float(m.group(1)), int(m.group(2)), int(m.group(3)),
                    float(m.group(4)), int(m.group(5)), m.group(6),
                    bool(done_match))
    if done_match:
        return (100.0, 0, 0, 0.0, int(done_match.group(1)), "-", True)
    return None


def fmt_eta(seconds):
    if seconds <= 0 or seconds != seconds:  # NaN guard
        return "—"
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.0f}m"
    h, m = divmod(int(seconds), 3600)
    return f"{h}h{m//60:02d}m"


def main():
    if not os.path.isdir(TMP):
        print(f"No active run — {TMP} doesn't exist.")
        sys.exit(0)

    logs = sorted(glob.glob(os.path.join(TMP, "worker-*.log")))
    if not logs:
        print(f"No worker logs in {TMP}.")
        sys.exit(0)

    header = f"{'worker':<8}{'pct':>7}{'games':>16}{'rate':>11}{'found':>9}{'eta':>8}  status / file"
    print(header)
    print("-" * len(header))
    total_found = 0
    total_done = 0
    total_games = 0
    max_eta = 0.0
    for log in logs:
        wid = re.search(r"worker-(\d+)", log).group(1)
        info = latest_progress(log)
        if info is None:
            print(f"{wid:<8}{'?':>7}{'?':>16}{'?':>11}{'?':>9}{'?':>8}  (no progress yet)")
            continue
        pct, done, total, rate, found, fname, finished = info
        total_found += found
        total_done += done
        total_games += total
        if finished:
            eta_s = 0.0
            eta_str = "done"
        else:
            remaining = max(0, total - done)
            eta_s = remaining / rate if rate > 0 else float("inf")
            eta_str = fmt_eta(eta_s)
        max_eta = max(max_eta, eta_s) if eta_s != float("inf") else max_eta
        marker = "✓ done" if finished else fname
        print(f"{wid:<8}{pct:>6.1f}%{done:>8}/{total:<7}{rate:>8.1f} g/s"
              f"{found:>9}{eta_str:>8}  {marker}")

    print("-" * len(header))
    overall_pct = (total_done / total_games * 100) if total_games else 0
    eta_total = fmt_eta(max_eta) if max_eta > 0 else "—"
    print(f"{'TOTAL':<8}{overall_pct:>6.1f}%{total_done:>8}/{total_games:<7}"
          f"{'':>11}{total_found:>9}{eta_total:>8}")


if __name__ == "__main__":
    main()
