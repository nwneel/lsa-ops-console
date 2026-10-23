"""Guardrails for every change, whoever proposes it (rules, Claude, bulk edit or a person).

evaluate() decides; it never writes. The engine applies, queues or logs based on the decision.
"""
DEFAULTS = {"max_pct": 20, "per_day": 1, "floor": 150, "ceiling": 3000, "max_zip_add": 10, "cooldown_days": 7}

FIELDS = {
    "weekly_budget": "Weekly budget",
    "max_per_lead": "Max per lead bid",
    "service_zips": "Service area",
    "hours_per_week": "Business hours",
}


def evaluate(field, old, proposed, changes_today, g):
    """Returns {new, pct, decision, note}. decision: ok | needs_approval | blocked | noop."""
    note = None
    new = proposed
    if field == "weekly_budget":
        new = max(g["floor"], min(g["ceiling"], round(proposed / 10) * 10))
        if new != round(proposed / 10) * 10:
            note = f"clamped to ${g['floor']:,}–${g['ceiling']:,}"
    elif field == "max_per_lead":
        new = max(10, round(proposed))
    elif field == "service_zips":
        new = max(1, int(round(proposed)))
    elif field == "hours_per_week":
        new = max(20, min(98, int(round(proposed))))
    new = round(new, 2)
    pct = (new - old) / old if old else 1.0
    if new == old:
        decision = "noop"
    elif changes_today >= g["per_day"]:
        decision = "blocked"
    elif field in ("weekly_budget", "max_per_lead") and abs(pct) > g["max_pct"] / 100:
        decision = "needs_approval"
    elif field == "service_zips" and new - old > g["max_zip_add"]:
        decision = "needs_approval"
    else:
        decision = "ok"
    return {"new": new, "pct": round(pct * 100, 1), "decision": decision, "note": note}
