# Chapter 12: The Ephemeral Environment Pattern
*Part III: Delivery & Deployment Patterns (CD)*

> *"We had one staging environment. Seventeen developers shared it.
> On any given Tuesday afternoon, at least two people had
> broken migrations in flight. Nobody was testing anything.
> We called it 'staging.' It was a controlled chaos machine."*
> — engineering manager at a Series B startup, 2021

---

## The War Story

The shared staging environment at Luminary Labs has a reputation. Engineers have a Slack channel called `#staging-issues` that processes, on average, 40 messages per day. The messages follow a pattern: "staging is broken," "did someone run a migration?", "who owns the broken deployment in staging right now?", "staging is back," "staging is broken again."

Three weeks before a major customer launch, the situation comes to a head. The product team has scheduled daily demos on staging for a key prospect. The engineering team is in crunch, pushing 25 PRs per day. On the day of the first demo, two engineers have in-flight migrations running simultaneously — one adding a column, one renaming a table. The combined effect: a foreign key constraint violation that takes staging down completely at 2:47 PM, 13 minutes before the demo.

The demo is moved to a recording from last week.

In the postmortem, the CTO asks a question: "Why do we have one staging environment for seventeen developers?" The engineering manager doesn't have a good answer. "That's how we've always done it" is the answer that's not given, but everyone in the room is thinking it.

The migration to ephemeral per-PR environments takes six weeks. After the migration, the `#staging-issues` channel is renamed `#staging-kudos` (briefly) and then archived when no one needs it anymore. Each PR gets its own environment. Migrations run in isolation. The shared staging environment is retained for integration tests but is no longer the primary testing surface.

This chapter covers how to build that migration.

---

## What You'll Learn

- The three implementation approaches for ephemeral environments: namespace-per-branch, Argo CD ApplicationSets, and cluster-per-PR — and when each is appropriate
- Database handling in ephemeral environments: seeding, migrations, and the isolation strategies that prevent the cascading failure Luminary Labs experienced
- Cost containment: how to prevent ephemeral environments from becoming a $50,000/month AWS bill surprise
- The environment lifecycle: creation on PR open, updates on commit, teardown on PR close
- Shared service stubs and service virtualization: how to provide external dependencies without hitting real production APIs

---

## The Three Implementation Approaches

### Approach 1: Namespace-per-Branch (Kubernetes)

Each PR gets its own Kubernetes namespace. All workloads for the PR run in that namespace. Services address each other via namespace-scoped DNS (`payment-api.pr-1234.svc.cluster.local`). The namespace is created when the PR is opened and deleted when it closes.

**When to use:** Monorepo deployments where all services belong to the same team, Kubernetes is already in use, and you need strong isolation between PR environments.

**When not to use:** When each service has its own repo (namespace isolation requires multi-repo coordination), or when the environments need persistent storage that's expensive to provision per-PR.

```yaml
# .github/workflows/ephemeral-env.yml
name: Ephemeral Environment

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  create-or-update:
    if: github.event.action != 'closed'
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - name: Set environment name
        run: |
          # Namespace name: pr-{number}, truncated and sanitized.
          # Kubernetes namespace names must be lowercase, max 63 chars.
          PR_NUM="${{ github.event.number }}"
          ENV_NAME="pr-${PR_NUM}"
          echo "ENV_NAME=${ENV_NAME}" >> $GITHUB_ENV

      - name: Create namespace
        run: |
          kubectl create namespace ${ENV_NAME} --dry-run=client -o yaml | kubectl apply -f -

          # Label the namespace for tracking and cost allocation.
          # These labels are used by the cleanup job and cost reporting.
          kubectl label namespace ${ENV_NAME} \
            app.kubernetes.io/managed-by=ci \
            pr-number="${{ github.event.number }}" \
            pr-branch="${{ github.head_ref }}" \
            created-by="${{ github.actor }}" \
            created-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --overwrite

      - name: Deploy application
        run: |
          # Kustomize overlay for ephemeral environments.
          # Substitutes the namespace, image tag, and environment-specific config.
          kustomize build k8s/overlays/ephemeral | \
            sed "s|NAMESPACE_PLACEHOLDER|${ENV_NAME}|g" | \
            sed "s|IMAGE_TAG_PLACEHOLDER|${{ github.sha }}|g" | \
            kubectl apply -n ${ENV_NAME} -f -

      - name: Wait for deployment
        run: |
          kubectl rollout status deployment/app -n ${ENV_NAME} --timeout=5m

      - name: Post environment URL to PR
        uses: actions/github-script@v7
        with:
          script: |
            const envName = process.env.ENV_NAME;
            const envUrl = `https://${envName}.preview.myapp.com`;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 Preview environment deployed: [${envUrl}](${envUrl})\n\nEnvironment: \`${envName}\` | Commit: \`${{ github.sha }}\``
            });

  teardown:
    if: github.event.action == 'closed'
    runs-on: ubuntu-22.04
    steps:
      - name: Delete namespace
        run: |
          ENV_NAME="pr-${{ github.event.number }}"
          kubectl delete namespace ${ENV_NAME} --ignore-not-found=true
          echo "Ephemeral environment ${ENV_NAME} deleted."
```

### Approach 2: Argo CD ApplicationSets

Argo CD's ApplicationSet controller generates Argo CD Applications dynamically from a template and a generator. The Pull Request generator creates one Application per open PR, targeting a namespace or cluster based on PR metadata.

```yaml
# applicationset-pr-preview.yaml
# Stored in the GitOps config repo. Creates one Argo CD Application per open PR.
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-preview
  namespace: argocd
spec:
  # The Pull Request generator queries GitHub for open PRs.
  # For each open PR, it generates parameters that the template uses.
  generators:
    - pullRequest:
        github:
          owner: myorg
          repo: my-app
          tokenRef:
            secretName: github-token
            key: token
          # Only generate environments for PRs labeled 'preview'.
          # This prevents every draft PR from getting an environment.
          labels:
            - preview
        # Poll GitHub for new/closed PRs every 5 minutes.
        requeueAfterSeconds: 300

  template:
    metadata:
      # Application name includes PR number for uniqueness.
      name: 'pr-preview-{{number}}'
    spec:
      project: previews

      source:
        repoURL: https://github.com/myorg/k8s-config
        targetRevision: '{{head_sha}}'  # Deploy the specific PR commit
        path: apps/my-app/preview
        # Kustomize patches inject PR-specific values
        kustomize:
          namePrefix: 'pr-{{number}}-'
          commonLabels:
            pr-number: '{{number}}'
          images:
            - 'myregistry.io/my-app:{{head_sha}}'

      destination:
        server: https://kubernetes.default.svc
        # Each PR gets its own namespace
        namespace: 'pr-{{number}}'

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true

      # Annotations for the PR comment bot — it reads these to post the URL
      info:
        - name: PR URL
          value: '{{htmlUrl}}'
        - name: Preview URL
          value: 'https://pr-{{number}}.preview.myapp.com'
```

ApplicationSets are the right approach when you're already using Argo CD, want the preview environment managed by the same GitOps tooling as production, and want visibility into preview environment sync status in the Argo CD UI.

### Approach 3: Cluster-per-PR (Heavy Isolation, High Cost)

For regulated environments, security testing, or applications that can't share a cluster, each PR gets its own ephemeral cluster. This is the approach used by some regulated financial services firms where even namespace isolation in a shared cluster doesn't satisfy compliance requirements.

Tools: `kind` (Kubernetes in Docker, free but limited), vCluster (virtual clusters inside a host cluster, cost-efficient), or AWS EKS on-demand (full isolation, expensive).

```bash
# Create a virtual cluster for PR #1234 using vCluster
# vCluster runs inside the host cluster as a StatefulSet but provides
# a separate API server, separate namespace, and full cluster isolation.
vcluster create pr-1234 \
  --namespace vcluster-pr-1234 \
  --connect=false \
  --values - <<EOF
syncer:
  extraArgs:
    - --tls-san=pr-1234.preview.myapp.com
service:
  type: LoadBalancer
EOF

# Connect and deploy to the virtual cluster
vcluster connect pr-1234 --namespace vcluster-pr-1234 -- \
  kubectl apply -f k8s/overlays/preview/
```

vCluster costs: the virtual cluster's workloads run on the host cluster's nodes. You pay for the actual compute consumed, not for a full dedicated cluster. A typical development environment vCluster uses 0.5–2 CPU and 1–4GB RAM at idle — manageable at scale.

---

## Database Handling: The Hard Part

Databases are the part of ephemeral environments that tutorials skip. Every approach has trade-offs.

### Option A: Seeded Database per PR (Recommended for Most Teams)

Each ephemeral environment gets its own database instance, pre-seeded with a consistent dataset from a snapshot or seed script.

```yaml
# k8s/overlays/preview/postgres.yaml
# Ephemeral PostgreSQL — runs inside the PR namespace, destroyed with it
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1  # Never HA for ephemeral envs — single node is fine
  selector:
    matchLabels:
      app: postgres
  template:
    spec:
      initContainers:
        # Seed the database on startup with a fixed dataset.
        # The seed data is a pg_dump snapshot stored in the registry or S3,
        # representing a consistent anonymized test dataset.
        - name: db-seeder
          image: myregistry.io/db-seeder:latest
          env:
            - name: SEED_DATASET
              value: "preview-seed-v3"  # Versioned seed — update when schema changes
          command:
            - /bin/sh
            - -c
            - |
              psql -U postgres -c "CREATE DATABASE app;"
              aws s3 cp s3://mycompany-seeds/preview-seed-v3.sql.gz - | \
                gunzip | psql -U postgres -d app
      containers:
        - name: postgres
          image: postgres:16.1-alpine@sha256:...  # Pinned digest
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "1Gi"
          # Ephemeral storage — no PVC. Data lives only as long as the pod.
          # This is correct for preview environments: we don't want test data
          # to persist, and provisioning PVCs adds latency and cost.
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: postgres-data
          emptyDir: {}
```

The seed snapshot: maintain a weekly-updated anonymized snapshot of production data, stored in S3. The snapshot is the foundation of the ephemeral database. PRs that add migrations run the migration against the seeded snapshot — so migration testing uses realistic data.

### Option B: Shared Database with PR-Specific Schema

All ephemeral environments share a single database server, but each gets its own schema (PostgreSQL) or database (MySQL). Cheaper and faster to provision, but requires the application to support configurable schema names.

```python
# In application config — support schema prefix for multi-tenant testing
import os
# PREVIEW_SCHEMA is set in the ephemeral environment's ConfigMap.
# Production uses the default schema; preview environments use pr_{number}_
DB_SCHEMA = os.environ.get('PREVIEW_SCHEMA', 'public')
```

### Option C: Stubs / Service Virtualization for External APIs

The database is the internal service that's hardest to fake. External APIs (Stripe, Twilio, SendGrid) are easier — use stubbed services:

```yaml
# k8s/overlays/preview/stubs.yaml
# WireMock stub server — records and replays real API responses
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stripe-stub
spec:
  template:
    spec:
      containers:
        - name: wiremock
          image: wiremock/wiremock:3.3.1
          args:
            - --port=8080
            - --root-dir=/stubs  # Pre-recorded Stripe API responses
          volumeMounts:
            - name: stripe-stubs
              mountPath: /stubs
      volumes:
        - name: stripe-stubs
          configMap:
            name: stripe-stub-responses
---
# In the app's ConfigMap for preview environments:
# STRIPE_BASE_URL=http://stripe-stub:8080
# Calls to Stripe hit the stub, not the real API.
# No test charges on real payment infrastructure.
```

---

## Cost Containment: Preventing the $50k Surprise

Ephemeral environments create an unbounded cost surface if not actively managed. The failure mode: a team creates 200 ephemeral environments for 200 open PRs, forgets to add teardown automation, and discovers $180,000 in cloud costs at the end of the quarter.

### Strategy 1: Automatic Teardown on PR Close

The teardown must be automatic and unconditional. Human teardown is unreliable — engineers forget, leave the company, or assume someone else will clean up.

```yaml
# GitHub Actions workflow triggered on PR close
on:
  pull_request:
    types: [closed]  # Fires on both merge AND abandon

jobs:
  teardown:
    runs-on: ubuntu-22.04
    steps:
      - name: Delete ephemeral environment
        run: |
          kubectl delete namespace pr-${{ github.event.number }} \
            --ignore-not-found=true
          # Also clean up any cloud resources (load balancers, DNS records)
          # that were provisioned for this environment.
          aws route53 change-resource-record-sets \
            --hosted-zone-id $ZONE_ID \
            --change-batch "{
              \"Changes\": [{
                \"Action\": \"DELETE\",
                \"ResourceRecordSet\": {
                  \"Name\": \"pr-${{ github.event.number }}.preview.myapp.com\",
                  \"Type\": \"A\",
                  \"TTL\": 300,
                  \"ResourceRecords\": [{\"Value\": \"$LB_IP\"}]
                }
              }]
            }" 2>/dev/null || true  # Ignore error if record doesn't exist
```

### Strategy 2: Idle Detection and Auto-Sleep

An ephemeral environment that receives no traffic for 2 hours is probably not being actively tested. Scale it to zero:

```bash
# Nightly cron job: scale down idle preview environments
# "Idle" = no HTTP requests in the last 2 hours (from access log metrics)
kubectl get namespaces -l app.kubernetes.io/managed-by=ci -o json | \
  jq -r '.items[] | select(.metadata.labels["created-at"] | 
    (now - (. | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime)) > 7200) | 
    .metadata.name' | \
while read ns; do
  # Scale all deployments to 0 in the idle namespace
  kubectl scale deployment --all --replicas=0 -n "$ns"
  kubectl label namespace "$ns" state=sleeping --overwrite
done
```

### Strategy 3: Maximum Environment Age

Any ephemeral environment older than 7 days is probably for a PR that was abandoned. Delete it:

```bash
# Delete namespaces older than 7 days
CUTOFF=$(date -d '7 days ago' -u +%Y-%m-%dT%H:%M:%SZ)

kubectl get namespaces -l app.kubernetes.io/managed-by=ci -o json | \
  jq -r --arg cutoff "$CUTOFF" \
  '.items[] | select(.metadata.labels["created-at"] < $cutoff) | .metadata.name' | \
while read ns; do
  echo "Deleting stale environment: $ns"
  kubectl delete namespace "$ns"
done
```

### Strategy 4: Resource Limits and LimitRanges

Every preview namespace gets a LimitRange and ResourceQuota applied at creation. This prevents a single PR from consuming disproportionate cluster resources:

```yaml
# Applied to every pr-* namespace at creation
apiVersion: v1
kind: ResourceQuota
metadata:
  name: preview-quota
spec:
  hard:
    requests.cpu: "2"      # Max 2 CPU for the entire preview environment
    requests.memory: 4Gi   # Max 4GB RAM
    limits.cpu: "4"
    limits.memory: 8Gi
    persistentvolumeclaims: "2"  # Max 2 PVCs (don't spin up large disks)
    services.loadbalancers: "1"  # One load balancer per preview
```

---

## When Ephemeral Environments Break

### Break Mode 1: Slow Provisioning

If it takes 8 minutes to provision an ephemeral environment, developers won't use it — they'll push multiple commits and wait, or test locally. Target <3 minutes from PR push to environment available.

Speed-ups: pre-pulled container images on cluster nodes (reduced image pull time by 60–80%), a database snapshot that restores in seconds rather than a full seed import, Kubernetes `startupProbe` tuning to reduce deployment readiness wait time.

### Break Mode 2: Environment Parity Gaps

The ephemeral environment uses a different database version, a different Redis, or stubs for services that production uses. Tests pass in the ephemeral environment; bugs appear in production. This is the same problem shared staging has, just smaller blast radius.

Maintain a parity checklist: ephemeral vs. staging vs. production versions of each service dependency. Automate version comparison in the provisioning pipeline.

### Break Mode 3: Cost Runaway from External Resources

Databases, load balancers, DNS records, and SSL certificates created for ephemeral environments can outlive the namespace if teardown is incomplete. External resources that aren't tracked in Kubernetes (managed RDS instances, ALBs) don't get deleted when the namespace is deleted.

Use tagging: every AWS resource created for a PR environment gets tagged `pr-number=1234`. A daily cleanup job scans for tagged resources older than N days and destroys them. AWS Resource Groups and tag-based cost allocation make this visible in the billing console.

---

## The Anti-Patterns

### ❌ Anti-Pattern: Shared Staging for Developer Testing

**What it looks like:** One staging environment shared by all developers. It's frequently broken. Multiple developers' in-progress work runs simultaneously. Testing on staging gives unreliable signal.

**Why it happens:** It's the traditional model. One environment was sufficient when there was one developer.

**What breaks:** Developer productivity, testing confidence, and the sanity of anyone responsible for maintaining "stable staging."

**The fix:** Per-PR ephemeral environments for developer testing. Shared staging becomes the integration environment where the full application is tested as a unit — not where individual PRs are tested.

---

### ❌ Anti-Pattern: No Cost Controls on Preview Environments

**What it looks like:** Ephemeral environments are provisioned with the same resource allocation as staging. 50 open PRs × staging resource cost = significant monthly bill.

**Why it happens:** ResourceQuotas were not applied when the system was built.

**What breaks:** Your cloud budget. Preview environments should be sized for "just enough to test the change" — 1 replica, minimal resources, ephemeral storage.

**The fix:** ResourceQuota per preview namespace. Budget alert for the preview namespace pool. Weekly cleanup of stale environments.

---

### ❌ Anti-Pattern: Stateful Databases Without Isolation

**What it looks like:** All ephemeral environments share a single database, with no schema separation. PR 1234's migration runs against the same tables that PR 1235 is currently testing.

**Why it happens:** Provisioning per-environment databases seemed too complex.

**What breaks:** The same thing that was breaking at Luminary Labs. Cascading migration failures, dirty test data, and unreliable test results.

**The fix:** At minimum, schema isolation (separate PostgreSQL schema per PR). Ideally, separate database containers per PR namespace using the seeded snapshot approach.

---

## Field Notes

💀 **No teardown automation on PR close** → Ephemeral environments accumulate indefinitely → The teardown job must be automatic. Humans do not reliably clean up resources. Add a weekly audit that alerts on environments older than 7 days.

💀 **8-minute environment provisioning** → Developers test locally and ignore the preview environment → Profile provisioning time. Image pull time is usually the bottleneck (fix: pre-pull on nodes). Database seeding is second (fix: smaller seed snapshots, or schema-only seeds with fixture injection).

💀 **Preview environments that hit real external APIs** → Stripe charges, email sent, SMS triggered on every PR push → Stub all external APIs in preview environments. Use service virtualization (WireMock, Mockoon) for third-party dependencies. The ephemeral environment is for testing your code, not for exercising production integrations.

---

## Chapter Summary

Ephemeral per-PR environments eliminate the shared staging problem at its root. Instead of coordinating access to a scarce shared resource, every PR gets its own isolated environment. The isolation is complete: database, networking, application stack. The feedback is high-fidelity: the environment runs the actual proposed change, not a best-effort approximation shared with 16 other developers.

The implementation complexity is real — database handling, cost containment, and provisioning speed all require deliberate engineering. But the payoff is equally real: the `#staging-issues` Slack channel goes dark, demos run on current code, and developers test in an environment that represents their actual change rather than hoping staging happens to be in a state compatible with their PR.

The minimum viable implementation is namespace-per-branch with a seeded database. The advanced implementation is Argo CD ApplicationSets with vCluster isolation and External Secrets integration. Start minimal; scale the complexity only when you feel the constraints of the simpler approach.

---

## What's Next

Chapter 13 addresses what happens after developer testing is complete: promoting the verified artifact through environments — from ephemeral preview through shared staging to production — with appropriate gates at each boundary. The environment promotion pattern formalizes what "ready to go to production" means and how to enforce it.

[→ Next: Chapter 13 — The Environment Promotion Pattern](./chapter-13-environment-promotion.md)

---
*[← Previous: Chapter 11 — The GitOps Pattern](./chapter-11-gitops.md) |
[→ Next: Chapter 13 — The Environment Promotion Pattern](./chapter-13-environment-promotion.md)*
