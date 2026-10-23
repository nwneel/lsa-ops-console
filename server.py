"""LSA Ops console server.

    python3 server.py                  # http://0.0.0.0:3000
    python3 server.py --port 8080 --reset

Serves the console (web/) and a JSON API over one SQLite database. An autopilot thread can advance the simulated program one day at a time and run the pipeline after each day.
"""
import argparse
import gzip
import json
import pathlib
import re
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from lsa_ops.engine import Engine

ROOT = pathlib.Path(__file__).parent
WEB = ROOT / "web"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8")}


class Handler(BaseHTTPRequestHandler):
    engine: Engine = None
    server_version = "LSAOps/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json", cache="no-store"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str).encode()
        if "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 2048:
            body = gzip.compress(body, 5)
            self.send_response(code)
            self.send_header("Content-Encoding", "gzip")
        else:
            self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in STATIC:
            name, ctype = STATIC[path]
            body = (WEB / name).read_bytes()
            if name == "index.html":
                body = (b'<!doctype html><html lang="en"><head><meta charset="utf-8">'
                        b'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
                        b'</head><body>' + body + b'</body></html>')
            return self._send(200, body, ctype)
        if path == "/api/state":
            return self._send(200, self.engine.state())
        if path == "/api/health":
            return self._send(200, {"ok": True, "version": self.engine.version})
        self._send(404, {"error": "Not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "Body must be JSON"})
        e = self.engine
        try:
            with e.lock:
                result = self.route(e, path, body)
                if result is None:
                    return self._send(404, {"error": "Not found"})
                if not path.startswith("/api/preview") and path != "/api/ai-review":
                    e.touch()
            self._send(200, result)
        except (ValueError, KeyError) as err:
            e.con.rollback()
            self._send(400, {"error": str(err).strip("'")})
        except Exception as err:  # keep the server up; report the failure
            e.con.rollback()
            traceback.print_exc()
            self._send(500, {"error": f"{type(err).__name__}: {err}"})

    def route(self, e, path, b):
        if path == "/api/run":
            return e.run_pipeline("manual", "operator")
        if path == "/api/advance":
            return e.advance(b.get("days", 1), "operator")
        if path == "/api/reset":
            e.reset("operator")
            return {"ok": True}
        if path == "/api/settings":
            e.update_settings(b)
            return {"ok": True}
        if path == "/api/change":
            return e.propose(b["account_id"], b["field"], float(b["value"]), b.get("reason") or "Manual change",
                             b.get("source", "manual"), "operator")
        if path == "/api/preview/change":
            from lsa_ops import guardrails
            a = e.account(b["account_id"])
            return guardrails.evaluate(b["field"], a[b["field"]], float(b["value"]), e.changes_today(a["account_id"]), e.guard())
        if path in ("/api/bulk", "/api/preview/bulk"):
            return e.bulk(b["field"], b["value"], b.get("cond", "all"), b.get("metro") or "", path == "/api/bulk")
        m = re.fullmatch(r"/api/proposals/(\d+)/(approve|reject)", path)
        if m:
            e.decide(int(m.group(1)), m.group(2) == "approve")
            return {"ok": True}
        if path == "/api/proposals/approve-all":
            ids = [r[0] for r in e.con.execute("SELECT id FROM proposals WHERE decision='needs_approval'")]
            for pid in ids:
                e.decide(pid, True)
            return {"approved": len(ids)}
        if path == "/api/flags/ack":
            e.ack(b["key"], bool(b.get("on", True)))
            return {"ok": True}
        if path == "/api/tasks":
            return {"created": e.create_tasks(b["account_id"])}
        m = re.fullmatch(r"/api/tasks/(\d+)/done", path)
        if m:
            e.complete_task(int(m.group(1)))
            return {"ok": True}
        if path == "/api/accounts/status":
            e.set_status(b["account_id"], b["status"])
            return {"ok": True}
        if path == "/api/accounts/renew-license":
            e.renew_license(b["account_id"])
            return {"ok": True}
        if path == "/api/leads/dispute":
            return {"submitted": e.dispute(b.get("ids", []))}
        if path == "/api/leads/feedback":
            return {"rated": e.feedback(b.get("account_id"))}
        if path == "/api/ai-review":
            from lsa_ops import recommend
            if not recommend.claude_available():
                raise ValueError("Claude is not configured on this server (set ANTHROPIC_API_KEY)")
            return e.ai_review(b["account_id"])
        return None


def autopilot(engine):
    while True:
        time.sleep(1)
        try:
            with engine.lock:
                secs = engine.setting("autopilot_secs", 0) or 0
                last = engine.setting("autopilot_last", 0) or 0
                if secs and time.time() - last >= secs:
                    engine.set_setting("autopilot_last", time.time())
                    engine.advance(1, "autopilot")
        except Exception:
            traceback.print_exc()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=3000)
    p.add_argument("--db", default=str(ROOT / "out/lsa_ops.db"))
    p.add_argument("--reset", action="store_true")
    args = p.parse_args()
    (ROOT / "out").mkdir(exist_ok=True)
    engine = Engine(args.db)
    if args.reset:
        engine.reset("system")
    Handler.engine = engine
    threading.Thread(target=autopilot, args=(engine,), daemon=True).start()
    print(f"LSA Ops console on http://{args.host}:{args.port}  (simulated day {engine.today()})")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
