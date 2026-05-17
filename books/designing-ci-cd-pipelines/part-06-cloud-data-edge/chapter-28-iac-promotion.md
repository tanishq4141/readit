# Chapter 28: The Infrastructure-as-Code (IaC) Promotion Pattern
*Part VI: Cloud, Data & Edge Specialized Delivery*

> *"He ran terraform apply in prod without a plan review.
> Changed the security group. Blocked the database.
> Two-hour outage on a Friday afternoon.
> The diff was three lines. He just didn't read them."*
> — postmortem note that led to an Atlantis deployment

---

## The War Story

It's a Friday at 3:45 PM when the on-call at Vantage Systems fires. The API is returning 500s on every database-dependent endpoint. The SRE pulls up the logs:

```
FATAL: connection to server at "db.production.internal" (10.0.1.15)
failed: Connection refused
	Is the server running on that host and accepting TCP/IP connections?
```

The database is running fine. The application can't reach it. The security group on the database RDS instance is blocking all inbound connections.

The SRE checks CloudTrail. At 3:42 PM, someone ran `terraform apply` directly in the production AWS account. The Terraform state was out of sync with what someone thought was the current state. When they ran `terraform apply` to add a new S3 bucket, Terraform also "corrected" the security group back to the version in the state file — a version that didn't include the production application's security group as an ingress rule.

The ingress rule had been manually added to the security group three weeks ago because a new application subnet was created outside of Terraform. That manual change was never added to the Terraform code. Terraform's state didn't know about it. Terraform's plan would have shown its removal — if anyone had read the plan.

Nobody had read the plan. They ran `terraform apply` directly. The security group was "corrected" to the state file's version, removing the ingress rule that allowed the application to reach the database. Two-hour outage, Friday afternoon.

---

## What You'll Learn

- Terraform plan as a promotable artifact: treating IaC changes the way you treat application changes
- Atlantis and Terraform Cloud for PR-based plan review workflows
- Remote state management: S3 + DynamoDB locking, Terraform Cloud, preventing state corruption
- Drift detection: automatically detecting when live infrastructure diverges from IaC state
- Policy-as-code with Sentinel, OPA/Conftest, and Checkov for plan-time validation
- The state migration problem: what happens when IaC needs to track resources it didn't create

---

## Terraform Plan as a Promotable Artifact

The core principle of IaC promotion: **a Terraform plan file is an artifact that captures exactly what `terraform apply` will do, including all additions, changes, and destructions**. This plan can be reviewed before being applied, just as a code diff is reviewed before being merged.

```
IaC Promotion Workflow:

PR opened
    │
    ▼
terraform plan (runs in CI)
    │
    ├─ Plan output: +3 to add, ~1 to change, -0 to destroy
    │
    ▼
Plan posted as PR comment (Atlantis / Terraform Cloud)
    │
    ▼
Engineer reviews plan diff: checks destructions, unexpected changes
    │
    ▼
PR approval from at least one other engineer
    │
    ▼
terraform apply (runs in CI, uses the saved plan file)
    │
    ▼
Apply output posted as PR comment
    │
    ▼
PR merged
```

The plan file is the artifact. The `apply` command uses the saved plan file, not a fresh plan — ensuring that what was reviewed is exactly what gets applied (no drift between plan and apply due to concurrent changes).

---

## Implementation: Atlantis (Self-Hosted)

Atlantis is a self-hosted Terraform automation tool that runs on every pull request touching Terraform files, posts plan output as PR comments, and applies on merge.

```yaml
# atlantis.yaml — repository configuration
version: 3

# Projects: one per environment that has its own Terraform state
projects:
  - name: production
    dir: terraform/environments/production
    workspace: default
    # autoplan: run terraform plan automatically on PR open/update
    autoplan:
      enabled: true
      when_modified:
        - "*.tf"
        - "*.tfvars"
        - "../modules/**/*.tf"  # Also plan if shared modules change
    
    # Apply requires explicit approval (Atlantis checks PR approval status)
    apply_requirements:
      - approved          # Requires at least 1 PR approval
      - mergeable         # Requires no merge conflicts
      - undiverged        # Requires branch is up to date with main

  - name: staging
    dir: terraform/environments/staging
    workspace: default
    autoplan:
      enabled: true
      when_modified: ["*.tf", "*.tfvars", "../modules/**/*.tf"]
    # Staging can be applied without explicit approval (lower risk)
    apply_requirements: []
```

```hcl
# terraform/environments/production/main.tf
# Configured to use remote state with locking to prevent concurrent applies

terraform {
  backend "s3" {
    bucket         = "mycompany-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true  # Encrypt state at rest — state often contains secrets

    # DynamoDB table for state locking.
    # Prevents two concurrent applies from corrupting the state file.
    # Without locking: two simultaneous applies can create a corrupted state.
    dynamodb_table = "terraform-state-locks"
    
    # Use separate AWS credentials for state access (not production creds)
    # Limits blast radius if the state bucket is compromised
    profile        = "terraform-state"
  }
  
  required_version = "~> 1.6"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

### Atlantis Plan Comment

When a PR changes Terraform code, Atlantis posts:

```
Ran Plan for dir: terraform/environments/production workspace: default

Terraform used the selected providers to generate the following execution plan.
Resource actions are indicated with the following symbols:
  + create
  ~ update in-place
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # aws_security_group_rule.db_ingress will be updated in-place
  ~ resource "aws_security_group_rule" "db_ingress" {
      ~ cidr_blocks = [
          - "10.0.2.0/24",    ← THIS LINE IS BEING REMOVED
            "10.0.1.0/24",
        ]
    }

Plan: 0 to add, 1 to change, 0 to destroy.

To apply this plan, comment:
    atlantis apply -d terraform/environments/production
```

This is exactly what would have prevented the Vantage outage: the plan output clearly shows `- "10.0.2.0/24"` being removed from the security group. A reviewer who reads this comment would have caught it.

---

## Policy-as-Code: Blocking Dangerous Plans at Pipeline Time

Not all plan reviews catch all dangerous operations. Policy-as-code tools evaluate Terraform plans against organization policies and fail the pipeline before a human even reviews:

```rego
# policies/terraform_safety.rego
# OPA policy: block plans that destroy production databases

package terraform

# Deny: destroying an RDS instance in production
deny[msg] {
  resource := input.resource_changes[_]
  resource.type == "aws_db_instance"
  resource.change.actions[_] == "delete"
  
  # Only enforce in production (tag-based detection)
  resource.change.before.tags.environment == "production"
  
  msg := sprintf(
    "BLOCKED: Plan would destroy production RDS instance '%s'. "
    "Database destruction requires a separate change request with DBA approval.",
    [resource.address]
  )
}

# Deny: removing a security group ingress rule that allows application access
deny[msg] {
  resource := input.resource_changes[_]
  resource.type == "aws_security_group_rule"
  resource.change.actions[_] == "delete"
  resource.change.before.type == "ingress"
  
  # Check if this rule was allowing access from an application subnet
  contains(resource.change.before.description, "application")
  
  msg := sprintf(
    "BLOCKED: Plan would delete security group rule '%s' that allows application access. "
    "Verify this is intentional before applying.",
    [resource.address]
  )
}

# Warn (not deny): any resource with a -/+ (replace) action
warn[msg] {
  resource := input.resource_changes[_]
  resource.change.actions[_] == "create"
  resource.change.actions[_] == "delete"  # -/+ replacement
  
  msg := sprintf(
    "WARNING: Resource '%s' will be destroyed and recreated. "
    "This may cause downtime. Verify this replacement is intended.",
    [resource.address]
  )
}
```

```yaml
# CI pipeline: run Conftest policy check on every Terraform plan
- name: Validate plan against policies
  run: |
    # Convert the plan to JSON for OPA evaluation
    terraform show -json plan.tfplan > plan.json
    
    # Run Conftest with the safety policies
    conftest test plan.json \
      --policy policies/ \
      --namespace terraform \
      --output tap
    
    # Exit code: 0 = all policies pass, 1 = any deny rule fired
    # The pipeline fails here if any deny rule fires, before human review
```

---

## Drift Detection: Automatic and Continuous

Drift is the divergence between what Terraform state says exists and what actually exists in the cloud. The Vantage incident was caused by a manual change that created drift — then `terraform apply` "corrected" the drift back to the state file version, which happened to remove a necessary resource.

Proactive drift detection runs `terraform plan` on a schedule against all environments and alerts when drift is detected:

```yaml
# .github/workflows/drift-detection.yml
name: IaC Drift Detection

on:
  schedule:
    # Run twice daily: 9 AM and 6 PM UTC
    - cron: "0 9,18 * * *"

jobs:
  detect-drift:
    runs-on: ubuntu-22.04
    strategy:
      matrix:
        environment: [production, staging]
    
    steps:
      - uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.6.6"

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets[format('AWS_ROLE_{0}', matrix.environment)] }}
          aws-region: us-east-1

      - name: Detect drift
        id: plan
        run: |
          cd terraform/environments/${{ matrix.environment }}
          terraform init -backend=true
          
          # -detailed-exitcode: exit 0 = no changes, exit 2 = changes detected
          terraform plan \
            -detailed-exitcode \
            -out=drift-check.tfplan \
            -lock=false \  # Read-only check — don't acquire a lock
            2>&1 | tee plan-output.txt
          
          EXIT_CODE=$?
          echo "exit_code=${EXIT_CODE}" >> $GITHUB_OUTPUT
          
          if [[ $EXIT_CODE -eq 2 ]]; then
            echo "DRIFT DETECTED in ${{ matrix.environment }}!"
            echo "drift_detected=true" >> $GITHUB_OUTPUT
          elif [[ $EXIT_CODE -eq 0 ]]; then
            echo "No drift detected in ${{ matrix.environment }}."
            echo "drift_detected=false" >> $GITHUB_OUTPUT
          else
            echo "Terraform plan failed — check for configuration errors."
            exit 1
          fi

      - name: Alert on drift
        if: steps.plan.outputs.drift_detected == 'true'
        run: |
          # Post to Slack with the plan output
          python ci/alert_drift.py \
            --environment "${{ matrix.environment }}" \
            --plan-output plan-output.txt \
            --slack-channel "#infrastructure-alerts"
```

**Responding to drift:** When drift is detected, the team has two options:
1. **Import the manual change into Terraform state:** `terraform import aws_security_group_rule.db_ingress sg-xxx/ingress/tcp/5432` — this brings the manually created resource under Terraform management without destroying it.
2. **Revert the manual change:** Apply the Terraform state as authoritative and undo the manual modification.

Option 1 is usually safer — it preserves whatever the manual change was doing and adds it to the IaC code for future management.

---

## Environment Promotion for IaC

Infrastructure changes should follow the same promotion pattern as application changes: staging → production, with automated validation at each boundary.

```
┌─────────────────┐     ┌───────────────────┐     ┌──────────────────┐
│    dev.tfvars   │     │  staging.tfvars    │     │  prod.tfvars     │
│  (small, cheap) │────▶│  (mid-scale)       │────▶│  (full scale)    │
│  auto-apply     │     │  plan review req.  │     │  2 approvals req │
└─────────────────┘     └───────────────────┘     └──────────────────┘

Promotion gate: staging must be healthy for 24h before production apply is allowed.
```

---

## The Anti-Patterns

### ❌ Anti-Pattern: `terraform apply` Without a Saved Plan

**What it looks like:** `terraform apply` run directly, which generates a new plan and applies it in one command. The plan is not saved, not reviewed, not posted to a PR.

**What breaks:** Any infrastructure that changed between when the engineer last ran `terraform plan` manually and when they run `terraform apply` may be modified unexpectedly. No review means no second pair of eyes on destructions.

**The fix:** Always `terraform plan -out=plan.tfplan` first, review the plan, then `terraform apply plan.tfplan` using the saved plan file.

---

### ❌ Anti-Pattern: Manual Changes Without Terraform Import

**What it looks like:** An engineer adds a security group rule via the AWS console for speed. The rule works. Terraform state doesn't know about it. The next `terraform apply` removes it.

**What breaks:** Configuration drift that silently accumulates until the next `terraform apply` "corrects" it and takes something down.

**The fix:** Any manual cloud console change must be followed immediately by `terraform import` to bring it under IaC management. Better: don't allow console changes at all. Use `aws_console_access_policy` SCPs to block direct resource modification in production.

---

### ❌ Anti-Pattern: Storing Sensitive Values in State Without Encryption

**What it looks like:** Terraform state stored in S3 without encryption. The state may contain RDS passwords, API keys, and other secrets that Terraform manages.

**What breaks:** Confidentiality. Anyone with S3 read access to the state bucket has all the secrets.

**The fix:** `encrypt = true` on the S3 backend, access policies restricted to Terraform service accounts only, and consider HashiCorp Vault or AWS Secrets Manager for secrets rather than Terraform variables wherever possible.

---

## Field Notes

💀 **`terraform apply` run directly in prod** → Security group corrected to stale state, database unreachable, 2-hour outage → Enforce plan-before-apply via Atlantis or Terraform Cloud. Block direct applies from developer workstations.

💀 **No drift detection** → Manual changes accumulate silently, next apply removes them → Run `terraform plan` on a schedule against all environments. Alert on drift immediately, don't wait for the next deployment.

💀 **Shared Terraform state without locking** → Two concurrent applies corrupt the state file → `dynamodb_table` in the S3 backend config is mandatory. Never run concurrent applies against the same state.

---

## Chapter Summary

IaC promotion treats infrastructure changes with the same rigor as application changes: plan as a reviewable artifact, policy-as-code to block dangerous operations at pipeline time, and drift detection to surface manual changes before they become time bombs. The Vantage incident was preventable at three points: plan review would have caught the security group rule removal, a manual-change prohibition policy would have prevented the drift, and drift detection would have caught the divergence before the next apply.

---

## What's Next

Chapter 29 addresses a deployment problem unique to serverless functions: cold start. Lambda functions that haven't been invoked recently take 100ms–3 seconds to initialize before serving the first request. Alias-based traffic shifting allows canary-style rollouts for Lambda, and provisioned concurrency eliminates cold start for latency-sensitive functions.

[→ Next: Chapter 29 — The Serverless Cold-Start & Alias Pattern](./chapter-29-serverless-cold-start-alias.md)

---
*[← Previous: Chapter 27 — The Expand-and-Contract Database Migration Pattern](./chapter-27-expand-contract-db-migration.md) |
[→ Next: Chapter 29 — The Serverless Cold-Start & Alias Pattern](./chapter-29-serverless-cold-start-alias.md)*
