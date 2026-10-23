"""Synthetic real-estate LSA program: builds history and simulates each new day.

Every person, ID and number is invented. Daily results come from each account's current settings (budget, bid, service area, hours, verification, responsiveness, reviews), so changes made through the console show up in the following days' numbers.

Hidden traits (market size, base cost per lead, click-through) live in `account_traits`. The checks never read that table; they only see what the Google APIs would return.
"""
import math
import random
from datetime import date, timedelta

FIRST = ["Megan", "Carlos", "Priya", "Jordan", "Ashley", "Marcus", "Lauren", "Diego", "Tiffany", "Brandon",
         "Nicole", "Andre", "Rachel", "Kevin", "Vanessa", "Tyler", "Monica", "Derek", "Alicia", "Sean",
         "Hannah", "Omar", "Brittany", "Grant", "Jasmine", "Cody", "Natalie", "Victor", "Kelsey", "Isaac",
         "Danielle", "Trevor", "Leah", "Mateo", "Courtney", "Elijah", "Sabrina", "Wesley", "Gabriela", "Reid"]
LAST = ["Whitaker", "Delgado", "Raman", "Holloway", "Brennan", "Okafor", "Castillo", "Pruitt", "Nguyen",
        "Albright", "Sutton", "Mendez", "Carver", "Lindqvist", "Barnes", "Ferreira", "Hale", "Kowalski",
        "Duarte", "Pemberton", "Ross", "Tanaka", "Givens", "Marsh", "Ellison", "Rivas", "Coleman", "Stroud",
        "Vance", "Ibarra", "Calloway", "Moreau", "Haddad", "Underwood", "Quintero", "Ashby"]
SUFFIX = ["Home Group", "Realty", "Homes", "Property Group", "Real Estate", "Team"]
METROS = [("Phoenix", "AZ", 1.00, 1.15), ("Dallas", "TX", 1.10, 1.25), ("Atlanta", "GA", 1.05, 1.15),
          ("Tampa", "FL", 0.95, 1.00), ("Charlotte", "NC", 0.90, 0.90), ("Denver", "CO", 1.20, 0.95),
          ("Austin", "TX", 1.25, 1.00), ("Nashville", "TN", 1.00, 0.85), ("Orlando", "FL", 0.95, 1.00),
          ("Las Vegas", "NV", 0.90, 0.90), ("Raleigh", "NC", 0.95, 0.80), ("San Antonio", "TX", 0.85, 0.95),
          ("Houston", "TX", 1.05, 1.30), ("Jacksonville", "FL", 0.85, 0.80)]
PROFILES = {"ok": 62, "unverified": 4, "license_expiring": 3, "suspended": 2, "paused": 2, "high_demand": 8,
            "unresponsive": 6, "poor_quality": 5, "narrow_area": 3, "new_agent": 5}
LEAD_TYPES = ["Phone call", "Message", "Booking"]
CATEGORIES = ["Buyer", "Seller", "Buyer & seller"]
DISPUTE_REASONS = ["Spam / robocall", "Outside service area", "Not a real estate request",
                   "Duplicate lead", "Looking for rental / property manager"]
CREDIT_ODDS = {"Spam / robocall": 0.85, "Outside service area": 0.7, "Not a real estate request": 0.75,
               "Duplicate lead": 0.9, "Looking for rental / property manager": 0.6}

SCHEMA = """
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY, name TEXT, business TEXT, metro TEXT, state TEXT, weekly_budget REAL,
  bid_mode TEXT, max_per_lead REAL, license TEXT, license_expires TEXT, background TEXT, status TEXT,
  rating REAL, reviews INTEGER, service_zips INTEGER, hours_per_week INTEGER, response_rate REAL,
  created TEXT, first_lead TEXT);
CREATE TABLE account_traits (
  account_id TEXT PRIMARY KEY, vol REAL, base_cpl REAL, ctr REAL, bad_rate REAL, profile TEXT);
CREATE TABLE daily (
  account_id TEXT, day TEXT, impressions INTEGER, leads INTEGER, charged_leads INTEGER, cost REAL,
  budget_out_hour INTEGER, missed_calls INTEGER, PRIMARY KEY (account_id, day));
CREATE TABLE leads (
  lead_id TEXT PRIMARY KEY, account_id TEXT, day TEXT, hour INTEGER, lead_type TEXT, category TEXT,
  charged INTEGER, cost REAL, status TEXT, rating INTEGER, rating_source TEXT, call_seconds INTEGER,
  dispute_reason TEXT, dispute_status TEXT, dispute_day TEXT);
CREATE INDEX leads_day ON leads(day);
CREATE INDEX daily_day ON daily(day);
"""

clamp = lambda x, lo, hi: max(lo, min(hi, x))


def _account_row(con, aid):
    cols = [c[1] for c in con.execute("PRAGMA table_info(accounts)")]
    return dict(zip(cols, con.execute("SELECT * FROM accounts WHERE account_id=?", (aid,)).fetchone()))


def _next_lead_id(con):
    n = con.execute("SELECT COALESCE(MAX(CAST(SUBSTR(lead_id, 2) AS INTEGER)), 0) FROM leads").fetchone()[0]
    return n + 1


def simulate_day(con, a, t, day, rng, lead_seq, store_leads=True, history=False):
    """Writes one day of results for account `a` (dict of current settings). Returns next lead_seq."""
    if day < date.fromisoformat(a["created"]):
        return lead_seq
    aid = a["account_id"]
    if a["status"] != "ACTIVE":
        con.execute("INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?)", (aid, day.isoformat(), 0, 0, 0, 0, None, 0))
        return lead_seq
    age = (day - date.fromisoformat(a["created"])).days
    ramp = clamp((age - 4) / 14, 0, 1)
    weekend = 0.72 if day.weekday() == 6 else 0.85 if day.weekday() == 5 else 1.0
    season = 1 + 0.06 * math.sin(day.toordinal() / 9)
    area = min(1.0, a["service_zips"] / 12) ** 0.85
    hours = min(1.0, a["hours_per_week"] / 70) ** 0.7
    verified = 0.05 if a["license"] == "PENDING" or a["background"] == "PENDING" else 1.0
    budget_f = clamp(a["weekly_budget"] / 600, 0.6, 1.4) ** 0.5
    imp = int(max(0, rng.gauss(150, 32)) * t["vol"] * weekend * season * ramp * area * hours * verified * budget_f)

    resp = 0.3 + 0.7 * clamp((a["response_rate"] - 0.4) / 0.45, 0, 1)
    rev = (0.55 + 0.45 * min(1, a["reviews"] / 12)) * (0.6 + 0.4 * clamp((a["rating"] - 3.8) / 1.0, 0, 1))
    bid = clamp(a["max_per_lead"] / t["base_cpl"], 0.4, 1.0) if a["max_per_lead"] else 1.0
    ctr = t["ctr"] * resp * rev * bid
    demand = sum(1 for _ in range(imp) if rng.random() < ctr)

    daily_budget = a["weekly_budget"] / 7
    cost, charged, out_hour, missed, rows = 0.0, 0, None, 0, []
    for hour in sorted(int(clamp(rng.gauss(13, 3), 7, 21)) for _ in range(demand)):
        cpl = max(14, rng.gauss(t["base_cpl"], t["base_cpl"] * 0.18))
        if a["max_per_lead"]:
            cpl = min(cpl, a["max_per_lead"])
        is_charged = rng.random() > 0.05            # repeat callers and the like are not charged
        if is_charged and cost + cpl > daily_budget * 1.1:
            out_hour = hour                          # Google stops showing the ad for the rest of the day
            break
        if is_charged:
            cost += cpl
            charged += 1
        lead_type = rng.choices(LEAD_TYPES, weights=[68, 27, 5])[0]
        if lead_type == "Phone call" and rng.random() > a["response_rate"]:
            missed += 1
        rows.append((hour, lead_type, rng.choices(CATEGORIES, weights=[55, 30, 15])[0], is_charged, cpl))
    con.execute("INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?)",
                (aid, day.isoformat(), imp, len(rows), charged, round(cost, 2), out_hour, missed))
    if rows and not a["first_lead"]:
        a["first_lead"] = day.isoformat()
        con.execute("UPDATE accounts SET first_lead=? WHERE account_id=?", (a["first_lead"], aid))
    if not store_leads:
        return lead_seq
    for hour, lead_type, category, is_charged, cpl in rows:
        bad = rng.random() < t["bad_rate"]
        dispute = rng.choice(DISPUTE_REASONS) if bad else None
        secs = (rng.randint(4, 25) if bad else rng.randint(45, 900)) if lead_type == "Phone call" else None
        rating, status, dstatus = None, "New", None
        if history:                                   # older leads already worked by the agent
            if rng.random() < 0.3:
                rating = rng.choice([1, 2]) if bad else rng.choices([3, 4, 5], weights=[2, 4, 4])[0]
            status = rng.choices(["Active", "Booked", "Archived"], weights=[5, 0 if bad else 2, 3 if bad else 2])[0]
            if dispute and is_charged and rng.random() < 0.35:
                dstatus = "credited"
        con.execute("INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (f"L{lead_seq:06d}", aid, day.isoformat(), hour, lead_type, category, int(is_charged),
                     round(cpl if is_charged else 0, 2), status, rating, "agent" if rating else None, secs,
                     dispute, dstatus, day.isoformat() if dstatus else None))
        lead_seq += 1
    return lead_seq


def build(con, n_accounts=240, days=56, lead_days=28, seed=11, today=None):
    """Fresh program with `days` of history ending the day before `today`."""
    rng = random.Random(seed)
    today = today or date.today()
    for tbl in ("accounts", "account_traits", "daily", "leads"):
        con.execute(f"DROP TABLE IF EXISTS {tbl}")
    con.executescript(SCHEMA)
    used, accounts = set(), []
    for i in range(1, n_accounts + 1):
        while True:
            first, last = rng.choice(FIRST), rng.choice(LAST)
            if (first, last) not in used:
                used.add((first, last))
                break
        metro, state, cpl_mult, vol_mult = rng.choice(METROS)
        p = rng.choices(list(PROFILES), weights=list(PROFILES.values()))[0]
        budget = rng.choice([280, 350, 420, 500, 600, 700, 850, 1000, 1200, 1500])
        bid_mode = "Max per lead" if rng.random() < 0.3 else "Maximize leads"
        base_cpl = rng.uniform(31, 47) * cpl_mult * (0.72 if p == "high_demand" else 1)
        age = rng.randint(6, 18) if p == "new_agent" else rng.randint(70, 1100)
        a = {
            "account_id": f"DEMO-{100000 + i}", "name": f"{first} {last}",
            "business": f"{last} {rng.choice(SUFFIX)}" if rng.random() < 0.6 else f"{first} {last}, Realtor",
            "metro": metro, "state": state, "weekly_budget": budget, "bid_mode": bid_mode,
            "max_per_lead": round(base_cpl * rng.uniform(1.05, 1.4)) if bid_mode == "Max per lead" else None,
            "license": {"unverified": "PENDING"}.get(p, "VERIFIED"),
            "license_expires": (today + timedelta(days=rng.randint(5, 28) if p == "license_expiring" else rng.randint(60, 700))).isoformat(),
            "background": "PENDING" if p == "unverified" and rng.random() < 0.5 else "CLEARED",
            "status": "ACTIVE",
            "rating": round(rng.uniform(3.7, 4.4) if p == "unresponsive" else rng.uniform(4.6, 5.0), 1),
            "reviews": rng.randint(1, 6) if p in ("unresponsive", "new_agent") else rng.randint(9, 180),
            "service_zips": rng.randint(2, 5) if p == "narrow_area" else rng.randint(9, 45),
            "hours_per_week": rng.choice([35, 40, 45]) if p == "unresponsive" else rng.choice([60, 72, 84, 98]),
            "response_rate": round(rng.uniform(0.38, 0.62) if p == "unresponsive" else rng.uniform(0.82, 0.98), 2),
            "created": (today - timedelta(days=age)).isoformat(), "first_lead": None,
        }
        t = {"account_id": a["account_id"], "vol": vol_mult * (1.5 if p == "high_demand" else 1),
             "base_cpl": base_cpl, "ctr": rng.uniform(0.026, 0.036) if p == "high_demand" else rng.uniform(0.018, 0.03),
             "bad_rate": 0.45 if p == "poor_quality" else 0.03, "profile": p}
        con.execute(f"INSERT INTO accounts VALUES ({','.join('?' * len(a))})", tuple(a.values()))
        con.execute("INSERT INTO account_traits VALUES (?,?,?,?,?,?)", tuple(t.values()))
        accounts.append((a, t, p))

    lead_seq = 1
    for d in range(days):
        day = today - timedelta(days=days - d)
        for a, t, p in accounts:
            if p == "paused" and d == days - 10:
                a["status"] = "PAUSED"
            if p == "suspended" and d == days - 7:
                a["status"] = "SUSPENDED"
            lead_seq = simulate_day(con, a, t, day, rng, lead_seq, store_leads=d >= days - lead_days, history=True)
    for a, t, p in accounts:
        con.execute("UPDATE accounts SET status=? WHERE account_id=?", (a["status"], a["account_id"]))
    con.commit()


def advance(con, day, seed=None):
    """Simulates `day` for every account from its current settings, then ages leads and disputes."""
    rng = random.Random(seed if seed is not None else day.toordinal())
    tcols = ["account_id", "vol", "base_cpl", "ctr", "bad_rate", "profile"]
    traits = {r[0]: dict(zip(tcols, r)) for r in con.execute("SELECT * FROM account_traits")}
    lead_seq = _next_lead_id(con)
    for (aid,) in con.execute("SELECT account_id FROM accounts ORDER BY account_id").fetchall():
        lead_seq = simulate_day(con, _account_row(con, aid), traits[aid], day, rng, lead_seq)
    # Agents work their leads: new ones become active or booked a day or two later.
    for lid, bad in con.execute("SELECT lead_id, dispute_reason IS NOT NULL FROM leads WHERE status='New' AND day<=?",
                                ((day - timedelta(days=1)).isoformat(),)).fetchall():
        con.execute("UPDATE leads SET status=? WHERE lead_id=?",
                    (rng.choices(["Active", "Booked", "Archived"], weights=[5, 0 if bad else 2, 3 if bad else 1])[0], lid))
    # Google reviews disputes by the end of the day they were submitted (simulated outcome).
    resolved = []
    for lid, reason in con.execute("SELECT lead_id, dispute_reason FROM leads WHERE dispute_status='submitted' AND dispute_day<=?",
                                   (day.isoformat(),)).fetchall():
        outcome = "credited" if rng.random() < CREDIT_ODDS.get(reason, 0.5) else "rejected"
        con.execute("UPDATE leads SET dispute_status=?, dispute_day=? WHERE lead_id=?", (outcome, day.isoformat(), lid))
        resolved.append(outcome)
    # Licenses that reach their expiry date lapse.
    expired = con.execute("UPDATE accounts SET license='EXPIRED' WHERE license='VERIFIED' AND license_expires<=?",
                          (day.isoformat(),)).rowcount
    con.execute("DELETE FROM leads WHERE day<?", ((day - timedelta(days=35)).isoformat(),))
    con.execute("DELETE FROM daily WHERE day<?", ((day - timedelta(days=90)).isoformat(),))
    con.commit()
    return {"credited": resolved.count("credited"), "rejected": resolved.count("rejected"), "licenses_expired": expired}
