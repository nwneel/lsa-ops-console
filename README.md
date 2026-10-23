# LSA Ops Console

Monitoring and automation for a Google Local Services Ads program run across hundreds of agent accounts. A daily pipeline checks every account, diagnoses the ones that show but don't get leads, proposes budget changes, runs every change through guardrails, and records everything in an activity log. A web console lets an operator review, approve and act on the results.

This repository runs on a synthetic program of 240 real estate agent accounts, so it can be shown without any client data. Names, IDs and numbers are generated.

## What it does

**Daily health checks.** Every run evaluates each account for:

- Suspensions and paused accounts
- Verification: license pending or expired, background check pending, license expiring within 30 days
- Budget running out before 2pm on most days
- Cost per lead above 1.5x the metro median
- Lead quality: over a third of rated leads at 1 to 2 stars
- Lead drops of 50% or more against the prior 14 days
- Missed calls (answer rate under 70%)
- Charged leads that look disputable

Flags clear on their own when a later run no longer sees the problem, and each one records when it first appeared.

**Showing but not getting leads.** Accounts with at least half the median impressions and a lead rate under 40% of the median are flagged. For each one the tool checks the likely causes in order (verification, budget, service area, schedule, responsiveness, reviews, lead ratings) and attaches the fix. Fixes can be turned into tasks, and completing a task updates the account.

**Budget changes with guardrails.** A rules engine proposes weekly budget changes from cost per lead, budget pacing and lead quality. Claude can review an account on request when an API key is configured. Every change, whether it comes from the rules, Claude, a bulk edit or a person, goes through the same guardrails:

- Changes over a set percentage (default 20%) wait for approval
- One change per account per day
- Budget floor and ceiling, rounded to $10
- A cooldown between automatic budget changes on the same account
- Larger service area expansions need approval

Within the caps, the write mode decides what happens: **apply** writes the change, **dry run** logs it without writing.

**Changes at scale.** Bulk edits to weekly budget, max-per-lead bid, service area and business hours, filtered by condition and metro, with a preview of each account's guardrail decision before anything runs.

**Lead quality at scale.** A dispute queue for charged leads that match a dispute reason, simulated Google outcomes the next day, credits recovered, and bulk lead ratings from clear signals (very short calls, disputable leads, booked appointments).

**Reporting.** Program overview, metro breakdown, new-agent speed to first lead, a week-by-week table and a weekly summary ready to paste into Slack or email.

**Activity log.** Every pipeline step, change, approval, dispute, rating, task and setting change is written to an append-only log with the actor and the simulated day.

## Running it

Requires Python 3.9 or later. There are no third-party dependencies.

```bash
python3 server.py            # http://0.0.0.0:3000
python3 server.py --reset    # rebuild the synthetic program first
python3 server.py --port 8080
```

Open the console in a browser. On first start the server builds 240 accounts with 56 days of history and runs the pipeline once.

To enable Claude account reviews, set an API key before starting:

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 server.py
```

The same engine is available from the command line:

```bash
python3 run.py reset         # rebuild the synthetic program
python3 run.py run           # run the pipeline on current data
python3 run.py advance 3     # simulate 3 days, running the pipeline after each
```

## Driving the simulation

The sidebar and the Automation page control the program:

- **Run** runs the pipeline on the current data.
- **Next day** simulates one day of account activity, then runs the pipeline.
- **Autopilot** repeats Next day on a timer, from every 10 seconds to every 5 minutes.
- **Write mode** switches between apply and dry run.
- **Reset demo data** rebuilds the program from scratch.

Each simulated day is generated from the accounts' current settings. Raising a budget on an account that runs out early brings more leads; widening a narrow service area or extending short hours raises impressions; finishing verification brings an account back into the results. The checks never read the simulator's hidden traits, only the fields and metrics the Google APIs would return.

## Project layout

```
server.py              HTTP server, JSON API and autopilot thread
run.py                 Command-line access to the engine
lsa_ops/
  engine.py            Pipeline, guardrailed changes, approvals, tasks, disputes, log, read model
  checks.py            Health checks, showing-without-leads detector, cause ladder
  guardrails.py        Change evaluation: caps, daily limit, floor and ceiling, approvals
  recommend.py         Rules engine and Claude account review
  sim.py               Synthetic program: history and day-by-day simulation
  live.py              Production adapters for the Local Services API and Google Ads API
web/
  index.html           Console layout and styles
  app.js               Console views, charts and actions
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Everything the console shows, computed on request |
| GET | `/api/health` | Server status and data version |
| POST | `/api/run` | Run the pipeline |
| POST | `/api/advance` | Simulate `days` days (default 1), running the pipeline after each |
| POST | `/api/settings` | Update `guard`, `write_mode` or `autopilot_secs` |
| POST | `/api/change` | Propose one change for an account |
| POST | `/api/preview/change` | Guardrail decision for a change, without acting |
| POST | `/api/bulk` | Run a bulk change |
| POST | `/api/preview/bulk` | Preview a bulk change |
| POST | `/api/proposals/{id}/approve` | Approve a pending change |
| POST | `/api/proposals/{id}/reject` | Reject a pending change |
| POST | `/api/proposals/approve-all` | Approve every pending change |
| POST | `/api/flags/ack` | Acknowledge or reopen a flag |
| POST | `/api/tasks` | Create fix tasks for an account |
| POST | `/api/tasks/{id}/done` | Complete a task |
| POST | `/api/accounts/status` | Pause or resume an account |
| POST | `/api/accounts/renew-license` | Record a renewed license |
| POST | `/api/leads/dispute` | Submit lead disputes |
| POST | `/api/leads/feedback` | Send suggested lead ratings |
| POST | `/api/ai-review` | Claude review of one account |
| POST | `/api/reset` | Rebuild the synthetic program |

## In production

The simulator stands in for the data pulls. Against live accounts, the pull step reads:

- `accountReports:search` and `detailedLeadReports:search` from the Local Services API
- `local_services_lead` and `local_services_verification_artifact` from the Google Ads API, where LSA is moving

and writes through:

- `CampaignBudgetService.MutateCampaignBudgets` for budget changes
- `LocalServicesLeadService.ProvideLeadFeedback` for lead ratings

`lsa_ops/live.py` shows the shape of those calls. SQLite would typically be replaced by Postgres or BigQuery, and the pipeline would run on a schedule (for example 6:00 AM ET) instead of the Next day button.
