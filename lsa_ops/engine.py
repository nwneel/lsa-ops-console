"""The ops engine: pipeline runs, guardrailed changes, approvals, disputes, tasks and the activity log.

One SQLite database holds the program (accounts, daily metrics, leads) and the ops state (settings, flags, proposals, tasks, runs, log). Every number the console shows is computed from that database on request.
"""
import json
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone

from . import checks, guardrails, recommend, sim

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, account_id TEXT, severity TEXT, check_name TEXT,
  detail TEXT, action TEXT, first_seen TEXT);
CREATE TABLE IF NOT EXISTS acks (key TEXT PRIMARY KEY, ts TEXT);
CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, sim_day TEXT, account_id TEXT,
  field TEXT, old REAL, new REAL, pct REAL, reason TEXT, source TEXT, decision TEXT, applied INTEGER DEFAULT 0,
  decided_ts TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, sim_day TEXT, kind TEXT, actor TEXT,
  msg TEXT, sub TEXT);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, sim_day TEXT, account_id TEXT,
  cause TEXT, fix TEXT, detail TEXT, status TEXT, done_ts TEXT);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, sim_day TEXT, trigger TEXT,
  summary TEXT, duration_ms INTEGER);
"""
OPS_TABLES = ["settings", "flags", "acks", "proposals", "log", "tasks", "runs"]
HISTORY_DAYS = 56
LEAD_DAYS = 28
EDITABLE = {"weekly_budget", "max_per_lead", "service_zips", "hours_per_week"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def money(x):
    return f"${x:,.0f}"


def fmt_field(field, v):
    if v is None:
        return "–"
    return money(v) if field in ("weekly_budget", "max_per_lead") else f"{int(v)} ZIPs" if field == "service_zips" else f"{int(v)} h/wk"


class Engine:
    def __init__(self, db_path):
        self.con = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.RLock()
        self.version = 0
        self._cache = (None, None)
        self.con.executescript(OPS_SCHEMA)
        if not self.con.execute("SELECT name FROM sqlite_master WHERE name='accounts'").fetchone():
            self.reset()

    # ---------- basics ----------
    def setting(self, key, default=None):
        r = self.con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_setting(self, key, value):
        self.con.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value)))

    def today(self):
        return date.fromisoformat(self.setting("sim_today"))

    def guard(self):
        return {**guardrails.DEFAULTS, **self.setting("guard", {})}

    def log(self, kind, actor, msg, sub=""):
        self.con.execute("INSERT INTO log (ts, sim_day, kind, actor, msg, sub) VALUES (?,?,?,?,?,?)",
                         (now(), self.today().isoformat(), kind, actor, msg, sub))

    def touch(self):
        self.con.commit()
        self.version += 1

    def account(self, aid):
        cols = [c[1] for c in self.con.execute("PRAGMA table_info(accounts)")]
        r = self.con.execute("SELECT * FROM accounts WHERE account_id=?", (aid,)).fetchone()
        if not r:
            raise KeyError(f"No account {aid}")
        return dict(zip(cols, r))

    def metrics(self):
        today = self.today()
        cur, prev = checks.window(self.con, today), checks.window(self.con, today, offset=checks.WINDOW)
        pb = {p["account_id"]: p for p in prev}
        for a in cur:
            p = pb[a["account_id"]]
            a.update(prev_leads=p["leads"], prev_cost=p["cost"], prev_charged=p["charged"])
        return cur, prev

    # ---------- setup ----------
    def reset(self, actor="operator"):
        with self.lock:
            for t in OPS_TABLES:
                self.con.execute(f"DROP TABLE IF EXISTS {t}")
            self.con.executescript(OPS_SCHEMA)
            start = date.today()
            sim.build(self.con, days=HISTORY_DAYS, lead_days=LEAD_DAYS, today=start)
            self.set_setting("sim_today", start.isoformat())
            self.set_setting("guard", guardrails.DEFAULTS)
            self.set_setting("write_mode", "apply")
            self.set_setting("autopilot_secs", 0)
            n = self.con.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
            self.log("system", actor, f"Demo environment created: {n} synthetic accounts, {HISTORY_DAYS} days of history",
                     f"Data through {(start - timedelta(days=1)).isoformat()}")
            self.run_pipeline("initial", actor)

    # ---------- changes ----------
    def changes_today(self, aid):
        return self.con.execute("""SELECT COUNT(*) FROM proposals WHERE account_id=? AND sim_day=?
            AND decision IN ('applied','dry_run','approved')""", (aid, self.today().isoformat())).fetchone()[0]

    def _apply(self, aid, field, value):
        assert field in EDITABLE
        self.con.execute(f"UPDATE accounts SET {field}=? WHERE account_id=?", (value, aid))

    def propose(self, aid, field, proposed, reason, source, actor):
        """Runs one change through the guardrails and acts on the decision."""
        a = self.account(aid)
        if field not in EDITABLE:
            raise ValueError(f"{field} cannot be changed")
        old = a[field]
        if old is None:
            return {"decision": "noop", "reason": "Not applicable to this account"}
        r = guardrails.evaluate(field, old, proposed, self.changes_today(aid), self.guard())
        if r["decision"] == "noop":
            return r
        label = guardrails.FIELDS[field].lower()
        what = f"{a['name']}: {label} {fmt_field(field, old)} → {fmt_field(field, r['new'])}"
        if r["decision"] == "needs_approval":
            pending = self.con.execute("SELECT id FROM proposals WHERE account_id=? AND field=? AND decision='needs_approval'",
                                       (aid, field)).fetchone()
            if pending:
                return {**r, "decision": "already_pending", "id": pending[0]}
            decision, applied = "needs_approval", 0
            self.log("change", actor, f"{what} queued for approval ({r['pct']:+.0f}%)", f"{source} · {reason}")
        elif r["decision"] == "blocked":
            decision, applied = "blocked", 0
            self.log("change", actor, f"{what} blocked by the daily change limit", f"{source} · {reason}")
        elif self.setting("write_mode") == "apply":
            decision, applied = "applied", 1
            self._apply(aid, field, r["new"])
            self.log("change", actor, f"{what} applied ({r['pct']:+.0f}%)", f"{source} · {reason}")
        else:
            decision, applied = "dry_run", 0
            self.log("change", actor, f"{what} dry run ({r['pct']:+.0f}%)", f"{source} · {reason}")
        cur = self.con.execute("""INSERT INTO proposals (ts, sim_day, account_id, field, old, new, pct, reason, source,
            decision, applied, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                               (now(), self.today().isoformat(), aid, field, old, r["new"], r["pct"], reason, source,
                                decision, applied, r["note"]))
        return {**r, "decision": decision, "id": cur.lastrowid}

    def decide(self, pid, approve, actor="operator"):
        p = self.con.execute("SELECT account_id, field, old, new, decision FROM proposals WHERE id=?", (pid,)).fetchone()
        if not p or p[4] != "needs_approval":
            raise ValueError("This change is no longer waiting for approval")
        aid, field, old, new, _ = p
        a = self.account(aid)
        what = f"{a['name']}: {guardrails.FIELDS[field].lower()} {fmt_field(field, old)} → {fmt_field(field, new)}"
        if approve:
            applied = int(self.setting("write_mode") == "apply")
            if applied:
                self._apply(aid, field, new)
            self.con.execute("UPDATE proposals SET decision='approved', applied=?, decided_ts=? WHERE id=?", (applied, now(), pid))
            self.log("approval", actor, f"Approved {what}", "Applied" if applied else "Dry run: logged, not written")
        else:
            self.con.execute("UPDATE proposals SET decision='rejected', decided_ts=? WHERE id=?", (now(), pid))
            self.log("approval", actor, f"Rejected {what}")

    # ---------- pipeline ----------
    def run_pipeline(self, trigger, actor):
        with self.lock:
            t0 = time.time()
            today = self.today()
            accts, prev = self.metrics()
            metro = checks.metro_medians(accts)
            flags = checks.health_flags(accts, prev, metro, today)
            dark = checks.showing_no_leads(accts)
            leads_n = self.con.execute("SELECT COUNT(*) FROM leads WHERE day>=?",
                                       ((today - timedelta(days=LEAD_DAYS)).isoformat(),)).fetchone()[0]
            self.log("pipeline", actor, f"Pulled account reports for {len(accts)} accounts",
                     "Local Services API · accountReports:search")
            self.log("pipeline", actor, f"Pulled {leads_n:,} leads from the last {LEAD_DAYS} days",
                     "Google Ads API · local_services_lead")
            first_seen = dict(self.con.execute("SELECT key, first_seen FROM flags").fetchall())
            self.con.execute("DELETE FROM flags")
            for f in flags:
                self.con.execute("INSERT INTO flags VALUES (?,?,?,?,?,?,?)",
                                 (f["key"], f["account_id"], f["severity"], f["check"], f["detail"], f["action"],
                                  first_seen.get(f["key"], today.isoformat())))
            new_flags = [f for f in flags if f["key"] not in first_seen]
            cleared = len(set(first_seen) - {f["key"] for f in flags})
            crit = sum(f["severity"] == "critical" for f in flags)
            self.log("pipeline", actor, f"Health checks: {len(flags)} flags ({crit} critical), {len(new_flags)} new, {cleared} cleared",
                     "Spend pace, CPL vs metro, verification, suspensions, lead drops, missed calls, lead quality")
            self.log("pipeline", actor, f"{len(dark)} accounts showing without leads", "Cause ladder attached to each")
            out = {"applied": 0, "dry_run": 0, "needs_approval": 0, "blocked": 0}
            cool = (today - timedelta(days=int(self.guard()["cooldown_days"]))).isoformat()
            recent = {r[0] for r in self.con.execute("""SELECT DISTINCT account_id FROM proposals WHERE field='weekly_budget'
                AND (decision='needs_approval' OR (decision IN ('applied','approved','dry_run','rejected') AND sim_day>?))""", (cool,))}
            out["cooldown"] = 0
            for a in accts:
                r = recommend.rule_based(a, metro.get(a["metro"]))
                if r and a["account_id"] in recent:
                    out["cooldown"] += 1
                elif r:
                    res = self.propose(a["account_id"], "weekly_budget", r[0], r[1], "rules", actor)
                    if res["decision"] in out:
                        out[res["decision"]] += 1
            mode = self.setting("write_mode")
            self.log("pipeline", actor, f"Budget proposals: {out['applied'] + out['dry_run']} within cap "
                     f"({'applied' if mode == 'apply' else 'dry run'}), {out['needs_approval']} sent for approval, {out['blocked']} blocked, {out['cooldown']} in cooldown",
                     f"Guardrails ±{self.guard()['max_pct']:g}% · {self.guard()['cooldown_days']:g}-day cooldown per account · write mode: {mode.replace('_', ' ')}")
            summary = {"accounts": len(accts), "flags": len(flags), "critical": crit, "new_flags": len(new_flags),
                       "cleared": cleared, "dark": len(dark), **out}
            ms = int((time.time() - t0) * 1000)
            self.con.execute("INSERT INTO runs (ts, sim_day, trigger, summary, duration_ms) VALUES (?,?,?,?,?)",
                             (now(), today.isoformat(), trigger, json.dumps(summary), ms))
            self.set_setting("last_run", now())
            self.touch()
            return summary

    def advance(self, days=1, actor="operator"):
        with self.lock:
            out = None
            for _ in range(max(1, min(14, int(days)))):
                day = self.today()
                res = sim.advance(self.con, day)
                spend, leads = self.con.execute("SELECT COALESCE(SUM(cost),0), COALESCE(SUM(leads),0) FROM daily WHERE day=?",
                                                (day.isoformat(),)).fetchone()
                self.set_setting("sim_today", (day + timedelta(days=1)).isoformat())
                extra = []
                if res["credited"] or res["rejected"]:
                    extra.append(f"Google resolved disputes: {res['credited']} credited, {res['rejected']} rejected")
                if res["licenses_expired"]:
                    extra.append(f"{res['licenses_expired']} licenses lapsed")
                self.log("day", actor, f"New day of data: {day.strftime('%a %b %-d')} · {money(spend)} spend · {leads:,} leads",
                         " · ".join(extra) or "Simulated from each account's current settings")
                out = self.run_pipeline("new day", actor)
            return out

    # ---------- operator actions ----------
    def ack(self, key, on, actor="operator"):
        f = self.con.execute("SELECT account_id, check_name, detail FROM flags WHERE key=?", (key,)).fetchone()
        if not f:
            raise ValueError("That flag is no longer open")
        name = self.account(f[0])["name"]
        if on:
            self.con.execute("INSERT OR REPLACE INTO acks VALUES (?,?)", (key, now()))
            self.log("flag", actor, f"Acknowledged {f[1]} on {name}", f[2])
        else:
            self.con.execute("DELETE FROM acks WHERE key=?", (key,))
            self.log("flag", actor, f"Reopened {f[1]} on {name}", f[2])

    def create_tasks(self, aid, actor="operator"):
        a = next(x for x in self.metrics()[0] if x["account_id"] == aid)
        made = 0
        for r in checks.ladder(a):
            if r["failing"] and not self.con.execute("SELECT 1 FROM tasks WHERE account_id=? AND cause=? AND status='open'",
                                                      (aid, r["cause"])).fetchone():
                self.con.execute("INSERT INTO tasks (ts, sim_day, account_id, cause, fix, detail, status) VALUES (?,?,?,?,?,?,?)",
                                 (now(), self.today().isoformat(), aid, r["cause"], r["fix"], r["detail"], "open"))
                self.log("task", actor, f"Task for {a['name']}: {r['fix']}", f"{r['cause']} · {r['detail']}")
                made += 1
        return made

    def complete_task(self, tid, actor="operator"):
        t = self.con.execute("SELECT account_id, cause, fix, status FROM tasks WHERE id=?", (tid,)).fetchone()
        if not t or t[3] != "open":
            raise ValueError("Task is not open")
        aid, cause, fix, _ = t
        a = self.account(aid)
        effect = "Marked done"
        if cause == "Verification":
            self.con.execute("UPDATE accounts SET license='VERIFIED', background='CLEARED', license_expires=? WHERE account_id=?",
                             ((self.today() + timedelta(days=730)).isoformat(), aid))
            effect = "License and background check verified"
        elif cause == "Service area":
            self._apply(aid, "service_zips", max(a["service_zips"], 12))
            effect = f"Service area {a['service_zips']} → {max(a['service_zips'], 12)} ZIPs"
        elif cause == "Schedule":
            self._apply(aid, "hours_per_week", max(a["hours_per_week"], 72))
            effect = f"Hours {a['hours_per_week']} → {max(a['hours_per_week'], 72)} a week"
        elif cause == "Responsiveness":
            self.con.execute("UPDATE accounts SET response_rate=? WHERE account_id=?", (max(a["response_rate"], 0.88), aid))
            effect = f"Call answer rate {a['response_rate'] * 100:.0f}% → {max(a['response_rate'], 0.88) * 100:.0f}%"
        elif cause == "Reviews":
            n = a["reviews"] + 8
            rating = round(min(5.0, (a["rating"] * a["reviews"] + 4.9 * 8) / n), 1)
            self.con.execute("UPDATE accounts SET reviews=?, rating=? WHERE account_id=?", (n, rating, aid))
            effect = f"8 new reviews: {a['rating']:.1f}★ ({a['reviews']}) → {rating:.1f}★ ({n})"
        elif cause == "Lead ratings":
            effect = f"Rated {self.feedback(aid, actor)} leads"
        elif cause == "Budget":
            r = self.propose(aid, "weekly_budget", a["weekly_budget"] * 1.2, "Fix task: budget runs out before afternoon peaks",
                             "task", actor)
            effect = {"applied": f"Budget {money(a['weekly_budget'])} → {money(r.get('new', 0))} applied",
                      "dry_run": f"Budget {money(a['weekly_budget'])} → {money(r.get('new', 0))} (dry run)",
                      "needs_approval": "Budget increase sent for approval",
                      "already_pending": "A budget change is already waiting for approval"}.get(r["decision"], "Budget unchanged: daily change limit reached")
        self.con.execute("UPDATE tasks SET status='done', done_ts=? WHERE id=?", (now(), tid))
        self.log("task", actor, f"Done for {a['name']}: {fix}", effect)

    def set_status(self, aid, status, actor="operator"):
        a = self.account(aid)
        if status not in ("ACTIVE", "PAUSED") or a["status"] == "SUSPENDED":
            raise ValueError("Suspended accounts need an appeal through LSA support")
        self.con.execute("UPDATE accounts SET status=? WHERE account_id=?", (status, aid))
        self.log("account", actor, f"{'Resumed' if status == 'ACTIVE' else 'Paused'} ads for {a['name']}")

    def renew_license(self, aid, actor="operator"):
        a = self.account(aid)
        exp = (self.today() + timedelta(days=730)).isoformat()
        self.con.execute("UPDATE accounts SET license='VERIFIED', license_expires=? WHERE account_id=?", (exp, aid))
        self.log("account", actor, f"Renewed license uploaded for {a['name']}", f"Expires {exp}")

    def dispute(self, ids, actor="operator"):
        n, total, reasons = 0, 0.0, set()
        for lid in ids:
            r = self.con.execute("""SELECT cost, dispute_reason FROM leads WHERE lead_id=? AND charged=1
                AND dispute_reason IS NOT NULL AND dispute_status IS NULL""", (lid,)).fetchone()
            if r:
                self.con.execute("UPDATE leads SET dispute_status='submitted', dispute_day=? WHERE lead_id=?",
                                 (self.today().isoformat(), lid))
                n, total = n + 1, total + r[0]
                reasons.add(r[1])
        if n:
            self.log("dispute", actor, f"Submitted {n} lead disputes · {money(total)} in charges",
                     "Reasons: " + ", ".join(sorted(reasons)) + " · Google decides within a day")
        return n

    def suggestions(self, aid=None):
        start = (self.today() - timedelta(days=checks.WINDOW)).isoformat()
        q = """SELECT lead_id, account_id, day, lead_type, status, call_seconds, dispute_reason FROM leads
               WHERE rating IS NULL AND day>=? AND day<?""" + (" AND account_id=?" if aid else "")
        args = [start, (self.today() - timedelta(days=1)).isoformat()] + ([aid] if aid else [])
        out = []
        for lid, acc, day, ltype, status, secs, dispute in self.con.execute(q, args):
            if dispute:
                out.append((lid, 1, dispute))
            elif ltype == "Phone call" and secs is not None and secs < 30:
                out.append((lid, 1, f"{secs}s call"))
            elif status == "Booked":
                out.append((lid, 5, "Booked appointment"))
        return out

    def feedback(self, aid=None, actor="operator"):
        sugg = self.suggestions(aid)
        by = {}
        for lid, rating, _ in sugg:
            self.con.execute("UPDATE leads SET rating=?, rating_source='ops' WHERE lead_id=?", (rating, lid))
            by[rating] = by.get(rating, 0) + 1
        if sugg:
            self.log("feedback", actor, f"Rated {len(sugg)} leads", ", ".join(f"{n} × {r}★" for r, n in sorted(by.items(), reverse=True))
                     + " · LocalServicesLeadService.ProvideLeadFeedback")
        return len(sugg)

    BULK_CONDS = {
        "early": ("Budget runs out early", lambda a, m: a["early_out"] >= 7),
        "cheap": ("CPL under metro median", lambda a, m: a["cpl"] and m and a["cpl"] < m),
        "high": ("CPL over 1.5x metro median", lambda a, m: a["cpl"] and m and a["cpl"] > 1.5 * m),
        "poor": ("Poor lead ratings", lambda a, m: a["rated"] >= 5 and a["poor"] / a["rated"] > 0.35),
        "narrow": ("Service area under 8 ZIPs", lambda a, m: a["service_zips"] < 8),
        "short": ("Open under 50 hours a week", lambda a, m: a["hours_per_week"] < 50),
        "all": ("All active accounts", lambda a, m: True),
    }

    def bulk(self, field, value, cond, metro_name, run, actor="operator"):
        accts, _ = self.metrics()
        metro = checks.metro_medians(accts)
        label, test = self.BULK_CONDS[cond]
        seg = [a for a in accts if a["status"] == "ACTIVE" and (not metro_name or a["metro"] == metro_name)
               and test(a, metro.get(a["metro"])) and a[field] is not None]
        value = float(value)

        def target(a):
            return {"weekly_budget": a[field] * (1 + value / 100), "max_per_lead": a[field] * (1 + value / 100),
                    "service_zips": a[field] + value, "hours_per_week": max(a[field], value)}[field]
        g = self.guard()
        rows = []
        for a in seg:
            r = guardrails.evaluate(field, a[field], target(a), self.changes_today(a["account_id"]), g)
            rows.append({"account_id": a["account_id"], "name": a["name"], "metro": a["metro"], "cpl": a["cpl"],
                         "leads": a["leads"], "old": a[field], **r})
        if not run:
            return {"label": label, "rows": rows}
        desc = {"weekly_budget": f"{value:+.0f}%", "max_per_lead": f"{value:+.0f}%", "service_zips": f"+{value:.0f} ZIPs",
                "hours_per_week": f"to {value:.0f} h/wk"}[field]
        reason = f"Bulk: {guardrails.FIELDS[field].lower()} {desc} where {label.lower()}" + (f" in {metro_name}" if metro_name else "")
        counts = {}
        for row in rows:
            if row["decision"] != "noop":
                d = self.propose(row["account_id"], field, target(next(a for a in seg if a["account_id"] == row["account_id"])),
                                 reason, "bulk", actor)["decision"]
                counts[d] = counts.get(d, 0) + 1
        self.log("change", actor, f"Bulk change on {len(rows)} accounts: {guardrails.FIELDS[field].lower()} {desc}",
                 ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in counts.items()) or "Nothing to change")
        return {"label": label, "counts": counts}

    def update_settings(self, body, actor="operator"):
        if "guard" in body:
            g = {**self.guard(), **{k: float(v) for k, v in body["guard"].items() if k in guardrails.DEFAULTS}}
            g["per_day"] = int(max(1, g["per_day"]))
            before = self.guard()
            self.set_setting("guard", g)
            changed = ", ".join(f"{k} {before[k]:g} → {g[k]:g}" for k in g if before.get(k) != g[k])
            if changed:
                self.log("settings", actor, "Guardrails updated", changed)
        if "write_mode" in body and body["write_mode"] in ("apply", "dry_run"):
            if body["write_mode"] != self.setting("write_mode"):
                self.set_setting("write_mode", body["write_mode"])
                self.log("settings", actor, f"Write mode set to {body['write_mode'].replace('_', ' ')}",
                         "Within-cap changes are applied" if body["write_mode"] == "apply" else "Within-cap changes are logged, not written")
        if "autopilot_secs" in body:
            secs = int(body["autopilot_secs"])
            if secs != self.setting("autopilot_secs"):
                self.set_setting("autopilot_secs", secs)
                self.set_setting("autopilot_last", time.time())
                self.log("settings", actor, f"Autopilot {'every ' + str(secs) + 's' if secs else 'off'}",
                         "Each tick simulates the next day and runs the pipeline" if secs else "")

    # ---------- read model ----------
    def state(self):
        with self.lock:
            if self._cache[0] == self.version:
                return self._cache[1]
            today = self.today()
            accts, _ = self.metrics()
            metro = checks.metro_medians(accts)
            start = today - timedelta(days=HISTORY_DAYS)
            idx = {a["account_id"]: i for i, a in enumerate(accts)}
            daily = [[None] * HISTORY_DAYS for _ in accts]
            for aid, day, imp, leads, ch, cost, out, missed in self.con.execute(
                    "SELECT * FROM daily WHERE day>=? AND day<?", (start.isoformat(), today.isoformat())):
                daily[idx[aid]][(date.fromisoformat(day) - start).days] = [imp, leads, ch, round(cost, 2), out, missed]
            lead_start = today - timedelta(days=LEAD_DAYS)
            leads = [[lid, idx[aid], (date.fromisoformat(day) - start).days, hour, lt, cat, ch, round(cost, 2), st, rating,
                      rsrc, secs, dr, ds]
                     for lid, aid, day, hour, lt, cat, ch, cost, st, rating, rsrc, secs, dr, ds, _ in self.con.execute(
                         "SELECT * FROM leads WHERE day>=? ORDER BY day DESC, hour DESC, lead_id DESC", (lead_start.isoformat(),))]
            acks = dict(self.con.execute("SELECT key, ts FROM acks").fetchall())
            flags = [{"key": k, "account_id": a, "severity": s, "check": c, "detail": d, "action": act, "first_seen": fs,
                      "acked": k in acks}
                     for k, a, s, c, d, act, fs in self.con.execute("SELECT * FROM flags")]
            pcols = ["id", "ts", "sim_day", "account_id", "field", "old", "new", "pct", "reason", "source", "decision",
                     "applied", "decided_ts", "note"]
            proposals = [dict(zip(pcols, r)) for r in self.con.execute(
                "SELECT * FROM proposals WHERE decision='needs_approval' OR id > (SELECT COALESCE(MAX(id),0)-400 FROM proposals) ORDER BY id DESC")]
            log = [dict(zip(["id", "ts", "sim_day", "kind", "actor", "msg", "sub"], r))
                   for r in self.con.execute("SELECT * FROM log ORDER BY id DESC LIMIT 600")]
            tasks = [dict(zip(["id", "ts", "sim_day", "account_id", "cause", "fix", "detail", "status", "done_ts"], r))
                     for r in self.con.execute("SELECT * FROM tasks WHERE status='open' OR id > (SELECT COALESCE(MAX(id),0)-200 FROM tasks) ORDER BY id DESC")]
            runs = [{**dict(zip(["id", "ts", "sim_day", "trigger"], r[:4])), "summary": json.loads(r[4]), "duration_ms": r[5]}
                    for r in self.con.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 30")]
            for a in accts:
                a["ladder"] = checks.ladder(a)
                r = recommend.rule_based(a, metro.get(a["metro"]))
                a["rec"] = {"new": round(r[0]), "reason": r[1]} if r else None
                a["changes_today"] = self.changes_today(a["account_id"])
            sugg = self.suggestions()
            s = {
                "meta": {"today": today.isoformat(), "start": start.isoformat(), "days": HISTORY_DAYS, "window": checks.WINDOW,
                         "lead_days": LEAD_DAYS, "last_run": self.setting("last_run"), "version": self.version,
                         "write_mode": self.setting("write_mode"), "autopilot_secs": self.setting("autopilot_secs"),
                         "guard": self.guard(), "claude": recommend.claude_available(), "server_time": now(),
                         "fields": guardrails.FIELDS, "bulk_conds": {k: v[0] for k, v in self.BULK_CONDS.items()}},
                "accounts": accts, "daily": daily, "leads": leads, "metro_cpl": metro, "flags": flags,
                "dark": checks.showing_no_leads(accts), "new_agents": checks.new_agents(accts, today),
                "proposals": proposals, "log": log, "tasks": tasks, "runs": runs,
                "suggestions": [[lid, r, why] for lid, r, why in sugg],
            }
            body = json.dumps(s, separators=(",", ":"), default=str).encode()
            self._cache = (self.version, body)
            return body

    def ai_review(self, aid, actor="operator"):
        accts, _ = self.metrics()
        a = next(x for x in accts if x["account_id"] == aid)
        metro = checks.metro_medians(accts).get(a["metro"])
        flags = [f"{c}: {d}" for c, d in self.con.execute("SELECT check_name, detail FROM flags WHERE account_id=?", (aid,))]
        failing = [r["cause"] for r in checks.ladder(a) if r["failing"]]
        out = recommend.claude_review(a, metro, flags, failing, self.guard())
        self.log("ai", actor, f"Claude reviewed {a['name']}: {str(out.get('action', '')).replace('_', ' ')} → "
                 f"{money(float(out.get('new_weekly_budget') or a['weekly_budget']))}", out.get("summary", ""))
        self.touch()
        return out
