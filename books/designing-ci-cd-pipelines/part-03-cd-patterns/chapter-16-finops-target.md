# Chapter 16: The FinOps Target Pattern
*Part III: Delivery & Deployment Patterns (CD)*

> *"The CFO asked me what our cloud cost per deployment was.
> I didn't know. I also didn't know our total CI cost,
> our staging environment cost, or which team was spending
> $40,000 a month on data transfer fees.
> I found out. None of it was a good story."*
> — VP of Engineering, Series C company, 2023

---

## The War Story

Omotunde Williams joined Stratum Analytics as Head of Engineering Infrastructure in January. Her first week, she gets access to the AWS Cost Explorer dashboard. She's been doing this long enough to know what to look for.

What she finds: the company is spending $180,000 per month on cloud infrastructure. Annual run rate: $2.16 million. The Series B funding round was $15 million. The board is asking about path to profitability.

Breaking down the $180,000:
- Production infrastructure: $68,000 (expected, reasonable for the scale)
- Staging environment: $34,000 (suspicious — staging costs half of production?)
- CI/CD compute: $22,000 (high for a 45-person engineering team)
- Ephemeral environments: $31,000 (Omotunde freezes on this one)
- Data transfer: $18,000 (the "WTF" line item)
- Miscellaneous: $7,000

The staging environment is running production-scale resources. Nobody scaled it down after the team thought "let's make staging identical to production" two years ago. The initial configuration was correct. The maintenance was never done. Staging runs 5 replicas of every service. Production runs 3.

The ephemeral environments: there are 47 preview environments running at the time of Omotunde's audit. The company has 12 currently open PRs. 35 environments are orphaned — PRs that were merged or abandoned weeks ago. The teardown automation was added to the workflow file, but 35 of those environments were created before the automation existed. Nobody ever ran the cleanup manually.

The CI cost: 45 engineers × average 180 CI minutes per day at $0.008/minute = $64.80/day. Sounds reasonable. Except that $22,000/month works out to $733/day. The gap: 100 macOS runner-minutes per day per engineer at $0.08/minute, totaling $7,200/month alone. Half the CI runs that use macOS runners don't need macOS — somebody copied a workflow template that specified `macos-latest` and nobody questioned it.

Omotunde's first three weeks are spent building dashboards and implementing cost controls. Month one result: $180,000 → $112,000. Month two: $112,000 → $84,000. The reduction is not from eliminating engineering capability — it's from eliminating waste that nobody was tracking.

This chapter is about building those dashboards and controls before month 36.

---

## What You'll Learn

- Cloud cost visibility at the pipeline level: tagging, allocation, and the dashboards that make cost-by-team and cost-by-environment visible
- Infracost: estimating the cloud cost of infrastructure changes before they're applied
- Cost gates in the deployment pipeline: blocking deployments that would exceed budget thresholds
- Right-sizing environments: staging at 30–50% of production scale, ephemeral environments at minimum viable compute
- The CI cost model: which CI choices drive the majority of compute cost, and how to optimize them

---

## The Foundation: Cost Visibility Through Tagging

You cannot optimize what you cannot see. The first step is consistent resource tagging that enables cost attribution.

```hcl
# terraform/modules/service/main.tf
# Every resource provisioned by this module gets these tags.
# These tags flow into AWS Cost Explorer, enabling cost-by-team, cost-by-env queries.

locals {
  # Mandatory tags — all resources must have these.
  # Enforce in CI via Infracost's policy engine or OPA/Conftest.
  common_tags = {
    # Who owns this resource? Enables per-team cost breakdown.
    team = var.team_name                    # e.g., "payments", "platform"
    
    # What application is this for?
    service = var.service_name              # e.g., "payment-api"
    
    # What environment?
    environment = var.environment           # e.g., "production", "staging", "pr-1234"
    
    # What cost center? (For finance team's allocation)
    cost_center = var.cost_center           # e.g., "engineering", "r&d"
    
    # Is this managed by the pipeline or manually provisioned?
    # Manually provisioned resources are often forgotten and not torn down.
    managed_by = "terraform"
    
    # If this is an ephemeral resource, what PR created it?
    # Used by the cleanup job to find and destroy orphaned resources.
    pr_number = var.pr_number != "" ? var.pr_number : "N/A"
  }
}

resource "aws_ecs_service" "service" {
  name    = "${var.service_name}-${var.environment}"
  # ... other config ...
  
  tags = local.common_tags
}

resource "aws_rds_instance" "database" {
  # ... other config ...
  tags = merge(local.common_tags, {
    # Additional tag for the cleanup job: when was this created?
    # Allows the cleanup job to identify resources older than N days.
    created_at = timestamp()
  })
}
```

### AWS Cost Allocation Tags

Tags are only useful in Cost Explorer if they're activated as cost allocation tags. Activate tags in the AWS Billing console: Billing → Cost Allocation Tags → activate `team`, `service`, `environment`, `pr_number`. Allow up to 24 hours for the tags to appear in Cost Explorer.

Once activated, you can build cost queries that answer:
- How much does the `payments` team spend per month?
- How much does the `staging` environment cost vs. `production`?
- How much do ephemeral `pr-*` environments cost in total this month?
- Which service has the highest cost per deployment?

---

## Infracost: Cost Estimation in CI

Infracost estimates the monthly cloud cost of Terraform infrastructure changes before they're applied. Add it to CI to give developers visibility into the cost implications of their infrastructure changes.

```yaml
# .github/workflows/infracost.yml
name: Infrastructure Cost Estimate

on:
  pull_request:
    paths:
      - 'terraform/**'
      - '**/*.tf'

jobs:
  infracost:
    runs-on: ubuntu-22.04
    permissions:
      contents: read
      pull-requests: write  # To post the cost summary as a PR comment

    steps:
      - uses: actions/checkout@v4

      - name: Setup Infracost
        uses: infracost/actions/setup@v3
        with:
          api-key: ${{ secrets.INFRACOST_API_KEY }}

      - name: Generate Infracost baseline (main branch)
        run: |
          # Cost for the current main branch state (before PR changes)
          infracost breakdown \
            --path terraform/ \
            --format json \
            --out-file /tmp/infracost-main.json
        env:
          # Pass cloud credentials so Infracost can look up actual pricing
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Generate Infracost for PR branch
        run: |
          infracost breakdown \
            --path terraform/ \
            --format json \
            --out-file /tmp/infracost-pr.json

      - name: Generate diff and post PR comment
        run: |
          infracost diff \
            --path /tmp/infracost-pr.json \
            --compare-to /tmp/infracost-main.json \
            --format json \
            --out-file /tmp/infracost-diff.json

          # Post the cost diff as a PR comment.
          # Engineers see the cost impact of their infrastructure change
          # before the PR is merged — not after it's been running for a month.
          infracost comment github \
            --path /tmp/infracost-diff.json \
            --repo $GITHUB_REPOSITORY \
            --pull-request ${{ github.event.pull_request.number }} \
            --github-token ${{ github.token }} \
            --behavior update  # Update existing comment rather than creating a new one

      - name: Enforce cost gate
        run: |
          # Parse the diff for total cost increase.
          MONTHLY_INCREASE=$(cat /tmp/infracost-diff.json | \
            jq '.diffTotalMonthlyCost | tonumber')

          # Gate: fail the PR if the cost increase exceeds $500/month.
          # Adjust threshold to match your organization's policy.
          # The threshold forces a conversation about expensive infrastructure
          # changes before they're merged — not after the bill arrives.
          MAX_INCREASE=500

          if (( $(echo "$MONTHLY_INCREASE > $MAX_INCREASE" | bc -l) )); then
            echo "❌ Cost gate failed: This PR increases monthly cost by \$$MONTHLY_INCREASE"
            echo "Maximum allowed increase: \$$MAX_INCREASE/month"
            echo "To proceed, get approval from the engineering finance owner."
            echo "Document the approval in the PR description before merging."
            exit 1
          fi

          echo "✅ Cost gate passed: monthly cost change is \$$MONTHLY_INCREASE"
```

The PR comment output looks like this:

```
## Infracost Estimate 💰

Monthly cost will increase by $312 (+18%)

Project: terraform/environments/staging
| Resource | Type | Monthly Cost | Change |
|---|---|---|---|
| aws_ecs_service.payment-api | ECS | $18/mo | +$18 |
| aws_rds_instance.main | RDS db.t3.large | $120/mo | +$120 |
| aws_elasticache_cluster.cache | ElastiCache | $174/mo | +$174 |

See full breakdown: [Infracost App](https://dashboard.infracost.io)
```

This is the information Omotunde's team was missing. Engineers making infrastructure changes see the cost implication immediately, in the context of the PR where the change is being made — not in a billing report 30 days later.

---

## Cost Gates: Blocking Expensive Deployments

Cost gates go beyond estimation to enforcement. They can be applied at multiple points in the pipeline:

### Gate Type 1: Pre-Apply Cost Check (Terraform)

```bash
# ci/terraform-cost-gate.sh
# Run before terraform apply in the CI pipeline.
# Fail if the planned change exceeds the budget threshold.

PLAN_JSON=$1
MAX_MONTHLY_INCREASE=${2:-1000}  # Default: $1000/month maximum increase

# Generate cost estimate from the Terraform plan
COST_ESTIMATE=$(infracost breakdown \
  --path "$PLAN_JSON" \
  --format json | \
  jq '.totalMonthlyCost | tonumber')

CURRENT_COST=$(infracost breakdown \
  --path terraform/ \
  --format json | \
  jq '.totalMonthlyCost | tonumber')

INCREASE=$(echo "$COST_ESTIMATE - $CURRENT_COST" | bc)

echo "Current monthly cost: \$$CURRENT_COST"
echo "Estimated cost after apply: \$$COST_ESTIMATE"
echo "Monthly increase: \$$INCREASE"

if (( $(echo "$INCREASE > $MAX_MONTHLY_INCREASE" | bc -l) )); then
  echo ""
  echo "COST GATE FAILED"
  echo "This deployment would increase monthly costs by \$$INCREASE,"
  echo "exceeding the limit of \$$MAX_MONTHLY_INCREASE."
  echo "Obtain approval from the finance owner before proceeding."
  exit 1
fi

echo "Cost gate passed."
```

### Gate Type 2: Environment Budget Enforcement

Each environment gets a monthly budget. Exceeding the budget triggers an alert and, optionally, a deployment freeze:

```python
# ci/check_environment_budget.py
# Called by the deployment pipeline before any deployment to a shared environment.
# Fails if the environment has already exceeded its monthly budget.

import boto3
import sys
from datetime import datetime, timedelta

def get_monthly_spend(environment: str) -> float:
    """Query AWS Cost Explorer for current month's spend for the environment."""
    client = boto3.client('ce', region_name='us-east-1')
    
    now = datetime.now()
    start = now.replace(day=1).strftime('%Y-%m-%d')
    end = now.strftime('%Y-%m-%d')
    
    response = client.get_cost_and_usage(
        TimePeriod={'Start': start, 'End': end},
        Granularity='MONTHLY',
        Filter={
            'Tags': {
                'Key': 'environment',
                'Values': [environment]
            }
        },
        Metrics=['UnblendedCost']
    )
    
    total = sum(
        float(r['Total']['UnblendedCost']['Amount'])
        for r in response['ResultsByTime']
    )
    return total

ENVIRONMENT_BUDGETS = {
    'staging': 8000,      # $8,000/month
    'production': 75000,  # $75,000/month
    'dev': 3000,          # $3,000/month
}

def main():
    env = sys.argv[1]
    budget = ENVIRONMENT_BUDGETS.get(env)
    
    if budget is None:
        print(f"No budget defined for environment '{env}'. Proceeding without check.")
        sys.exit(0)
    
    spend = get_monthly_spend(env)
    utilization = spend / budget * 100
    
    print(f"Environment: {env}")
    print(f"Monthly budget: ${budget:,.0f}")
    print(f"Current spend: ${spend:,.0f} ({utilization:.1f}%)")
    
    if spend >= budget:
        print(f"\nBUDGET EXCEEDED: {env} has spent ${spend:,.0f} of ${budget:,.0f} budget.")
        print("Deployment blocked. Contact the infrastructure team.")
        sys.exit(1)
    
    if utilization >= 80:
        print(f"\nWARNING: {env} has used {utilization:.1f}% of monthly budget.")
        print("Monitor spend closely. Deployment proceeding.")
    
    sys.exit(0)

if __name__ == '__main__':
    main()
```

---

## Right-Sizing Environments

The largest single source of waste in most engineering organizations: over-provisioned non-production environments.

```hcl
# terraform/modules/service/variables.tf

variable "environment_config" {
  description = "Environment-specific sizing configuration"
  type = object({
    replicas      = number
    cpu_requests  = string
    memory_requests = string
    db_instance_class = string
    cache_node_type = string
  })
}

# terraform/environments/production/main.tf
module "payment_api" {
  source = "../../modules/service"
  
  environment_config = {
    replicas          = 5
    cpu_requests      = "500m"
    memory_requests   = "1Gi"
    db_instance_class = "db.r6g.large"  # $0.26/hr = $189/month
    cache_node_type   = "cache.r6g.large"
  }
}

# terraform/environments/staging/main.tf
module "payment_api" {
  source = "../../modules/service"
  
  environment_config = {
    # Staging is 30% of production scale.
    # Enough to catch scale-related bugs; not sized for production traffic.
    replicas          = 2              # vs. 5 in production
    cpu_requests      = "250m"         # vs. 500m
    memory_requests   = "512Mi"        # vs. 1Gi
    db_instance_class = "db.t3.medium" # $0.068/hr = $49/month vs. $189/month
    cache_node_type   = "cache.t3.small"
  }
}

# terraform/environments/ephemeral/main.tf
module "payment_api" {
  source = "../../modules/service"
  
  environment_config = {
    # Ephemeral environments: minimum viable for testing the change.
    replicas          = 1
    cpu_requests      = "100m"
    memory_requests   = "256Mi"
    db_instance_class = "db.t3.micro"  # $0.017/hr = $12/month. Destroyed after PR closes.
    cache_node_type   = "cache.t3.micro"
  }
}
```

The cost difference between "staging = production" and "staging = 30% of production" for a typical mid-size deployment is $15,000–$40,000 per month. This is not a compromise on testing quality — it's a recognition that staging is for validating behavior, not for load testing (which has dedicated performance test environments).

---

## CI Cost Optimization

The three highest-impact CI cost optimizations:

### Optimization 1: Right-Size Runner Types

```yaml
# ❌ Using macOS runner for a job that doesn't need macOS
jobs:
  backend-tests:
    runs-on: macos-latest  # $0.08/min — 10× more expensive than Linux
    steps:
      - run: pytest tests/  # This is a Python test suite. It doesn't need macOS.

# ✅ Use Linux unless macOS is specifically required
jobs:
  backend-tests:
    runs-on: ubuntu-22.04  # $0.008/min
    steps:
      - run: pytest tests/

# macOS runners are for: iOS/macOS app builds, macOS-specific tests,
# Xcode-based compilation. Nothing else.
```

**Impact:** Misuse of macOS runners is the single most common CI cost waste. Auditing every workflow that uses `macos-latest` and changing to `ubuntu-22.04` where the macOS runner isn't needed typically saves 30–50% of total CI cost for teams that do backend development.

### Optimization 2: Cache Dependencies

Add `actions/cache` to every job that installs dependencies (Chapter 5 covers this in depth). Typical impact: 3–8 minutes of runner time saved per job per run. At $0.008/minute for Linux, 5 minutes saved × 200 runs/day = $8/day = $2,920/year.

### Optimization 3: Concurrency-Based Job Cancellation

```yaml
# Cancel in-progress runs when a new push is made to the same PR.
# A developer pushing 5 commits rapidly: 4 runs cancelled = 4× cost reduction
# for that developer's workflow.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

**Impact:** On teams where engineers push frequent small commits, this can reduce CI compute consumption by 25–40%.

---

## The FinOps Dashboard

A FinOps dashboard for engineering gives teams visibility into their spending before the CFO does:

```python
# scripts/finops_report.py — generates a weekly cost report per team
# Sent to each team's Slack channel and to engineering leadership

import boto3
import json
from datetime import datetime, timedelta

def generate_weekly_report():
    client = boto3.client('ce', region_name='us-east-1')
    
    end = datetime.now()
    start = end - timedelta(days=7)
    
    response = client.get_cost_and_usage(
        TimePeriod={
            'Start': start.strftime('%Y-%m-%d'),
            'End': end.strftime('%Y-%m-%d')
        },
        Granularity='DAILY',
        GroupBy=[
            {'Type': 'TAG', 'Key': 'team'},
            {'Type': 'TAG', 'Key': 'environment'}
        ],
        Metrics=['UnblendedCost']
    )
    
    # Aggregate by team and environment
    team_costs = {}
    for result in response['ResultsByTime']:
        for group in result['Groups']:
            team = group['Keys'][0].replace('team$', '')
            env = group['Keys'][1].replace('environment$', '')
            cost = float(group['Metrics']['UnblendedCost']['Amount'])
            
            if team not in team_costs:
                team_costs[team] = {}
            team_costs[team][env] = team_costs[team].get(env, 0) + cost
    
    # Format as Slack message
    lines = ["*Weekly Engineering Cloud Cost Report*\n"]
    
    total = 0
    for team, envs in sorted(team_costs.items()):
        team_total = sum(envs.values())
        total += team_total
        lines.append(f"*{team}* — ${team_total:,.0f}/week")
        for env, cost in sorted(envs.items()):
            lines.append(f"  {env}: ${cost:,.0f}")
    
    lines.append(f"\n*Total: ${total:,.0f}/week (${total * 4.3:,.0f}/month est.)*")
    
    return '\n'.join(lines)
```

---

## The Anti-Patterns

### ❌ Anti-Pattern: Staging = Production (Sizing)

**What it looks like:** Staging runs the same instance types, same replica counts, and same configuration as production. The rationale: "we need staging to be identical to production for accurate testing."

**Why it happens:** "Identical to production" sounds like good engineering practice. It conflates testing fidelity (which requires the same configuration) with resource sizing (which doesn't).

**What breaks:** Budget. Staging at production scale costs as much as production. For most teams, the testing benefit of production-scale staging doesn't justify the cost.

**The fix:** Staging at 30–40% of production scale. Test at scale in performance testing environments, not staging.

---

### ❌ Anti-Pattern: No Ephemeral Environment Cleanup

**What it looks like:** Ephemeral environments are created on PR open. Teardown automation was not implemented, or was implemented after many environments were already created. 35 environments are running for PRs that were merged months ago.

**Why it happens:** Teardown was a "nice to have" that was never implemented, or the cleanup automation only applies to new environments.

**What breaks:** Budget. 35 forgotten environments at $50/month each = $1,750/month = $21,000/year.

**The fix:** Retroactive cleanup job. Tag-based discovery: find all resources tagged `environment=pr-*` and `created_at < 14 days ago`. Verify the PR is closed. Destroy the resources. Run weekly.

---

### ❌ Anti-Pattern: No Cost Visibility in Engineering

**What it looks like:** The only person who sees the cloud bill is the VP of Engineering, who sees it once a month when the invoice arrives. Teams make infrastructure decisions without any cost feedback.

**Why it happens:** Cost visibility was never set up. The finance team sees the bill; engineering doesn't.

**What breaks:** Cost accountability. Without visibility, teams can't optimize what they can't see.

**The fix:** Weekly per-team cost reports in Slack. Infracost in every infrastructure PR. Cost-by-environment dashboards accessible to every engineer.

---

## Field Notes

💀 **Staging sized identically to production** → Staging costs as much as production; total cloud bill is 2× what it could be → Right-size staging to 30–40% of production. This is not a compromise on testing — staging is for behavior validation, not scale validation.

💀 **`macos-latest` in workflows that don't need macOS** → 10× CI cost for no additional value → Audit every `macos-latest` usage. Change to `ubuntu-22.04` for any job that doesn't specifically require macOS. The fastest $10,000/year saving in CI.

💀 **No cost gate on Terraform PRs** → An accidental `count = 100` instead of `count = 1` ships to staging and costs $15,000 before anyone notices → Infracost with a cost gate. Takes an afternoon to set up. Pays back in the first prevented incident.

---

## Chapter Summary

Cloud cost is an engineering problem, not a finance problem. The decisions that drive cloud spend — environment sizing, CI runner choices, ephemeral environment lifecycle, resource provisioning — are all made by engineers. Making those decisions visible (cost attribution through tagging), predictable (Infracost in CI), and accountable (per-team dashboards, environment budgets) changes the incentive structure. Engineers who see the cost of their infrastructure decisions make better ones.

Omotunde's $96,000/month reduction wasn't magic. It was tagging, dashboards, three Infracost policy gates, one staging right-sizing effort, and a cleanup script for orphaned ephemeral environments. None of it required a significant engineering investment. All of it required that someone decided to look at the data.

The controversial take: the "move fast" philosophy that dominates startup culture is incompatible with ignoring cloud costs. Moving fast with a $180,000/month cloud bill that grows 15% per month creates a financial ceiling that hits sooner than most startups expect. FinOps is not process overhead on top of engineering — it's the discipline that makes rapid growth sustainable.

---

## What's Next

Part III is complete. You now have a CD architecture that spans the full deployment lifecycle: push vs. pull (Chapter 10), GitOps (Chapter 11), ephemeral environments (Chapter 12), environment promotion (Chapter 13), multi-service coordination (Chapter 14), large-scale refactoring (Chapter 15), and cost accountability (Chapter 16).

Part IV moves into progressive delivery: the patterns for rolling out changes safely to fractions of production traffic. Chapter 17 opens with Blue-Green Deployment — the classic zero-downtime deployment pattern and, more usefully, the explanation of why "just flip the load balancer" is about 20% of the story.
