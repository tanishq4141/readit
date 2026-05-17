# Chapter 21: The Feature Flag (Dark Launch) Pattern
*Part IV: Progressive Delivery Patterns (Safe Rollouts)*

> *"We deployed the new billing engine six weeks before we turned it on.
> It processed every billing event in shadow mode.
> We compared its output to the production engine in real time.
> On launch day, we flipped one flag. Zero issues.
> The feature was already battle-tested.
> We'd just been running it secretly."*
> — principal engineer at a payments company, describing a dark launch

---

## The War Story

The engineering team at Cascade Commerce is twelve hours from the most-hyped feature launch in company history: "Smart Checkout," a redesigned checkout flow with AI-powered product recommendations and a new payment UX. The feature has been in development for four months. It tested well in staging. The product demo to the board went flawlessly.

At 11:47 PM the night before launch, the platform engineer responsible for feature flags, Diego Reyes, runs the pre-launch verification: confirm the flag is set correctly, confirm the flag service is healthy, confirm the flag's targeting rules are correct.

The flag service returns a 503.

Diego checks the status page. The flag service — a self-hosted Unleash instance — has been down for six hours. The on-call alerts weren't configured for it. The flag service had fallen over silently, and every service in the platform had defaulted to their `falseWhenFlagServiceDown` fallback. All flags defaulted to off. All users, for the past six hours, had been seeing the old checkout flow.

The launch is scheduled for 9 AM. The flag service is the only thing standing between Cascade's users and Smart Checkout. The flag service is down.

The story ends better than it started: the infrastructure team recovers the Unleash instance at 2:30 AM, and the launch happens on schedule. But the near-miss exposes a structural problem: a single feature flag service had become a single point of failure for the entire deployment model.

This chapter covers feature flags comprehensively — including the operational requirements that the Cascade incident illustrates.

---

## What You'll Learn

- The four types of feature flags and why confusing them causes technical debt
- LaunchDarkly, Unleash, and Flagsmith compared honestly
- The flag evaluation model: client-side vs. server-side, streaming vs. polling
- Operational requirements: flag service availability, default behaviors, circuit breakers
- Flag lifecycle management: the stale flag problem and how to prevent it from accumulating
- Flags in the deployment pipeline: using flags as progressive delivery mechanisms

---

## The Four Types of Feature Flags

Treating all feature flags as the same artifact is the primary cause of flag-related technical debt. There are four distinct types with different lifecycles and different operational requirements:

**Type 1: Release Flags**
Control whether a specific feature is visible to users. Created when the feature branch merges to main. Removed when the feature reaches 100% rollout and the code path is stable. Lifespan: days to weeks.

```python
# Release flag: controlling visibility of a new UI feature
if feature_flags.variation('smart-checkout-ui', user_context, default=False):
    return render_smart_checkout(cart)
else:
    return render_legacy_checkout(cart)
```

**Type 2: Experiment Flags**
Control which variant of an experiment a user sees. Used for A/B testing. Created at experiment start. Removed when the experiment concludes and a winner is implemented permanently. Lifespan: days to weeks. Different from release flags because they require metric collection, not just on/off behavior.

```python
# Experiment flag: two variants of the recommendations algorithm
variant = feature_flags.variation('recommendations-algorithm', user_context)
if variant == 'collaborative-filtering':
    recommendations = collaborative_filter(user)
elif variant == 'content-based':
    recommendations = content_based_filter(user)
else:  # control
    recommendations = popularity_based(user)
# Note: track which variant the user saw for statistical analysis
analytics.track('recommendations_variant', {'variant': variant, 'user': user.id})
```

**Type 3: Operational Flags**
Control operational behavior of the system — kill switches, rate limits, circuit breakers. Not tied to feature releases. Created to provide operational control over a capability that might need to be disabled under specific conditions. Long lifespan: months to years. These should be permanent infrastructure.

```python
# Operational flag: kill switch for an expensive external API call
if feature_flags.variation('enable-realtime-fraud-check', context, default=True):
    fraud_score = fraud_service.check(transaction)
else:
    # Fallback: use cached model when real-time check is disabled
    fraud_score = fraud_model.score(transaction)
```

**Type 4: Permission Flags**
Control which users have access to a specific capability based on their plan, role, or entitlement. Long lifespan: permanent (for as long as the permission model exists). These are essentially access control, not deployment control.

```python
# Permission flag: enterprise-only feature
if feature_flags.variation('export-raw-data', user_context):
    return export_raw_data_endpoint()
else:
    return HttpResponse(403, "This feature requires an Enterprise subscription")
```

The lifecycle implications:
- Release flags and experiment flags are temporary. They accumulate as dead code if not cleaned up.
- Operational flags and permission flags are permanent. They should be treated as infrastructure.
- Mixing them in the same system without tracking type leads to a codebase full of `if feature_flags.variation('some-flag-from-2019')` checks with no context.

---

## Flag Evaluation: How It Works Under the Hood

Understanding how flag evaluation works is critical for understanding the failure modes and performance implications.

```
LaunchDarkly client-side evaluation (browser/mobile):

1. SDK initializes, connects to LaunchDarkly streaming endpoint
2. LD sends all flag values for this user context via Server-Sent Events
3. SDK caches flags in memory
4. flag.variation() call: synchronous lookup from in-memory cache
5. When flag changes: LD pushes update via SSE, SDK updates cache immediately

Latency: <1ms (in-memory lookup after initial connection)
Failure mode: If LD streaming is unavailable, SDK uses cached values (LDU: Last Known Good)
             Falls back to default values if no cache available

LaunchDarkly server-side evaluation (backend service):

1. SDK initializes, fetches all flag rules from LD
2. SDK receives all context attributes for the evaluation (user ID, plan, email, etc.)
3. Evaluation happens locally — all flag logic runs in the SDK process
4. No network call per flag evaluation
5. SDK polls for flag rule updates every 30 seconds (or streaming mode)

Latency: <0.1ms (local evaluation)
Failure mode: If LD is unreachable, SDK uses last fetched rules until timeout,
             then falls back to default values
```

The key insight: **modern flag SDKs do not make a network call on every flag evaluation**. The flag rules are cached locally. Evaluation is a local computation. This means flag evaluation overhead is negligible at runtime — the performance concern is the initial SDK initialization time (typically 100–300ms for the first flag fetch), not per-evaluation latency.

---

## Implementation: LaunchDarkly (Hosted)

```python
# Initialize once at application startup
import ldclient
from ldclient.config import Config

ldclient.set_config(Config(
    sdk_key=os.environ['LAUNCHDARKLY_SDK_KEY'],
    
    # stream=True: receive real-time flag updates via SSE
    # stream=False: poll every 30 seconds
    # Streaming is recommended for production — updates propagate in <1 second
    stream=True,
    
    # In-memory event buffer size.
    # Analytics events (which flag was evaluated for which user) are buffered
    # and flushed asynchronously to avoid blocking flag evaluations.
    events_max_pending=10000,
    flush_interval=5,  # Flush events every 5 seconds
    
    # Diagnostic opt-out: don't send usage data to LaunchDarkly
    diagnostic_opt_out=False
))

client = ldclient.get()

def evaluate_flag(flag_key: str, user: dict, default: any) -> any:
    """Thread-safe flag evaluation with circuit breaker."""
    
    # Build the LaunchDarkly context object
    context = ldclient.Context.builder(str(user['id'])) \
        .kind("user") \
        .set('email', user.get('email', '')) \
        .set('plan', user.get('plan', 'free')) \
        .set('country', user.get('country', '')) \
        .set('earlyAdopter', user.get('early_adopter', False)) \
        .build()
    
    # variation() returns the flag value for this context.
    # The default parameter is returned if the SDK is offline or the flag doesn't exist.
    # CRITICAL: the default must be the SAFE value — the behavior you want when the
    # flag service is unavailable.
    return client.variation(flag_key, context, default)
```

```python
# Flag evaluation with explicit safety defaults
# Every flag call must specify a safe default

# WRONG: default=True for a kill switch means the feature is ON when flags are down
result = feature_flags.variation('enable-expensive-feature', context, default=True)

# RIGHT: default=False for a feature flag (off when flags are down is safe)
result = feature_flags.variation('enable-expensive-feature', context, default=False)

# RIGHT: default=True for a kill switch (the "enabled" state is the default/safe state)
result = feature_flags.variation('enable-fraud-check', context, default=True)
# If fraud checking is normally ON and you want a kill switch to disable it:
# default=True means fraud checking stays on when the flag service is down.
# The kill switch should be rare; the normal behavior is the safe default.
```

---

## Operational Requirements: The Cascade Incident Prevented

The Cascade incident happened because the flag service was a single point of failure. Preventing it:

**Requirement 1: Circuit Breaker with Last-Known-Good Cache**

The flag SDK should cache the most recent flag evaluations and use them if the flag service becomes unavailable. Most SDKs (LaunchDarkly, Unleash) do this automatically. Verify your SDK's behavior:

```python
# Verify SDK behavior on flag service outage
def test_flag_service_unavailability():
    """SDK should return last-known values when the flag service is unreachable."""
    
    # Get the current value while flag service is up
    initial_value = client.variation('test-flag', test_context, default=False)
    
    # Simulate flag service going down
    with mock_flag_service_outage():
        # SDK should return the last known value, not the default
        outage_value = client.variation('test-flag', test_context, default=False)
        assert outage_value == initial_value, \
            "SDK must use cached values during flag service outage, not defaults"
```

**Requirement 2: Flag Service SLO and Monitoring**

The flag service must be monitored with the same rigor as any other production dependency:

```yaml
# prometheus-alerts-flagging.yaml
# Alert when the flag service is unreachable for more than 60 seconds
- alert: FlagServiceUnavailable
  expr: up{job="unleash"} == 0
  for: 1m
  labels:
    severity: critical  # Critical because it affects all deployments
  annotations:
    summary: "Feature flag service is down"
    description: "Unleash has been unreachable for >1 minute. All flags are returning last-known values or defaults."

# Alert when flag service response time is degraded
- alert: FlagServiceHighLatency
  expr: unleash_api_response_time_p99 > 500
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Feature flag service response time is elevated"
```

**Requirement 3: Flag Service HA Configuration**

For self-hosted flag services (Unleash, Flagsmith), run multiple instances:

```yaml
# unleash-deployment.yaml — high availability Unleash
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unleash
spec:
  # 3 replicas for HA — zone-aware scheduling ensures they're in different AZs
  replicas: 3
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: unleash
              topologyKey: topology.kubernetes.io/zone
      containers:
        - name: unleash
          image: unleashorg/unleash-server:latest
          # Unleash uses PostgreSQL as its backend — the database must also be HA
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: unleash-db
                  key: url
```

---

## Flag Lifecycle Management: Preventing Flag Debt

Every flag added to the codebase without a removal plan is a future maintenance burden. The accumulation of stale flags is a form of technical debt that's particularly insidious because it's invisible — the flags work correctly, they're just dead code.

### Stale Flag Detection

```python
# flag_auditor.py — identifies flags that should be cleaned up

import ldclient
from datetime import datetime, timedelta

def audit_flags():
    """Find flags that have been at 100% for >30 days (release flags ready to remove)
    or flags with no evaluations in 90 days (experiment flags that were never cleaned up)."""
    
    # Query LaunchDarkly API for all flags
    all_flags = ld_api.get('/api/v2/flags/production')
    
    stale_flags = []
    
    for flag in all_flags['items']:
        flag_key = flag['key']
        created_at = datetime.fromisoformat(flag['creationDate'])
        
        # Check evaluation count in the last 90 days
        evals_90d = get_flag_eval_count(flag_key, days=90)
        
        if evals_90d == 0 and (datetime.now() - created_at).days > 90:
            stale_flags.append({
                'key': flag_key,
                'reason': 'No evaluations in 90 days',
                'created_days_ago': (datetime.now() - created_at).days
            })
            continue
        
        # Check if flag has been at 100% for >30 days (release flag ready to remove)
        current_rollout = get_flag_rollout_percentage(flag_key)
        days_at_100 = get_days_at_percentage(flag_key, 100)
        
        if current_rollout == 100 and days_at_100 > 30:
            stale_flags.append({
                'key': flag_key,
                'reason': f'At 100% rollout for {days_at_100} days — code should be permanent',
                'action': 'Remove flag and permanent code path'
            })
    
    return stale_flags

# Run weekly, post results to Slack #tech-debt channel
stale = audit_flags()
if stale:
    post_to_slack('#tech-debt', format_stale_flag_report(stale))
```

### Flag TTL Enforcement

```yaml
# In your feature flag config (Unleash): set an expected expiry date for each flag
flag:
  name: smart-checkout-ui
  description: "Smart Checkout UI — Q3 2024 launch"
  type: release
  # expectedExpiry: engineers are alerted when this date passes without the flag being archived
  expectedExpiry: 2024-10-15
  tags:
    - team: checkout
    - quarter: Q3-2024
```

CI check that fails if any flag is past its expected expiry:

```bash
# In CI pipeline: verify no flags are past their TTL
unleash-cli list-flags --project my-project --format json | \
  jq '[.[] | select(.expectedExpiry < now | strftime("%Y-%m-%d") and .archived == false)]' | \
  jq 'if length > 0 then error("Expired flags found: \(.)") else "All flags current" end'
```

---

## Flags in the Deployment Pipeline

Feature flags integrate with the deployment pipeline in two ways:

**Integration 1: Pipeline-controlled flag state**

The deployment pipeline sets flag values as part of the deployment process:

```yaml
# deployment-pipeline.yml
- name: Enable feature for Ring 0
  if: "${{ github.ref == 'refs/heads/main' }}"
  run: |
    # After successful deployment, enable the flag for Ring 0 (internal users)
    curl -X PATCH https://app.launchdarkly.com/api/v2/flags/production/smart-checkout-ui \
      -H "Authorization: ${{ secrets.LD_API_KEY }}" \
      -H "Content-Type: application/json" \
      -d '{
        "comment": "Automated: enable Ring 0 after successful deployment ${{ github.sha }}",
        "patch": [
          {
            "op": "replace",
            "path": "/environments/production/rules/0/clauses/0/values",
            "value": ["@mycompany.com"]
          }
        ]
      }'
```

**Integration 2: Flags as deployment gates**

Before a flag is enabled for a new ring, verify the deployment is stable:

```python
# ring_gate.py — verify deployment health before enabling flag for next ring
def gate_ring_promotion(flag_key: str, from_ring: str, to_ring: str):
    """Verify deployment health before promoting a flag to the next ring."""
    
    # Check that the current ring has been stable for the required dwell time
    dwell_requirement = RING_DWELL_REQUIREMENTS[f"{from_ring}_to_{to_ring}"]
    
    ring_enabled_at = get_flag_ring_enabled_at(flag_key, from_ring)
    hours_elapsed = (datetime.now() - ring_enabled_at).total_seconds() / 3600
    
    if hours_elapsed < dwell_requirement:
        print(f"Dwell time not met: {hours_elapsed:.1f}h of {dwell_requirement}h required")
        return False
    
    # Check health metrics for current ring users
    ring_user_segment = get_ring_user_segment(from_ring)
    health = evaluate_ring_health(flag_key, ring_user_segment)
    
    if not health.is_healthy:
        print(f"Ring health check failed: {health.reason}")
        return False
    
    print(f"Ring gate passed. Promoting {flag_key} from {from_ring} to {to_ring}.")
    return True
```

---

## The Anti-Patterns

### ❌ Anti-Pattern: Flag Service as Single Point of Failure

**What it looks like:** One Unleash instance, no HA, no monitoring. When it goes down, flags return defaults. Nobody notices until a scheduled flag change doesn't happen.

**The fix:** 3-replica HA deployment, health monitoring with alerts, SDK configured to use cached last-known-good values.

---

### ❌ Anti-Pattern: `default=False` for Operational Kill Switches

**What it looks like:** `feature_flags.variation('enable-fraud-detection', context, default=False)`. When the flag service goes down, fraud detection turns off. This is the opposite of what you want from a safety control.

**The fix:** Kill switches for safety-critical features must have `default=True` (the safe behavior). The flag is a switch to disable the feature in an emergency, not to enable it. When the flag service is unavailable, safety features stay on.

---

### ❌ Anti-Pattern: Never Cleaning Up Flags

**What it looks like:** 600 flags in production. 400 are from features that shipped to 100% two years ago. The code still has `if feature_flags.variation('old-flag-2021')` checks that always evaluate to `True`.

**What breaks:** Codebase readability, cognitive overhead for every engineer reading flag-gated code, and the implicit complexity ceiling on flag infrastructure.

**The fix:** Weekly stale flag audit, TTL on every flag at creation, `expectedExpiry` enforcement in CI.

---

## Field Notes

💀 **Flag service down with no cached state** → All flags return defaults simultaneously — features disabled, kill switches activated, chaos → Verify SDK caching behavior before production. Run a flag service outage drill.

💀 **`default=False` on a safety control** → Flag service goes down, safety control deactivates → Safety controls default to ON. Use flags as kill switches (defaulting to safe behavior), not activation switches.

💀 **Flags for configuration** → `feature_flags.variation('max-retry-count', context, 3)` → Feature flags are for feature control, not configuration. Use a config service or environment variables for configuration values. Flags add operational complexity that config doesn't need.

---

## Chapter Summary

Feature flags are the operational mechanism that decouples code deployment from feature release. Code ships dark; the flag is the activation lever. This decoupling gives you instant rollback (flip the flag), controlled rollout (percentage-based targeting), user segment control (ring deployment via flags), and experimentation capability — all without a deployment.

The infrastructure requirements are real: the flag service must be HA, monitored, and have well-defined fallback behavior. The lifecycle management requirements are real: flags accumulate as dead code without active cleanup. And the type taxonomy matters: release flags, experiment flags, operational flags, and permission flags have different lifespans and different operational requirements. Treating them all the same creates the unmaintainable flag graveyard that characterizes mature codebases where flags were added without a removal strategy.

---

## What's Next

Chapter 22 covers Shadow Deployment — the pattern for validating a new service version against real production traffic without any impact on real users. Shadow deployments are the most rigorous pre-canary validation mechanism: every production request is duplicated to the new version, responses are compared, and discrepancies are logged — all without the new version ever affecting what users see.

[→ Next: Chapter 22 — The Shadow Deployment Pattern](./chapter-22-shadow-deployment.md)

---
*[← Previous: Chapter 20 — The Ring Deployment Pattern](./chapter-20-ring-deployment.md) |
[→ Next: Chapter 22 — The Shadow Deployment Pattern](./chapter-22-shadow-deployment.md)*
