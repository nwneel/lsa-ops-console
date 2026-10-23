"""Live-data adapters for production. The demo does not call them; they show the shape of the real pulls.

Local Services API (being folded into the Google Ads API):
  GET https://localservices.googleapis.com/v1/accountReports:search
  GET https://localservices.googleapis.com/v1/detailedLeadReports:search
Google Ads API (GAQL via GoogleAdsService.SearchStream):
  local_services_lead, local_services_verification_artifact, campaign_budget
  LocalServicesLeadService.ProvideLeadFeedback for lead rating at scale
"""
import json
import os
import urllib.parse
import urllib.request

LSA_BASE = "https://localservices.googleapis.com/v1"


def _get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def account_reports(manager_id, start, end, token=None):
    token = token or os.environ["GOOGLE_OAUTH_TOKEN"]
    params = {"query": f"manager_customer_id:{manager_id}",
              "startDate.year": start.year, "startDate.month": start.month, "startDate.day": start.day,
              "endDate.year": end.year, "endDate.month": end.month, "endDate.day": end.day,
              "pageSize": 1000}
    url = f"{LSA_BASE}/accountReports:search?{urllib.parse.urlencode(params)}"
    while url:
        page = _get(url, token)
        # Fields used: accountId, businessName, averageWeeklyBudget, currentPeriodChargedLeads, currentPeriodTotalCost, impressionsLastTwoDays, phoneLeadResponsiveness, averageFiveStarRating, totalReview
        yield from page.get("accountReports", [])
        nxt = page.get("nextPageToken")
        url = f"{LSA_BASE}/accountReports:search?{urllib.parse.urlencode({**params, 'pageToken': nxt})}" if nxt else None


LEADS_GAQL = """
SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status,
       local_services_lead.category_id, local_services_lead.lead_charged,
       local_services_lead.creation_date_time
FROM local_services_lead
WHERE local_services_lead.creation_date_time DURING LAST_14_DAYS"""

VERIFICATION_GAQL = """
SELECT local_services_verification_artifact.id, local_services_verification_artifact.status,
       local_services_verification_artifact.artifact_type
FROM local_services_verification_artifact"""
