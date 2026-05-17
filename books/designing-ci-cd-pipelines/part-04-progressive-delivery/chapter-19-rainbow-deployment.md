# Chapter 19: The Rainbow Deployment Pattern
*Part IV: Progressive Delivery Patterns (Safe Rollouts)*

> *"We support v3, v4, and v5 of the API. Different enterprise customers
> are pinned to different versions by contract. We can't deprecate on our
> timeline — we deprecate on theirs. The rainbow isn't optional.
> It's the business model."*
> — platform engineer at a B2B SaaS company, 2022

---

## The War Story

DataSync is a B2B data integration platform. Their API has enterprise customers on three-year contracts. The contracts specify minimum supported API versions. When DataSync releases a new API version (v4), their oldest customers don't migrate immediately — some won't migrate at all within the contract term. DataSync's first instinct was to maintain a separate deployment per API version. Three separate production clusters. Three separate deployment pipelines. Three separate on-call rotations.

By the time they had v3, v4, and v5 in simultaneous production, the operational cost was significant: three sets of deployments to manage, three sets of infrastructure costs, three code paths to maintain in parallel. Most painfully: a security patch had to be applied to all three independently, and the patches had to be coordinated so that no customer experienced a window where one version was patched and theirs wasn't.

The engineering team's second approach: multi-version concurrency within a single deployment. One Kubernetes cluster. One set of infrastructure. N versions of the application running simultaneously, with traffic routing that sends each customer to the version their contract specifies. The "rainbow" is the N-color version of blue-green: instead of two environments (blue/green), there are N environments (one per active version).

This chapter covers when to use this pattern, how to implement it, and — crucially — how to manage its operational complexity before it consumes more engineering time than the problem it solves.

---

## What You'll Learn

- When rainbow deployment is the right choice vs. blue-green, canary, or version flags
- Implementing N-version routing with Kubernetes and Istio
- The multi-version database problem: how to share a database across incompatible schema versions
- Operational cost: how to track and bound the number of concurrent versions
- The API versioning strategy that makes rainbow deployment sustainable
- Deprecation enforcement: how to drive customer migration without breaking contracts

---

## When Rainbow Deployment Is the Right Pattern

Rainbow deployment is appropriate in three specific scenarios:

**Scenario 1: Contractually bound multi-version support.** Enterprise customers with SLAs that specify minimum API version support. They cannot be forced to migrate on your timeline. DataSync's case.

**Scenario 2: Multi-version A/B/C testing.** Experiments that compare more than two variants. A/B testing (two variants) doesn't need rainbow deployment — canary handles it. Testing three pricing models simultaneously requires three concurrent versions.

**Scenario 3: Gradual migration for clients you don't control.** Mobile apps, third-party integrations, or public APIs where you can't force a client upgrade. Old clients continue using v3; new clients use v4; power users use v5.

Rainbow deployment is NOT appropriate when:
- You can control client upgrade timing (use a canary instead)
- The versions differ only by feature flags (use feature flags instead; Chapter 21)
- The versions have incompatible databases (the complexity is prohibitive; use API versioning with a compatibility layer instead)

---

## Implementation: N-Version Kubernetes + Istio

Each version runs as a separate Kubernetes Deployment with version-labeled pods. An Istio VirtualService routes to the appropriate version based on request headers or path prefix.

```yaml
# deployments for each active version
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: datasync-api-v3
  namespace: datasync
spec:
  replicas: 3
  selector:
    matchLabels:
      app: datasync-api
      version: "v3"
  template:
    metadata:
      labels:
        app: datasync-api
        version: "v3"
    spec:
      containers:
        - name: api
          image: myregistry.io/datasync-api:v3.8.2  # latest v3 patch
          env:
            - name: API_VERSION
              value: "v3"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: datasync-api-v4
  namespace: datasync
spec:
  replicas: 5
  selector:
    matchLabels:
      app: datasync-api
      version: "v4"
  template:
    metadata:
      labels:
        app: datasync-api
        version: "v4"
    spec:
      containers:
        - name: api
          image: myregistry.io/datasync-api:v4.3.1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: datasync-api-v5
  namespace: datasync
spec:
  replicas: 8
  selector:
    matchLabels:
      app: datasync-api
      version: "v5"
  template:
    metadata:
      labels:
        app: datasync-api
        version: "v5"
    spec:
      containers:
        - name: api
          image: myregistry.io/datasync-api:v5.1.0
```

```yaml
# virtualservice-rainbow.yaml
# Routes requests to the appropriate version based on URL path
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: datasync-api
  namespace: datasync
spec:
  hosts:
    - api.datasync.io
  http:
    # Route /v3/* to v3 pods
    - match:
        - uri:
            prefix: /v3/
      route:
        - destination:
            host: datasync-api
            subset: v3

    # Route /v4/* to v4 pods
    - match:
        - uri:
            prefix: /v4/
      route:
        - destination:
            host: datasync-api
            subset: v4

    # Route /v5/* to v5 pods
    - match:
        - uri:
            prefix: /v5/
      route:
        - destination:
            host: datasync-api
            subset: v5

    # Header-based routing: for clients that pass X-Api-Version header
    # (allows version routing without URL path changes)
    - match:
        - headers:
            x-api-version:
              exact: "v3"
      route:
        - destination:
            host: datasync-api
            subset: v3

    # Default: route to latest stable version
    - route:
        - destination:
            host: datasync-api
            subset: v5
---
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: datasync-api
  namespace: datasync
spec:
  host: datasync-api
  subsets:
    - name: v3
      labels:
        version: "v3"
    - name: v4
      labels:
        version: "v4"
    - name: v5
      labels:
        version: "v5"
```

---

## The Multi-Version Database Problem

The hardest part of rainbow deployment is the database. Three API versions running simultaneously against one database means the schema must satisfy all three versions simultaneously.

| Table | v3 ORM | v4 ORM | v5 ORM | Notes |
|-------|:------:|:------:|:------:|-------|
| users | ✓ | ✓ | ✓ | No changes; all versions compatible |
| connections | ✓ | ✓ | ✓ | v4 added columns but kept v3 columns |
| pipelines | ✓ | ✓ | ✗ | v5 renamed a column — **incompatible** |

When a schema change is incompatible across versions, you have two options:

**Option A: API versioning with transformation layer.** The database schema follows the latest version. Older API versions have a transformation layer that maps between the current schema and their expected schema. Complex but allows the database to evolve independently.

```python
# v3 API handler — transforms v5 schema back to v3 response format
class V3PipelineResource:
    def get(self, pipeline_id: int) -> dict:
        # Query using v5 schema column names
        pipeline = db.query(
            "SELECT id, pipeline_name, config_json FROM pipelines WHERE id = %s",
            pipeline_id
        )
        # Transform to v3 response format (which expected "name" not "pipeline_name")
        return {
            'id': pipeline['id'],
            'name': pipeline['pipeline_name'],  # v3 called it 'name', v5 calls it 'pipeline_name'
            'config': pipeline['config_json']
        }
```

**Option B: Schema version locking.** Maintain the database at the oldest supported schema version. New versions must be backward-compatible with the oldest schema you support. Simpler but constrains schema evolution.

Option A is more flexible but requires maintaining transformation code for every incompatibility between version N and the current schema. The transformation code must be tested for every schema migration. The complexity grows with the number of versions and the number of schema changes between them.

The honest advice: **rainbow deployment is only sustainable when API versioning is done correctly from the start** — which means additive changes (new fields, new endpoints) are the norm and breaking changes (renamed fields, removed fields, changed types) are rare and require a formal deprecation process with sunset dates.

---

## Operational Complexity: Bounding Version Count

The rainbow pattern's operational cost scales with the number of concurrent versions. Four versions is manageable. Eight versions is an engineering tax that consumes more engineering time than the problem it solves.

Track the version distribution to know when to enforce deprecation:

```python
# Weekly version distribution report — run as a cron job
# Queries access logs or metrics to find the request distribution per version

import boto3
from datetime import datetime, timedelta

def version_distribution_report():
    client = boto3.client('logs', region_name='us-east-1')
    
    # Query CloudWatch Logs Insights for version usage in the past 30 days
    response = client.start_query(
        logGroupName='/aws/alb/datasync-production',
        startTime=int((datetime.now() - timedelta(days=30)).timestamp()),
        endTime=int(datetime.now().timestamp()),
        queryString="""
        fields @timestamp, request
        | parse request "* /v*/  *" as method, api_version, rest
        | stats count(*) as requests by api_version
        | sort requests desc
        """
    )
    
    # Poll for results and format as a deprecation-decision report
    results = poll_for_results(client, response['queryId'])
    
    total = sum(int(r['requests']) for r in results)
    
    print("API Version Usage (last 30 days):")
    for row in results:
        version = row.get('api_version', 'unknown')
        count = int(row['requests'])
        pct = count / total * 100
        status = "DEPRECATION CANDIDATE" if pct < 2.0 else "active"
        print(f"  {version}: {count:,} requests ({pct:.1f}%) — {status}")
```

**Deprecation policy:** Any version accounting for less than 2% of requests for 90 consecutive days is eligible for deprecation. Customers using that version receive 6-months notice. After the sunset date, the version deployment is removed.

This policy creates a bounded version count: as long as you're adding one new version per year and deprecating one per year, the concurrent version count stays constant.

---

## Deploying Updates to Rainbow Versions

Security patches must be applied to every active version. This is the highest-maintenance cost of the rainbow pattern. Automate it:

```yaml
# .github/workflows/rainbow-security-patch.yml
# Applies a security patch to all active API versions simultaneously
name: Apply Security Patch to All Versions

on:
  workflow_dispatch:
    inputs:
      patch_tag:
        description: 'Security patch commit SHA'
        required: true

jobs:
  patch-matrix:
    strategy:
      # fail-fast: false — apply to all versions, don't stop if one fails
      fail-fast: false
      matrix:
        version: [v3, v4, v5]
    
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ matrix.version }}-maintenance  # Long-lived maintenance branch per version

      - name: Cherry-pick security patch
        run: |
          git cherry-pick ${{ inputs.patch_tag }}
          git push

      - name: Build patched image
        run: |
          docker build -t myregistry.io/datasync-api:${{ matrix.version }}-patched-${{ inputs.patch_tag }} .
          docker push myregistry.io/datasync-api:${{ matrix.version }}-patched-${{ inputs.patch_tag }}

      - name: Deploy to production
        run: |
          kubectl set image deployment/datasync-api-${{ matrix.version }} \
            api=myregistry.io/datasync-api:${{ matrix.version }}-patched-${{ inputs.patch_tag }} \
            -n datasync
          kubectl rollout status deployment/datasync-api-${{ matrix.version }} \
            -n datasync --timeout=5m
```

---

## Scale Considerations

**At 2 versions:** This is just blue-green with a longer tail. Keep the old version running while the new one gets adoption. Standard stuff.

**At 3–4 versions:** The rainbow pattern is manageable with automated deployment pipelines for each version and the deprecation policy in place.

**At 5+ versions:** Operational cost compounds. Each new version adds a Deployment to manage, a deployment pipeline to maintain, a database compatibility concern to track, and a monitoring dashboard to watch. At this scale, the investment in a transformation layer (Option A above) pays off — it lets the database and the internal service model evolve independently while maintaining backward-compatible API responses for all versions.

**The controversial take:** Most organizations that believe they need rainbow deployment don't — they need better feature flags and API versioning discipline. Rainbow deployment is appropriate when different customers contractually require different behavior. It's inappropriate as a substitute for building backward-compatible APIs in the first place.

---

## The Anti-Patterns

### ❌ Anti-Pattern: Rainbow Without a Deprecation Policy

**What it looks like:** Versions are never removed. v2, v3, v4, v5, v6 all run simultaneously, indefinitely. The engineering team spends 20% of sprint capacity maintaining compatibility patches across six versions.

**Why it happens:** Removing a version requires customer migration. Customer migration is uncomfortable. Teams defer the conversation.

**What breaks:** Engineering velocity. The team that deploys v7 must maintain backward compatibility with v2. The schema cannot evolve because v2 is still running.

**The fix:** Hard sunset dates in every version announcement. Two years of support, four months notice, no exceptions. The deprecation policy is a business commitment, not an engineering preference.

---

### ❌ Anti-Pattern: Different Databases per Version

**What it looks like:** v3, v4, and v5 each have their own database. Data is replicated between them.

**Why it happens:** Avoids the schema compatibility problem.

**What breaks:** Data consistency. A write to v4's database must propagate to v3 and v5. The replication lag means different API versions can serve different data for the same customer. This is operationally worse than the schema compatibility problem.

**The fix:** One database, backward-compatible schema changes, transformation layers for breaking API contract differences.

---

## Field Notes

💀 **No version usage metrics** → Version deprecation decisions are political, not data-driven → Instrument your load balancer or API gateway to emit per-version request counts. Weekly report. Make deprecation a data-driven conversation.

💀 **Security patches applied to active versions manually** → Patches arrive at different times for different versions; customers on v3 have a vulnerability window → Automate security patches with the cherry-pick matrix workflow. All versions patched simultaneously.

💀 **"We'll add rainbow routing later"** → API versioning debt accumulates until it's too late to implement cleanly → Design your routing strategy before you need more than two concurrent versions. The time to implement the routing layer is before your first breaking API change, not after.

---

## Chapter Summary

Rainbow deployment is a specific-purpose tool for organizations that must maintain multiple API versions simultaneously due to contractual obligations or client distribution beyond their control. It solves the multi-version problem by running N deployments of the same application with N-aware routing in front of them.

The operational complexity is real and grows linearly with version count. The pattern is only sustainable with an enforced deprecation policy that bounds the version count, automated security patch propagation, and backward-compatible schema design that prevents the database from becoming the bottleneck on version evolution.

For teams that don't have contractual obligations to specific versions, the feature flag pattern (Chapter 21) provides most of the same multi-variant capability at a fraction of the operational cost.

---

## What's Next

Chapter 20 covers Ring Deployment — the pattern Microsoft uses for Windows, Office, and Azure updates. Unlike canary (random percentage routing) and rainbow (version-specific routing), rings use user segment routing: internal dogfood, early adopter, general availability. The ring is defined by who the user is, not by what percentage of traffic they represent.

[→ Next: Chapter 20 — The Ring Deployment Pattern](./chapter-20-ring-deployment.md)

---
*[← Previous: Chapter 18 — The Canary Release Pattern](./chapter-18-canary-release.md) |
[→ Next: Chapter 20 — The Ring Deployment Pattern](./chapter-20-ring-deployment.md)*
