"""Budget recommendations. Proposals only: nothing here writes to an account.

Rules run every pipeline. Claude reviews an account on request when ANTHROPIC_API_KEY is set.
"""
import json
import os
import urllib.request

MODEL = "claude-sonnet-5-5"


def rule_based(a, metro_cpl):
    cpl, b = a["cpl"], a["weekly_budget"]
    if a["status"] != "ACTIVE" or not metro_cpl:
        return None
    if a["rated"] >= 5 and a["poor"] / a["rated"] > 0.35:
        return b * 0.85, "Over a third of rated leads are 1-2 stars; trim spend while disputes and ratings retrain Google"
    if a["early_out"] >= 5 and cpl and cpl < 0.8 * metro_cpl:
        return b * 1.4, f"CPL ${cpl:.0f} is well under the ${metro_cpl:.0f} metro median and budget runs out before 2pm"
    if a["early_out"] >= 7 and cpl and cpl < metro_cpl:
        return b * 1.15, f"CPL ${cpl:.0f} under the metro median and budget runs out most days"
    if cpl and cpl > 1.5 * metro_cpl and a["charged"] >= 5:
        return b * 0.8, f"CPL ${cpl:.0f} is {cpl / metro_cpl:.1f}x the metro median"
    return None


def claude_available():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def claude_review(a, metro_cpl, flags, failing, guard):
    facts = {k: a[k] for k in ("metro", "weekly_budget", "bid_mode", "max_per_lead", "imp", "leads", "charged", "cost",
                               "cpl", "early_out", "rated", "poor", "disputable", "rating", "reviews", "response_rate",
                               "service_zips", "hours_per_week", "license", "background", "status")}
    facts.update(metro_median_cpl=metro_cpl, prior_14d_leads=a.get("prev_leads"), flags=flags, failing_cause_checks=failing)
    prompt = f"""You manage Google Local Services Ads for a real estate brokerage. Review one agent's account and recommend what to do this week.
Guardrails: weekly budget changes above {guard['max_pct']}% need human approval; floor ${guard['floor']}, ceiling ${guard['ceiling']}.
Budget only helps when the account can turn spend into good leads; fix account problems first when they are the cause.
Account data (last 14 days unless noted): {json.dumps(facts)}
Reply with only JSON: {{"action": "raise_budget" | "lower_budget" | "hold_budget", "new_weekly_budget": number, "summary": "one sentence", "reasons": ["up to 3 short reasons citing the numbers"], "account_fixes": ["up to 3 non-budget fixes, empty if none"]}}"""
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({"model": MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = json.load(r)["content"][0]["text"]
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1])
