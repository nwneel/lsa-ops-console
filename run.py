"""Command-line access to the engine (the server does the same through its API).

    python3 run.py reset          # rebuild 240 synthetic accounts with 56 days of history
    python3 run.py run            # run the daily pipeline on current data
    python3 run.py advance 3      # simulate 3 more days, running the pipeline after each
"""
import pathlib
import sys

from lsa_ops.engine import Engine

ROOT = pathlib.Path(__file__).parent
(ROOT / "out").mkdir(exist_ok=True)
e = Engine(str(ROOT / "out/lsa_ops.db"))
cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
if cmd == "reset":
    e.reset("cli")
    print(f"Rebuilt. Simulated date {e.today()}")
elif cmd == "advance":
    print(e.advance(int(sys.argv[2]) if len(sys.argv) > 2 else 1, "cli"))
else:
    print(e.run_pipeline("cli", "cli"))
