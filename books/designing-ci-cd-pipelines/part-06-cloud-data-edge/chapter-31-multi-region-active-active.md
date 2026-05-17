# Chapter 31: The Cloud-Native Multi-Region Active-Active Pattern
*Part VI: Cloud, Data & Edge Specialized Delivery*

> *"Active-active sounds like redundancy. It's actually complexity.
> Every deployment decision you could make wrong with one region,
> you can now make wrong in N regions simultaneously,
> plus you can make N new types of mistakes that only exist
> when regions disagree about what the current state is."*
> — principal engineer at a global payments company

---

## The War Story

Apex Fintech runs their core ledger service active-active across three AWS regions: us-east-1, eu-west-1, and ap-southeast-1. Each region handles traffic from its geographic area. DynamoDB Global Tables replicates data across regions with eventual consistency.

In September, they deploy a new version of the transaction validator. The deployment pipeline deploys to all three regions simultaneously — the team reasons that this minimizes the window where different regions are running different versions.

The new version introduces a new transaction status: `PENDING_REVIEW`. The old version doesn't know about this status. During the 4-minute window where us-east-1 is already running the new version (which creates `PENDING_REVIEW` transactions) while eu-west-1 is still running the old version (which reads those transactions), the old version encounters the unknown status and throws:

```
ValueError: 'PENDING_REVIEW' is not a valid TransactionStatus
```

DynamoDB Global Tables is replicating transactions created in us-east-1 to eu-west-1 in real time. The old eu-west-1 code is crashing on every transaction created in us-east-1 that has the new status. For 4 minutes, the eu-west-1 validator is in error for roughly 30% of transactions.

The fix is straightforward in hindsight: deploy non-primary regions first, validate health, then deploy the primary region. Or deploy backward-compatible changes that tolerate unknown enum values gracefully. The team did neither.

---

## What You'll Learn

- The multi-region deployment sequencing problem: why simultaneous cross-region deployment creates consistency hazards
- Cross-region traffic routing: AWS Global Accelerator, Cloudflare, and Route 53 health checks
- Deployment ordering: non-primary first, validate, then primary
- Data consistency constraints during deployment: what "eventual consistency" means for rolling upgrades
- Health check driven global traffic routing: automatic failover during a bad deployment
- The split-brain problem: what happens when regions have different views of the desired state

---

## The Deployment Sequencing Problem

In a multi-region active-active system, the deployment window — the time when different regions are running different versions — creates a potential inconsistency window. The length and impact of that window depends on:

1. **How long the deployment takes per region** — typically 5–15 minutes for a rolling Kubernetes deployment
2. **Whether data created in Region A (new version) can be processed by Region B (old version)** — backward compatibility constraint
3. **Whether the regions communicate with each other during the window** — API calls, shared databases, event streams

The naive solution — deploy all regions simultaneously — minimizes the window duration but creates the scenario where all regions are simultaneously in transition, maximizing the probability of cross-region compatibility issues.

The correct solution: **non-primary first, validate, then primary**.

```
Multi-Region Deployment Sequence:

1. Deploy to non-primary regions first (eu-west-1, ap-southeast-1)
   ├─ Deploy to eu-west-1
   │  └─ Wait for health checks to pass (5 minutes)
   └─ Deploy to ap-southeast-1 (can run concurrently with eu-west-1)
      └─ Wait for health checks to pass

2. Validate non-primary region health (10 minutes observation)
   ├─ Error rate comparison: canary vs. baseline
   ├─ Cross-region replication lag check
   └─ Business metrics: transaction success rate

3. Deploy to primary region (us-east-1) only if non-primary is healthy
   └─ Primary handles the most traffic — validate non-primary first

4. Post-deployment monitoring (15 minutes)
   └─ Monitor all regions for consistency issues
```

```yaml
# .github/workflows/multi-region-deploy.yml
jobs:
  deploy-non-primary:
    strategy:
      fail-fast: false  # Deploy both non-primary regions in parallel
      matrix:
        region: [eu-west-1, ap-southeast-1]
    runs-on: ubuntu-22.04
    steps:
      - name: Deploy to ${{ matrix.region }}
        run: |
          kubectl config use-context ${{ matrix.region }}-cluster
          kubectl set image deployment/transaction-validator \
            validator=myregistry.io/transaction-validator:${{ github.sha }} \
            --namespace payments
          kubectl rollout status deployment/transaction-validator \
            --namespace payments --timeout=10m

  validate-non-primary:
    needs: deploy-non-primary
    runs-on: ubuntu-22.04
    steps:
      - name: Validate non-primary region health
        run: |
          python ci/validate_multi_region_health.py \
            --regions "eu-west-1,ap-southeast-1" \
            --observation-minutes 10 \
            --metric error_rate \
            --threshold 0.5

  deploy-primary:
    needs: validate-non-primary
    runs-on: ubuntu-22.04
    environment: production-primary  # Manual approval required
    steps:
      - name: Deploy to us-east-1 (primary)
        run: |
          kubectl config use-context us-east-1-cluster
          kubectl set image deployment/transaction-validator \
            validator=myregistry.io/transaction-validator:${{ github.sha }} \
            --namespace payments
          kubectl rollout status deployment/transaction-validator \
            --namespace payments --timeout=10m
```

---

## Health-Check Driven Global Traffic Routing

AWS Global Accelerator routes traffic to the healthiest region based on real-time health checks. During a deployment, if a region's health checks fail, Global Accelerator automatically shifts traffic away from that region.

```hcl
# terraform/global-accelerator.tf
resource "aws_globalaccelerator_accelerator" "main" {
  name            = "transaction-validator-ga"
  ip_address_type = "IPV4"
  enabled         = true
}

resource "aws_globalaccelerator_listener" "https" {
  accelerator_arn = aws_globalaccelerator_accelerator.main.id
  client_affinity = "SOURCE_IP"  # Sticky routing: same client → same region
  protocol        = "TCP"
  port_range { from_port = 443; to_port = 443 }
}

resource "aws_globalaccelerator_endpoint_group" "us_east_1" {
  listener_arn          = aws_globalaccelerator_listener.https.id
  endpoint_group_region = "us-east-1"

  # Traffic dial: percentage of global traffic sent to this region
  # Normally 50% for the primary region. Reduce manually during deployments.
  traffic_dial_percentage = 50

  health_check_path                = "/health"
  health_check_interval_seconds    = 10
  threshold_count                  = 2    # 2 consecutive failures → remove from rotation
  health_check_protocol            = "HTTPS"

  endpoint_configuration {
    endpoint_id = aws_alb.us_east_1.arn
    weight      = 100
    # client_ip_preservation_enabled: pass the real client IP to the backend
    client_ip_preservation_enabled = true
  }
}

resource "aws_globalaccelerator_endpoint_group" "eu_west_1" {
  listener_arn          = aws_globalaccelerator_listener.https.id
  endpoint_group_region = "eu-west-1"
  traffic_dial_percentage = 30

  health_check_path             = "/health"
  health_check_interval_seconds = 10
  threshold_count               = 2
  health_check_protocol         = "HTTPS"

  endpoint_configuration {
    endpoint_id = aws_alb.eu_west_1.arn
    weight      = 100
  }
}
```

### Pre-Deployment Traffic Reduction

Before deploying to a region, reduce its traffic dial to minimize blast radius:

```bash
# pre_deploy_traffic_reduce.sh — reduce traffic to a region before deploying
REGION=$1
ACCELERATOR_ARN="arn:aws:globalaccelerator::123456789:accelerator/xxx"

# Get the current traffic dial for this region's endpoint group
ENDPOINT_GROUP_ARN=$(aws globalaccelerator list-endpoint-groups \
  --listener-arn "${LISTENER_ARN}" \
  --query "EndpointGroups[?EndpointGroupRegion=='${REGION}'].EndpointGroupArn" \
  --output text)

# Reduce traffic to 5% before deploying (minimal user impact from any deployment issues)
aws globalaccelerator update-endpoint-group \
  --endpoint-group-arn "${ENDPOINT_GROUP_ARN}" \
  --traffic-dial-percentage 5

echo "Traffic to ${REGION} reduced to 5%. Beginning deployment..."
sleep 60  # Allow in-flight requests to complete

# [deployment runs here]

# Restore traffic after deployment and validation
aws globalaccelerator update-endpoint-group \
  --endpoint-group-arn "${ENDPOINT_GROUP_ARN}" \
  --traffic-dial-percentage 30

echo "Traffic to ${REGION} restored to 30%."
```

---

## Data Consistency During Deployment

The Apex Fintech incident was a data consistency problem: new data formats created by the new version couldn't be processed by the old version in another region.

### The Backward-Compatibility Rule for Multi-Region

In a multi-region active-active system with shared or replicated data:

**New data formats must be processable by the old code version.**

This is stricter than the single-region backward compatibility requirement. In single-region blue-green, both versions share the same database but there's a clear transition moment. In multi-region, different regions can be on different versions simultaneously for many minutes, and data flows between them continuously via replication.

The fix for the Apex incident:

```python
# ❌ Old code: crashes on unknown enum value
class TransactionStatus(Enum):
    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    # PENDING_REVIEW doesn't exist here — crashes when new version creates it

# ✅ New code that's safe to deploy BEFORE old code is retired:
# Option 1: Tolerate unknown values
class TransactionStatus(str, Enum):
    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    PENDING_REVIEW = "PENDING_REVIEW"
    
    @classmethod
    def _missing_(cls, value):
        # Return a sentinel value instead of crashing on unknown statuses
        # This makes the new code also backward-compatible with future unknown values
        return cls.PENDING  # Safe fallback: treat unknown as PENDING

# ✅ Or: the old code gets a backward-compatible version too
# Add PENDING_REVIEW to the OLD code's enum BEFORE deploying the new code
# Then both old and new code can handle the new value
```

This is the Expand-and-Contract principle applied to API/data contracts: new values must be added to the consuming code before being added to the producing code.

---

## Cross-Region Replication Lag as a Deployment Gate

Before deploying to a region, verify that cross-region replication lag is within acceptable bounds. High replication lag means the region is already behind — deploying into it may compound consistency issues.

```python
# check_replication_lag.py — pre-deployment gate for multi-region
import boto3

def check_dynamodb_replication_lag(table_name: str, target_region: str) -> tuple[bool, str]:
    """
    Verify DynamoDB Global Table replication lag is below threshold before deploying.
    High lag means the target region is processing old data — deploying may cause
    the new code to process data that hasn't been replicated yet.
    """
    client = boto3.client('cloudwatch', region_name=target_region)
    
    response = client.get_metric_statistics(
        Namespace='AWS/DynamoDB',
        MetricName='ReplicationLatency',
        Dimensions=[
            {'Name': 'TableName', 'Value': table_name},
            {'Name': 'ReceivingRegion', 'Value': target_region}
        ],
        StartTime=datetime.now() - timedelta(minutes=5),
        EndTime=datetime.now(),
        Period=60,
        Statistics=['Maximum']
    )
    
    if not response['Datapoints']:
        return True, "No replication data available — proceeding"
    
    max_lag_ms = max(d['Maximum'] for d in response['Datapoints'])
    
    if max_lag_ms > 5000:  # 5 second lag threshold
        return False, (
            f"DynamoDB replication lag to {target_region} is {max_lag_ms:.0f}ms "
            f"(threshold: 5000ms). Deployment blocked to prevent consistency issues."
        )
    
    return True, f"Replication lag {max_lag_ms:.0f}ms — within threshold."
```

---

## The Anti-Patterns

### ❌ Anti-Pattern: Simultaneous Multi-Region Deployment

**What it looks like:** Deploy to all regions at the same time to minimize the version skew window.

**What breaks:** All regions are simultaneously in transition. Data created in Region A (new version) flows to Region B (old version) during the transition. If the new version created data that old code can't handle, all regions are affected simultaneously.

**The fix:** Sequential deployment: non-primary first, validate, then primary.

---

### ❌ Anti-Pattern: No Traffic Reduction Before Regional Deployment

**What it looks like:** Deploy to a region while it's receiving 50% of global traffic. If the deployment fails, 50% of users are affected.

**The fix:** Reduce traffic dial to 5% before deploying to a region. If the deployment fails, only 5% of users are affected. Restore after validation.

---

### ❌ Anti-Pattern: Unknown Enum Values Cause Crashes

**What it looks like:** New enum values added in Region A crash old code in Region B that receives the replicated data.

**The fix:** All enum parsing must be tolerant of unknown values. Add `_missing_` handlers or equivalent. New values added to producing code must first be added to all consuming code.

---

## Field Notes

💀 **Deploy all regions simultaneously** → Consistency window affects all regions at once → Non-primary first, validate, primary last. The extra 15 minutes is worth it.

💀 **No traffic reduction before regional deploy** → Bad deployment affects full regional traffic share → Reduce traffic dial to 5-10% before deploying. 10 minutes before + 10 minutes after = 20 minutes of minimal-impact validation window.

💀 **Enum values that crash on unknown inputs** → Old region crashes on data created by new region during transition → All parsers must tolerate unknown values. This is the fundamental contract for multi-region rolling upgrades.

---

## Chapter Summary

Multi-region active-active is the deployment context where every bad practice is amplified by N regions and complicated by real-time data replication between them. The deployment sequencing rule (non-primary first, validate, then primary) and the backward-compatibility requirement (old code must handle data created by new code) are the two non-negotiable constraints. Everything else is optimization.

---

## What's Next

Chapter 32 closes Part VI with mobile deployment — the context where "rollback in 5 minutes" is physically impossible due to App Store review cycles. Mobile deployment combines phased App Store rollouts, OTA update channels, feature flags as the primary runtime control mechanism, and forced upgrade flows for critical security patches.

[→ Next: Chapter 32 — The Mobile Release Train Pattern](./chapter-32-mobile-release-train.md)

---
*[← Previous: Chapter 30 — The GitOps-at-the-Edge Pattern](./chapter-30-gitops-at-the-edge.md) |
[→ Next: Chapter 32 — The Mobile Release Train Pattern](./chapter-32-mobile-release-train.md)*
