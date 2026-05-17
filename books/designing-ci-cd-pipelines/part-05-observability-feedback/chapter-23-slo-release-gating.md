# Chapter 23: The SLO-Based Release Gating Pattern
*Part V: Deployment Observability & Feedback Loops*

> *"Our SLO was 99.9% availability. We had burned 95% of the monthly error budget
> by the 22nd. We deployed on the 23rd. The deployment burned the remaining 5%
> in 18 minutes. We were out of error budget for the last week of the month.
> The pipeline didn't know. Nobody told it."*
> — SRE at a logistics company, postmortem January 2023

---

## The War Story

Veritas Logistics runs a shipment tracking API. Their SLO: 99.9% availability over a 30-day rolling window. Monthly error budget: 43.2 minutes of allowed downtime (0.1% × 30 days × 24 hours × 60 minutes). The SLO is taken seriously — they have Prometheus alerts on burn rate and a weekly error budget review.

On January 22nd, the error budget is at 41 of 43.2 minutes consumed. Two minor incidents earlier in the month ate most of it. The remaining budget: 2.2 minutes.

On January 23rd, the backend team deploys a new version of the shipment query service. The deployment is routine — CI passed, staging looked good. Nobody checks the error budget before deploying. Nobody's job it is to check. The deployment pipeline doesn't know the error budget exists.

The new version has a bug: under high concurrency, a connection pool race condition causes intermittent 503 responses. At normal load, the error rate is 0.4%. Doesn't seem bad. Except: 0.4% against an SLO of 99.9% means the service is burning error budget at 4× the normal rate.

The remaining 2.2 minutes of error budget is consumed in 18 minutes. For the last 8 days of January, every time an on-call alert fires for any reason, the SRE team has no error budget left to spend on investigation. The SLO is already breached. Customer contracts tied to the SLO are in violation. The conversation with the VP of Customer Success is the kind of conversation that restructures teams.

The fix is a pipeline change: check error budget before any production deployment. If the error budget is below 20%, block the deployment and require explicit override.

This chapter covers how to build that check.

---

## What You'll Learn

- The error budget model: translating SLO percentages into actionable deployment gates
- Burn rate calculation: measuring how fast the error budget is being consumed
- Implementing SLO-based gates with Prometheus, Datadog, and Google Cloud Monitoring
- The organizational contract: who owns the SLO vs. who owns the deployment gate
- The override mechanism: how to deploy despite low error budget when genuinely necessary
- Multi-window burn rate: why a single burn rate calculation is insufficient

---

## Error Budget as a Deployment Gate

An error budget is the amount of unreliability your SLO permits over a given window. A 99.9% availability SLO over 30 days means you can afford 43.2 minutes of downtime. When the budget is full, you can deploy aggressively. When it's nearly exhausted, every deployment carries more risk than it would normally.

The deployment gate logic:

```
Error Budget Remaining → Deployment Decision

> 50% remaining:  Proceed. Normal deployment risk is acceptable.
20–50% remaining: Proceed with extra caution. Monitor post-deploy closely.
10–20% remaining: Warning. Consider deferring non-critical changes.
< 10% remaining:  Block. Require explicit override with documented justification.
= 0% (exhausted):  Hard block. Only emergency fixes with break-glass approval.
```

This is not the same as "freeze all deployments when something goes wrong." A deployment freeze is a manual, reactive action. SLO-based gating is an automated, proactive check that runs before every deployment.

---

## The Mathematics: Burn Rate

A burn rate of 1.0 means you're consuming error budget at exactly the rate that would exhaust it over the full SLO window. A burn rate of 10.0 means you're consuming it 10× faster — you'd exhaust a monthly budget in 3 days.

```python
# slo_gate.py — calculate burn rate and make a deployment gate decision

from dataclasses import dataclass
from datetime import datetime, timedelta
import requests

@dataclass
class SLOState:
    slo_target: float          # e.g., 0.999 (99.9%)
    window_days: int           # e.g., 30
    current_availability: float # e.g., 0.9994 (measured over window)
    
    @property
    def error_budget_total_minutes(self) -> float:
        """Total error budget allowed over the SLO window."""
        return (1 - self.slo_target) * self.window_days * 24 * 60
    
    @property
    def error_budget_consumed_minutes(self) -> float:
        """Minutes of downtime consumed so far in the window."""
        actual_unavailability = 1 - self.current_availability
        return actual_unavailability * self.window_days * 24 * 60
    
    @property
    def error_budget_remaining_pct(self) -> float:
        """Fraction of error budget remaining (0.0 = exhausted, 1.0 = full)."""
        consumed = self.error_budget_consumed_minutes
        total = self.error_budget_total_minutes
        if total == 0:
            return 1.0
        remaining = max(0, total - consumed)
        return remaining / total
    
    @property
    def burn_rate(self) -> float:
        """Current burn rate relative to the budget-exhaustion rate.
        
        burn_rate = 1.0: consuming budget at the rate that would exhaust it in window_days
        burn_rate = 10.0: consuming at 10× the budget-exhaustion rate
        """
        # Burn rate over the last 1 hour
        # This requires querying Prometheus for the recent error rate
        # See implementation below
        raise NotImplementedError


def get_slo_state_from_prometheus(
    service: str,
    prometheus_url: str,
    slo_target: float = 0.999,
    window_days: int = 30
) -> SLOState:
    """Fetch current SLO state from Prometheus."""
    
    # Query 1: availability over the SLO window
    availability_query = f"""
    1 - (
      sum(rate(http_requests_total{{
        service="{service}",
        status_code=~"5.."
      }}[{window_days}d]))
      /
      sum(rate(http_requests_total{{
        service="{service}"
      }}[{window_days}d]))
    )
    """
    
    response = requests.get(
        f"{prometheus_url}/api/v1/query",
        params={"query": availability_query}
    )
    current_availability = float(response.json()["data"]["result"][0]["value"][1])
    
    return SLOState(
        slo_target=slo_target,
        window_days=window_days,
        current_availability=current_availability
    )


def get_burn_rate(service: str, prometheus_url: str, window: str = "1h") -> float:
    """
    Calculate the current burn rate over the specified window.
    
    Burn rate = (error rate over window) / (1 - SLO target)
    
    A burn rate of 1.0 at a 99.9% SLO means the service has a 0.1% error rate —
    exactly the rate that would exhaust the budget over the full 30-day window.
    A burn rate of 10.0 means a 1% error rate — 10× the budget exhaustion rate.
    """
    query = f"""
    (
      sum(rate(http_requests_total{{service="{service}",status_code=~"5.."}}[{window}]))
      /
      sum(rate(http_requests_total{{service="{service}"}}[{window}]))
    )
    /
    (1 - 0.999)
    """
    
    response = requests.get(
        f"{prometheus_url}/api/v1/query",
        params={"query": query}
    )
    result = response.json()["data"]["result"]
    if not result:
        return 0.0
    return float(result[0]["value"][1])


def evaluate_deployment_gate(
    service: str,
    prometheus_url: str,
    environment: str = "production"
) -> tuple[bool, str]:
    """
    Evaluate whether a deployment should proceed based on SLO state.
    
    Returns: (should_proceed, reason_message)
    """
    slo = get_slo_state_from_prometheus(service, prometheus_url)
    burn_rate_1h = get_burn_rate(service, prometheus_url, window="1h")
    burn_rate_6h = get_burn_rate(service, prometheus_url, window="6h")
    
    budget_remaining = slo.error_budget_remaining_pct
    
    # Hard block: error budget exhausted
    if budget_remaining <= 0:
        return False, (
            f"BLOCKED: Error budget exhausted for {service}. "
            f"No error budget remaining in the current {slo.window_days}-day window. "
            f"Only emergency deployments (break-glass) are permitted."
        )
    
    # Hard block: very low budget + high current burn rate
    if budget_remaining < 0.05 and burn_rate_1h > 2.0:
        return False, (
            f"BLOCKED: Error budget critically low ({budget_remaining:.1%} remaining) "
            f"with active burn rate {burn_rate_1h:.1f}x. "
            f"Service is actively degraded. Resolve degradation before deploying."
        )
    
    # Soft block: low budget
    if budget_remaining < 0.10:
        return False, (
            f"BLOCKED: Error budget below 10% ({budget_remaining:.1%} remaining). "
            f"Deployments are blocked to protect remaining budget. "
            f"Use break-glass override if this change is required to fix a current incident."
        )
    
    # Warning: moderate burn rate
    if burn_rate_6h > 3.0:
        return True, (
            f"WARNING: Proceeding with deployment but 6h burn rate is elevated "
            f"({burn_rate_6h:.1f}x). Error budget at {budget_remaining:.1%}. "
            f"Monitor closely post-deployment."
        )
    
    # All clear
    return True, (
        f"SLO gate passed: {budget_remaining:.1%} error budget remaining, "
        f"burn rate {burn_rate_1h:.1f}x (1h), {burn_rate_6h:.1f}x (6h)."
    )
```

---

## Multi-Window Burn Rate: Why One Number Is Insufficient

A single burn rate calculation over a short window is noisy. A 5-minute spike in errors (a flaky dependency, a single slow request) can produce a temporarily high burn rate that doesn't represent the service's actual reliability state.

Google's SRE practices (and the OpenSLO standard) recommend multi-window burn rate: alert or gate when burn rate is high across multiple windows simultaneously. This eliminates false positives from transient spikes while catching genuine degradation.

```python
def multi_window_burn_rate_gate(service: str, prometheus_url: str) -> GateDecision:
    """
    Multi-window burn rate evaluation.
    
    Google's recommended alert thresholds (from the SRE Workbook):
    - Fast burn: burn_rate > 14.4 for 1h AND burn_rate > 14.4 for 5m
      → budget exhaustion in < 1 hour
    - Medium burn: burn_rate > 6 for 6h AND burn_rate > 6 for 30m
      → budget exhaustion in < 5 hours
    - Slow burn: burn_rate > 3 for 1d AND burn_rate > 3 for 6h
      → budget exhaustion in < 10 days
    """
    
    burns = {
        "5m": get_burn_rate(service, prometheus_url, "5m"),
        "1h": get_burn_rate(service, prometheus_url, "1h"),
        "6h": get_burn_rate(service, prometheus_url, "6h"),
        "1d": get_burn_rate(service, prometheus_url, "24h"),
    }
    
    # Fast burn: deployment into a currently-degrading service
    if burns["1h"] > 14.4 and burns["5m"] > 14.4:
        return GateDecision(
            proceed=False,
            severity="critical",
            message=f"Fast burn detected: service is consuming error budget at "
                    f"{burns['1h']:.1f}x the sustainable rate. "
                    f"Budget will exhaust in <1 hour at current rate. BLOCKED."
        )
    
    # Medium burn: service degraded, deploying will compound it
    if burns["6h"] > 6 and burns["1h"] > 6:
        return GateDecision(
            proceed=False,
            severity="high",
            message=f"Medium burn detected: {burns['6h']:.1f}x sustained over 6h. "
                    f"Deploying into a degraded service is high risk. BLOCKED."
        )
    
    # Slow burn: service is degraded but not critically — proceed with warning
    if burns["1d"] > 3 and burns["6h"] > 3:
        return GateDecision(
            proceed=True,
            severity="warning",
            message=f"Slow burn active: {burns['1d']:.1f}x sustained over 24h. "
                    f"Monitor closely. Consider resolving degradation before deploying."
        )
    
    return GateDecision(proceed=True, severity="ok", message="Burn rate nominal.")
```

---

## Implementation: Datadog SLO Monitor Integration

For teams using Datadog instead of Prometheus:

```python
# datadog_slo_gate.py
import os
from datadog_api_client import ApiClient, Configuration
from datadog_api_client.v1 import apis, models

def get_slo_budget_remaining(slo_id: str) -> float:
    """Fetch current error budget remaining from Datadog SLO."""
    
    config = Configuration()
    config.api_key["apiKeyAuth"] = os.environ["DD_API_KEY"]
    config.api_key["appKeyAuth"] = os.environ["DD_APP_KEY"]
    
    with ApiClient(config) as client:
        slo_api = apis.ServiceLevelObjectivesApi(client)
        
        # Get SLO history — this includes budget remaining
        history = slo_api.get_slo_history(
            slo_id=slo_id,
            from_ts=int((datetime.now() - timedelta(days=30)).timestamp()),
            to_ts=int(datetime.now().timestamp())
        )
        
        # budget_remaining: fraction remaining (0.0–1.0)
        return history.data.overall.budget_remaining / 100.0

def datadog_slo_gate(slo_id: str, service: str) -> tuple[bool, str]:
    """Gate deployment based on Datadog SLO budget remaining."""
    
    try:
        budget_remaining = get_slo_budget_remaining(slo_id)
    except Exception as e:
        # If we can't reach Datadog, fail open with a warning
        # (don't block deployments because of a monitoring outage)
        return True, f"WARNING: Could not fetch SLO state ({e}). Proceeding without SLO check."
    
    if budget_remaining < 0.10:
        return False, (
            f"BLOCKED: Datadog SLO {slo_id} for {service} has only "
            f"{budget_remaining:.1%} error budget remaining. "
            f"Deployments blocked below 10% budget threshold."
        )
    
    return True, f"SLO gate passed: {budget_remaining:.1%} budget remaining."
```

---

## Wiring the Gate Into the Pipeline

```yaml
# .github/workflows/deploy-production.yml
jobs:
  slo-gate:
    runs-on: ubuntu-22.04
    outputs:
      proceed: ${{ steps.gate.outputs.proceed }}
      message: ${{ steps.gate.outputs.message }}
    steps:
      - name: Check SLO error budget
        id: gate
        run: |
          RESULT=$(python ci/slo_gate.py \
            --service payment-api \
            --prometheus-url https://prometheus.internal \
            --environment production \
            --format json)
          
          PROCEED=$(echo $RESULT | jq -r '.proceed')
          MESSAGE=$(echo $RESULT | jq -r '.message')
          
          echo "proceed=${PROCEED}" >> $GITHUB_OUTPUT
          echo "message=${MESSAGE}" >> $GITHUB_OUTPUT
          
          echo "SLO Gate Result: ${MESSAGE}"
          
          if [[ "$PROCEED" == "false" ]]; then
            echo ""
            echo "Deployment blocked by SLO gate."
            echo "To override: re-run this workflow with OVERRIDE_SLO_GATE=true"
            echo "Override requires documented justification in the PR."
            exit 1
          fi

  # The deploy job only runs if the SLO gate passes
  deploy:
    needs: slo-gate
    if: needs.slo-gate.outputs.proceed == 'true'
    runs-on: ubuntu-22.04
    environment: production  # Manual approval gate (GitHub Environments)
    steps:
      - name: Deploy to production
        run: ./scripts/deploy.sh production ${{ github.sha }}

  # Override path: requires manual approval + documented justification
  slo-override-deploy:
    needs: slo-gate
    if: needs.slo-gate.outputs.proceed == 'false' && github.event.inputs.override_slo == 'true'
    runs-on: ubuntu-22.04
    # Stricter approval: requires SRE lead + engineering director sign-off
    environment: production-slo-override
    steps:
      - name: Log override reason
        run: |
          echo "SLO Gate Override Triggered"
          echo "Override reason: ${{ github.event.inputs.override_reason }}"
          echo "Authorized by: ${{ github.actor }}"
          echo "SLO state at override: ${{ needs.slo-gate.outputs.message }}"
          
          # Write override record to audit log
          python ci/audit_log.py \
            --event "slo_gate_override" \
            --actor "${{ github.actor }}" \
            --reason "${{ github.event.inputs.override_reason }}" \
            --slo-state "${{ needs.slo-gate.outputs.message }}"

      - name: Deploy (override)
        run: ./scripts/deploy.sh production ${{ github.sha }}
```

---

## The Organizational Contract

SLO-based gating requires clarity on two organizational questions:

**Who owns the SLO?** The team that owns the service owns the SLO. They define the target, set the alerting, and are accountable for the budget. This is the service team, not the platform team.

**Who owns the gate?** The gate is pipeline infrastructure — it belongs to the platform team. The platform team provides the gate mechanism; the service team configures the thresholds.

When these ownership lines are clear, the gate conversation is technical: "the deployment pipeline checked the SLO state and blocked because X." When they're unclear, the gate becomes political: "who decided we can't deploy?"

Document the gate policy explicitly:

```yaml
# service-slo-policy.yaml — stored in the service's repository
slo:
  target: 0.999              # 99.9% availability
  window_days: 30
  error_budget_alert_threshold: 0.50  # Alert when 50% consumed
  deployment_gate_threshold: 0.10     # Block deployments when <10% remains
  override_approvers:                  # Who can approve SLO gate overrides
    - role: sre-lead
    - role: engineering-director
  
  # When to exempt specific deployment types from SLO gating:
  exempt_deployment_types:
    - hotfix   # Emergency fixes are allowed even with exhausted budget
    - rollback # Rollbacks to a previous known-good version are always allowed
```

---

## When the SLO Gate Should Not Block

Two deployment types should always be exempt from SLO-based blocking:

**Emergency hotfixes** — if the reason the error budget is exhausted is a bug in the current version, blocking the hotfix that would fix the bug is counterproductive. The gate should require an emergency override with documented justification and accelerated approval, not an absolute block.

**Rollbacks** — rolling back to a previous known-good version can only reduce the current error rate. Blocking a rollback because the error budget is low is the worst possible outcome: the service stays broken because the pipeline refused the fix.

```python
def evaluate_deployment_gate_with_exemptions(
    service: str,
    deployment_type: str,  # "feature", "hotfix", "rollback"
    prometheus_url: str
) -> tuple[bool, str]:
    """SLO gate with exemptions for emergency and rollback deployments."""
    
    if deployment_type == "rollback":
        return True, "SLO gate bypassed: rollback deployments are always permitted."
    
    proceed, message = evaluate_deployment_gate(service, prometheus_url)
    
    if not proceed and deployment_type == "hotfix":
        # Hotfixes still require explicit acknowledgment but aren't hard-blocked
        return True, f"NOTICE: {message} — Proceeding as hotfix. Requires post-incident review."
    
    return proceed, message
```

---

## Scale Considerations

**At 1–5 services:** A simple threshold check on error budget remaining is sufficient. Query Prometheus or Datadog, check a threshold, block or proceed.

**At 5–50 services:** Per-service SLO configuration becomes important. Different services have different SLO targets and different deployment risk profiles. A core authentication service at 99.99% should gate more aggressively than a reporting service at 99.5%.

**At 50+ services:** SLO-based gating needs to be a shared platform capability — not implemented independently by each service team. The platform team provides the gate as a shared workflow step; service teams configure it via the `service-slo-policy.yaml` pattern above.

---

## The Anti-Patterns

### ❌ Anti-Pattern: No Gate, Just an Alert

**What it looks like:** Prometheus alerts on error budget burn rate. Engineers are supposed to check before deploying. They don't, because the alert is in a different channel and nobody's job it is to check.

**The fix:** Automated gates in the pipeline. The pipeline is the source of truth. If the SLO gate doesn't pass, the deployment doesn't happen — regardless of whether anyone checked the alert channel.

---

### ❌ Anti-Pattern: Gate Without Override Mechanism

**What it looks like:** The SLO gate blocks all deployments below 10% budget. There's no override path. A hotfix is needed to fix the bug that's burning the budget. The pipeline blocks the fix.

**The fix:** Every gate must have an override path with documented justification, accelerated approval, and an audit trail. The gate is a guard rail, not a wall.

---

### ❌ Anti-Pattern: Fail-Closed on Monitoring Outage

**What it looks like:** The Prometheus or Datadog query fails (monitoring is down). The gate fails closed — no deployment. The monitoring outage becomes a deployment outage.

**The fix:** Fail open on monitoring unavailability with a warning log. A monitoring outage is not a service reliability event. Gate on known bad state, not on unknown state.

---

## Field Notes

💀 **Deploying without checking error budget** → Burning the last 5% of monthly budget in 18 minutes → Add the SLO gate. The Veritas Logistics story is not rare. It's the default outcome when deployments and SLOs are managed by different teams with no automated connection between them.

💀 **Single burn rate threshold** → Transient spikes cause false blocks; slow sustained burns are missed → Use multi-window burn rate: fast/medium/slow tiers with different thresholds and different response types.

💀 **No per-service SLO policy** → The same gate thresholds apply to your core auth service and your email newsletter service → Configure gate thresholds per service based on the SLO target and the business impact of breaching it.

---

## Chapter Summary

SLO-based release gating connects the two halves of reliability engineering that are usually managed separately: the SLO that defines reliability commitments to users, and the deployment pipeline that changes the service. Without the connection, deployments happen obliviously into degraded services, burning the last of the error budget and turning a manageable incident into a monthly SLO breach.

The gate is a Prometheus or Datadog query on error budget remaining, evaluated before every production deployment. Below 10% remaining: block with override path. Below 0%: hard block, emergency-only. The mathematics of burn rate make this precise rather than approximate — you can calculate exactly how fast the service is consuming its error budget and make gating decisions accordingly.

---

## What's Next

Chapter 24 turns the feedback loop around: instead of production metrics flowing back into deployment decisions, the pipeline itself emits metrics that measure its own performance. DORA metrics — Deployment Frequency, Lead Time, Change Failure Rate, MTTR — describe how well the pipeline is serving its organization, and the right way to use them is as a feedback signal for pipeline improvement, not as a management dashboard.

[→ Next: Chapter 24 — The DORA Metrics Pipeline Feedback Pattern](./chapter-24-dora-metrics-feedback.md)

---
*[← Previous: Chapter 22 — The Shadow Deployment Pattern](../part-04-progressive-delivery/chapter-22-shadow-deployment.md) |
[→ Next: Chapter 24 — The DORA Metrics Pipeline Feedback Pattern](./chapter-24-dora-metrics-feedback.md)*
