"""Daily health checks, the 'showing but not getting leads' detector, and new-agent tracking.

Works only from what the APIs return (account fields, daily metrics, leads). It never reads `account_traits`, so every flag here is detected from the numbers.
"""
import statistics
from collections import defaultdict
from datetime import date, timedelta

ACCOUNT_COLS = ["account_id", "name", "business", "metro", "state", "weekly_budget", "bid_mode", "max_per_lead",
                "license", "license_expires", "background", "status", "rating", "reviews", "service_zips",
                "hours_per_week", "response_rate", "created", "first_lead"]
WINDOW = 14


def window(con, today, days=WINDOW, offset=0):
    """Per-account totals for the `days` days ending the day before `today - offset`."""
    end = (today - timedelta(days=offset)).isoformat()
    start = (today - timedelta(days=offset + days)).isoformat()
    rows = con.execute(f"""
        SELECT {", ".join("a." + c for c in ACCOUNT_COLS)},
               COALESCE(SUM(d.impressions),0), COALESCE(SUM(d.leads),0), COALESCE(SUM(d.charged_leads),0),
               COALESCE(SUM(d.cost),0), COALESCE(SUM(d.missed_calls),0),
               COALESCE(SUM(CASE WHEN d.budget_out_hour IS NOT NULL AND d.budget_out_hour < 14 THEN 1 END),0),
               COUNT(d.day)
        FROM accounts a LEFT JOIN daily d ON d.account_id = a.account_id AND d.day >= ? AND d.day < ?
        GROUP BY a.account_id ORDER BY a.account_id""", (start, end)).fetchall()
    cols = ACCOUNT_COLS + ["imp", "leads", "charged", "cost", "missed", "early_out", "days"]
    out = [dict(zip(cols, r)) for r in rows]
    quality = {r[0]: r[1:] for r in con.execute("""
        SELECT account_id, COUNT(*), SUM(rating IS NOT NULL), SUM(rating <= 2),
               SUM(dispute_reason IS NOT NULL AND charged = 1 AND dispute_status IS NULL)
        FROM leads WHERE day >= ? AND day < ? GROUP BY account_id""", (start, end))}
    for a in out:
        n, rated, poor, disputable = quality.get(a["account_id"], (0, 0, 0, 0))
        a.update(lead_rows=n, rated=rated or 0, poor=poor or 0, disputable=disputable or 0)
        a["cost"] = round(a["cost"], 2)
        a["cpl"] = round(a["cost"] / a["charged"], 2) if a["charged"] else None
    return out


def metro_medians(accts):
    by = defaultdict(list)
    for a in accts:
        if a["cpl"] and a["status"] == "ACTIVE":
            by[a["metro"]].append(a["cpl"])
    return {m: round(statistics.median(v), 2) for m, v in by.items()}


def health_flags(accts, prev, metro_cpl, today):
    prev_by = {p["account_id"]: p for p in prev}
    flags = []

    def flag(a, sev, check, detail, action):
        flags.append({"key": f"{a['account_id']}|{check}", "account_id": a["account_id"], "severity": sev,
                      "check": check, "detail": detail, "action": action})

    for a in accts:
        p = prev_by.get(a["account_id"], {})
        active = a["status"] == "ACTIVE"
        if a["status"] == "SUSPENDED":
            flag(a, "critical", "Suspended", "Account suspended; ads not serving",
                 "Open an appeal with LSA support; check the policy notice and license status")
        if a["status"] == "PAUSED":
            flag(a, "warn", "Paused", "Ads paused; not serving", "Confirm with the agent whether the pause is intended")
        if a["license"] in ("PENDING", "EXPIRED") or a["background"] == "PENDING":
            what = {"PENDING": "License pending", "EXPIRED": "License expired"}.get(a["license"], "Background check pending")
            flag(a, "critical", "Verification", f"{what}; ads limited until resolved",
                 "Collect documents from the agent and resubmit verification")
        days_left = (date.fromisoformat(a["license_expires"]) - today).days
        if a["license"] == "VERIFIED" and 0 < days_left <= 30:
            flag(a, "warn", "License expiring", f"Real estate license expires in {days_left} days",
                 "Request the renewed license before it lapses")
        if active and a["early_out"] >= WINDOW // 2:
            flag(a, "warn", "Budget runs out early", f"Out of budget before 2pm on {a['early_out']}/{WINDOW} days",
                 "Raise the weekly budget if cost per lead is healthy")
        mc = metro_cpl.get(a["metro"])
        if a["cpl"] and mc and a["cpl"] > 1.5 * mc and a["charged"] >= 5:
            flag(a, "warn", "High cost per lead", f"${a['cpl']:.0f} vs ${mc:.0f} {a['metro']} median",
                 "Review job types and the max-per-lead bid")
        if a["rated"] >= 5 and a["poor"] / a["rated"] > 0.35:
            flag(a, "warn", "Lead quality", f"{a['poor']} of {a['rated']} rated leads scored 1-2 stars",
                 "Dispute bad leads; tighten service area and job types")
        if active and p.get("leads", 0) >= 8 and a["leads"] < 0.5 * p["leads"]:
            flag(a, "warn", "Lead drop", f"{a['leads']} leads vs {p['leads']} in the prior {WINDOW} days",
                 "Check ranking factors: reviews, responsiveness, hours")
        if active and a["response_rate"] < 0.7:
            flag(a, "warn", "Missed calls",
                 f"Answers {a['response_rate'] * 100:.0f}% of calls; {a['missed']} missed in {WINDOW} days",
                 "Coach the agent on answering; responsiveness affects ranking")
        if active and a["disputable"] >= 5 and a["disputable"] / max(1, a["lead_rows"]) > 0.15:
            flag(a, "info", "Disputable leads", f"{a['disputable']} charged leads look disputable",
                 "Submit disputes for credit")
    return flags


CAUSE_LADDER = [
    ("Verification", lambda a: a["license"] != "VERIFIED" or a["background"] != "CLEARED",
     "Finish license / background verification",
     lambda a: f"License {a['license'].lower()}, background check {a['background'].lower()}"),
    ("Budget", lambda a: a["early_out"] >= 5, "Raise budget; it runs out before afternoon search peaks",
     lambda a: f"Out of budget before 2pm on {a['early_out']}/{WINDOW} days"),
    ("Service area", lambda a: a["service_zips"] < 8, "Widen the service area",
     lambda a: f"{a['service_zips']} ZIP codes"),
    ("Schedule", lambda a: a["hours_per_week"] < 50, "Extend business hours; ads only show while open",
     lambda a: f"{a['hours_per_week']} hours a week"),
    ("Responsiveness", lambda a: a["response_rate"] < 0.7, "Fix missed calls and slow replies",
     lambda a: f"Answers {a['response_rate'] * 100:.0f}% of calls"),
    ("Reviews", lambda a: a["reviews"] < 10 or a["rating"] < 4.5, "Send review requests to past clients",
     lambda a: f"{a['rating']:.1f}★ from {a['reviews']} reviews"),
    ("Lead ratings", lambda a: a["rated"] >= 5 and a["poor"] / a["rated"] > 0.35, "Rate and dispute leads",
     lambda a: f"{a['poor']}/{a['rated']} rated leads at 1-2★" if a["rated"] else "No rated leads"),
]


def ladder(a):
    return [{"cause": k, "failing": bool(test(a)), "fix": fix, "detail": detail(a)}
            for k, test, fix, detail in CAUSE_LADDER]


def showing_no_leads(accts):
    live = [a for a in accts if a["status"] == "ACTIVE" and a["imp"] > 0 and a["days"] >= 10]
    if not live:
        return []
    imp_med = statistics.median(a["imp"] for a in live)
    rate_med = statistics.median(a["leads"] / a["imp"] for a in live)
    out = []
    for a in live:
        rate = a["leads"] / a["imp"]
        showing = a["imp"] >= 0.5 * imp_med
        if (showing and rate < 0.4 * rate_med) or (not showing and a["service_zips"] < 8 and a["leads"] <= 3):
            out.append({"account_id": a["account_id"], "lead_rate": round(rate, 5), "cohort_rate": round(rate_med, 5),
                        "imp": a["imp"], "cohort_imp": imp_med, "causes": [r for r in ladder(a) if r["failing"]]})
    return sorted(out, key=lambda x: x["lead_rate"])


def new_agents(accts, today):
    out = []
    for a in accts:
        age = (today - date.fromisoformat(a["created"])).days
        if age <= 30:
            fl = a["first_lead"]
            out.append({"account_id": a["account_id"], "age_days": age,
                        "days_to_first_lead": (date.fromisoformat(fl) - date.fromisoformat(a["created"])).days if fl else None})
    return sorted(out, key=lambda x: x["age_days"])
