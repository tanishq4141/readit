# Chapter 8: The Predictive & AI-Assisted Build Pattern
*Part II: Foundational Build & Integration Patterns (CI)*

> *"We trained a model on three years of build data. It predicts build failures
> with 78% precision. The most predictive feature, by a wide margin, is
> 'how many files in this diff end in .go'. The ML was expensive.
> The insight was free."*
> — platform engineer at a mid-size SaaS company, 2023

---

## The War Story

Priya Anand runs the developer platform team at Cascade Analytics, a data infrastructure company with 180 engineers and a CI system that processes roughly 400 builds per day. Their test suite has 28,000 tests across six services. TIA (from the previous chapter) cut CI time from 22 minutes to 8 minutes for typical PRs.

The next problem Priya identifies: of the 400 daily builds, roughly 60 (15%) fail. Her team does a 30-day analysis of why:

- 22 failures (37%): genuine bugs caught by CI — this is the CI working correctly
- 21 failures (35%): flaky tests — tests that fail non-deterministically, retried and passing
- 9 failures (15%): infrastructure issues — runner OOM, network timeout to a test dependency
- 8 failures (13%): test ordering issues — tests that pass in isolation but fail when run after a specific other test

The 22 genuine failures are the signal. The other 38 are noise — 38 engineer-interruptions per day that produce no actionable information. Each interruption costs roughly 12 minutes (investigate, determine it's flaky/infra/ordering, re-trigger). That's 456 engineer-minutes per day, or about 38 engineer-hours per day of wasted debugging time across the team.

Priya's team builds two systems:
1. A flakiness tracker that identifies tests with a historical failure rate > 2% when no code change is present (i.e., failures on re-runs of unchanged code). These tests are automatically quarantined.
2. A failure prediction model trained on 18 months of CI data that predicts, before the tests run, which tests are most likely to fail given the specific set of files changed.

Result after 90 days:
- False failure rate (flaky + infra + ordering): down 70%
- Mean time to first actionable feedback per build: from 8 minutes (waiting for TIA-selected tests to run) to 3 minutes (highest-risk tests run first)
- Predicted failures that turned out to be real: 71% precision, 84% recall

This chapter covers how to build those systems — and how to avoid the failure modes that consume more engineering time than the problems they solve.

---

## What You'll Learn

- Flakiness detection and quarantine: the minimum viable system that recovers 35% of wasted CI time
- Build failure prediction: how to use historical CI data to prioritize test execution and surface likely failures first
- Test ordering optimization: running the tests most likely to fail in the first 2 minutes, not the last 8
- AI-assisted pipeline configuration: where LLM-based tooling genuinely helps (configuration generation, failure triage) and where it doesn't (autonomous pipeline modification)
- The data requirements for predictive CI: what you need to collect now to enable predictive analytics later

---

## The Foundation: Collecting CI Telemetry

All predictive CI systems are built on CI telemetry. If you're not collecting it now, you can't build predictive systems later. Instrument your CI system to emit structured events at these points:

```python
# ci_telemetry.py — emit structured events to your analytics backend
# (BigQuery, Snowflake, ClickHouse, or even a simple S3 + Athena setup)

import json
import os
import time
from dataclasses import dataclass, asdict
from typing import Optional

@dataclass
class TestResult:
    # Identity
    build_id: str           # Unique identifier for this CI run
    commit_sha: str         # Git SHA being tested
    branch: str             # Branch name
    pr_number: Optional[int] # PR number if applicable

    # Test identity
    test_name: str          # Fully qualified test name
    test_file: str          # Source file containing the test
    test_suite: str         # Test suite / package

    # Result
    status: str             # "passed", "failed", "skipped", "flaky"
    duration_ms: int        # How long the test took
    retry_count: int        # How many times this test was retried in this run
    error_message: Optional[str]  # Error message if failed

    # Context
    runner_type: str        # "ubuntu-22.04", "self-hosted-large", etc.
    changed_files: list     # Files changed in this commit (for feature engineering)
    timestamp: int          # Unix timestamp

def emit_test_result(result: TestResult):
    # Emit to your telemetry backend. Structure varies by system.
    # This example writes to stdout in JSON (captured by CI log aggregator).
    # In production: send to BigQuery via streaming insert, Kafka topic, etc.
    print(json.dumps({
        "event_type": "test_result",
        **asdict(result)
    }))

@dataclass  
class BuildResult:
    build_id: str
    commit_sha: str
    branch: str
    pr_number: Optional[int]
    
    # Build outcome
    status: str             # "passed", "failed", "cancelled"
    failure_category: Optional[str]  # "test_failure", "flaky", "infra", "config"
    
    # Timing
    queued_at: int          # When build was queued
    started_at: int         # When first runner picked it up (measures queue time)
    completed_at: int
    
    # Change context (features for prediction models)
    files_changed: list[str]
    lines_added: int
    lines_removed: int
    authors: list[str]      # Who authored the commits in this build
    time_since_last_build: int  # Seconds since previous build on this branch
```

Store this data somewhere queryable. A simple schema in BigQuery (or equivalent):

```sql
-- test_results table
CREATE TABLE ci.test_results (
  build_id STRING,
  commit_sha STRING,
  branch STRING,
  test_name STRING,
  test_file STRING,
  status STRING,         -- 'passed', 'failed', 'flaky'
  duration_ms INT64,
  retry_count INT64,
  error_message STRING,
  changed_files ARRAY<STRING>,
  timestamp TIMESTAMP
)
PARTITION BY DATE(timestamp)
CLUSTER BY test_name, branch;
-- Partition by date for cost-efficient queries on recent data.
-- Cluster by test_name for efficient flakiness queries (find all runs of a specific test).
```

---

## Flakiness Detection and Quarantine

Flaky tests are the highest-ROI problem to solve in CI. They are cheaper to address than failure prediction (no ML required) and their impact is immediate and measurable.

### Defining Flakiness Precisely

A test is flaky if it exhibits non-deterministic behavior: it fails in some runs and passes in others on the same code, with no code change in between.

The practical definition: a test is flaky if, across the last N runs of the test on the same commit (or on commits where the test file and its dependencies didn't change), the pass rate is between 1% and 99%. A test that always passes is not flaky. A test that always fails is broken, not flaky.

```sql
-- Query: identify flaky tests in the last 30 days
-- A flaky test fails in some runs but not others on the same code.
WITH test_runs AS (
  SELECT
    test_name,
    test_file,
    commit_sha,
    status,
    retry_count,
    timestamp
  FROM ci.test_results
  WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    AND branch = 'main'  -- Focus on main branch for reliable baseline
),

flakiness_stats AS (
  SELECT
    test_name,
    test_file,
    COUNT(*) AS total_runs,
    COUNTIF(status = 'failed') AS failures,
    COUNTIF(status = 'passed') AS passes,
    COUNTIF(retry_count > 0) AS required_retries,
    -- A test with retries that eventually passed = flaky
    SAFE_DIVIDE(COUNTIF(status = 'failed'), COUNT(*)) AS failure_rate
  FROM test_runs
  GROUP BY test_name, test_file
  HAVING total_runs >= 10  -- Only report on tests with enough runs to be meaningful
)

SELECT
  test_name,
  test_file,
  total_runs,
  failures,
  failure_rate,
  required_retries,
  -- Classify: failure_rate between 1% and 50% = flaky
  -- failure_rate > 50% = broken (usually)
  CASE
    WHEN failure_rate BETWEEN 0.01 AND 0.50 THEN 'flaky'
    WHEN failure_rate > 0.50 THEN 'broken'
    ELSE 'stable'
  END AS classification
FROM flakiness_stats
WHERE failure_rate > 0.01  -- Exclude tests that never fail
ORDER BY failure_rate DESC;
```

### The Quarantine Mechanism

When a test is classified as flaky, it enters quarantine: it continues to run in CI (you want to know if it starts failing deterministically), but its result does not block the pipeline.

```yaml
# Quarantined tests run in a separate job that is always advisory.
# They produce a report but don't block merging.
flaky-quarantine:
  runs-on: ubuntu-22.04
  continue-on-error: true  # Never blocks the pipeline
  steps:
    - uses: actions/checkout@v4

    - name: Run quarantined tests
      run: |
        # Load the quarantine list from a file maintained by the platform team.
        # This file is updated by the flakiness detection pipeline.
        QUARANTINED=$(cat .ci/quarantined-tests.txt | tr '\n' ',' | sed 's/,$//')

        pytest tests/ \
          --run-only="$QUARANTINED" \
          --junitxml=quarantine-results.xml \
          -v

    - name: Upload quarantine results
      uses: actions/upload-artifact@v4
      with:
        name: quarantine-results
        path: quarantine-results.xml

    - name: Notify if quarantined test is now deterministically failing
      run: |
        # If a quarantined test fails 5 times in a row with no code change,
        # it's no longer flaky — it's broken. Alert the owning team.
        python .ci/analyze_quarantine.py \
          --results quarantine-results.xml \
          --threshold 5 \
          --notify-slack ${{ secrets.SLACK_CI_CHANNEL }}
```

The quarantine list (`quarantined-tests.txt`) is managed by a separate automated pipeline that runs the flakiness query nightly and updates the file via a PR (so the quarantine list is version-controlled and reviewable):

```python
# .ci/update_quarantine.py — runs nightly to update the quarantine list
import bigquery
import subprocess

def update_quarantine_list(threshold: float = 0.05, min_runs: int = 20):
    """Find flaky tests above threshold and update the quarantine file."""
    client = bigquery.Client()
    
    query = """
    SELECT test_name FROM ci.test_results
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      AND branch = 'main'
    GROUP BY test_name
    HAVING COUNT(*) >= @min_runs
      AND SAFE_DIVIDE(COUNTIF(status = 'failed'), COUNT(*)) >= @threshold
    ORDER BY SAFE_DIVIDE(COUNTIF(status = 'failed'), COUNT(*)) DESC
    """
    
    results = client.query(query, {"min_runs": min_runs, "threshold": threshold})
    flaky_tests = [row.test_name for row in results]
    
    with open('.ci/quarantined-tests.txt', 'w') as f:
        f.write('\n'.join(flaky_tests))
    
    # Open a PR with the updated quarantine list if it changed.
    subprocess.run(['git', 'add', '.ci/quarantined-tests.txt'])
    if subprocess.run(['git', 'diff', '--cached', '--exit-code']).returncode != 0:
        subprocess.run(['gh', 'pr', 'create',
            '--title', f'chore: update quarantine list ({len(flaky_tests)} tests)',
            '--body', f'Automated update: {len(flaky_tests)} tests classified as flaky'])
```

---

## Build Failure Prediction

Failure prediction moves beyond "which tests cover the changed code" (TIA) to "which tests are most likely to fail for this specific change." The distinction: TIA is deterministic and graph-based. Failure prediction is probabilistic and history-based.

### Feature Engineering

The inputs to a failure prediction model come from git metadata and historical CI outcomes:

```python
# feature_engineering.py — extract features for failure prediction
from pathlib import Path
import subprocess

def extract_build_features(commit_sha: str, base_sha: str) -> dict:
    """Extract features from a commit for failure prediction."""
    
    # Git metadata features
    diff_output = subprocess.check_output(
        ['git', 'diff', '--stat', f'{base_sha}...{commit_sha}'],
        text=True
    )
    
    changed_files = subprocess.check_output(
        ['git', 'diff', '--name-only', f'{base_sha}...{commit_sha}'],
        text=True
    ).strip().split('\n')
    
    features = {
        # File count features
        'total_files_changed': len(changed_files),
        'test_files_changed': sum(1 for f in changed_files if 'test' in f.lower()),
        'config_files_changed': sum(1 for f in changed_files if f.endswith(('.yaml', '.json', '.toml'))),
        'source_files_changed': sum(1 for f in changed_files if f.endswith(('.go', '.py', '.ts', '.java'))),
        
        # File location features (high-impact files increase failure probability)
        'auth_files_changed': sum(1 for f in changed_files if 'auth' in f),
        'database_files_changed': sum(1 for f in changed_files if 'db' in f or 'model' in f),
        'api_files_changed': sum(1 for f in changed_files if 'api' in f or 'handler' in f),
        
        # Change size features
        'lines_added': int(subprocess.check_output(
            ['git', 'diff', '--shortstat', f'{base_sha}...{commit_sha}'],
            text=True
        ).split('insertions')[0].split(',')[-1].strip().split()[0] or 0),
        
        # Author history (authors with recent failures have slightly higher failure rate)
        'author_recent_failure_rate': _get_author_failure_rate(commit_sha),
        
        # Temporal features
        'hour_of_day': __import__('datetime').datetime.now().hour,
        'is_friday': __import__('datetime').datetime.now().weekday() == 4,  # Fridays correlate with higher failure rate
        
        # Time since last successful build
        'hours_since_last_success': _get_hours_since_last_success(),
    }
    
    return features

def _get_author_failure_rate(commit_sha: str) -> float:
    """Query BigQuery for the commit author's recent CI failure rate."""
    # Implementation queries the ci.build_results table
    # Returns: float between 0 and 1
    ...
```

### The Prediction Model

The simplest effective failure prediction model is a gradient-boosted tree (XGBoost or LightGBM) trained on historical build features and outcomes. The model is simple enough to inspect — you can see which features matter most — and accurate enough to be useful.

```python
# train_failure_predictor.py
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import precision_recall_fscore_support
from google.cloud import bigquery

def train_model():
    # Load 18 months of build data from BigQuery
    client = bigquery.Client()
    
    df = client.query("""
    SELECT
      -- Features (these must match the features extracted at prediction time)
      total_files_changed,
      test_files_changed,
      config_files_changed,
      source_files_changed,
      auth_files_changed,
      database_files_changed,
      api_files_changed,
      lines_added,
      author_recent_failure_rate,
      hour_of_day,
      is_friday,
      hours_since_last_success,
      
      -- Label: did this build fail with a genuine test failure?
      -- Exclude flaky and infra failures (they're noise, not signal)
      CASE WHEN failure_category = 'test_failure' THEN 1 ELSE 0 END AS failed
    FROM ci.build_results
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 18 MONTH)
      AND branch IN ('main', 'release')  -- Training on stable branches only
    """).to_dataframe()
    
    feature_cols = [c for c in df.columns if c != 'failed']
    X = df[feature_cols]
    y = df['failed']
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    model = lgb.LGBMClassifier(
        n_estimators=200,
        learning_rate=0.05,
        num_leaves=31,
        # class_weight='balanced' because ~85% of builds pass (class imbalance)
        class_weight='balanced',
        random_state=42
    )
    model.fit(X_train, y_train)
    
    # Evaluate
    y_pred = model.predict(X_test)
    precision, recall, f1, _ = precision_recall_fscore_support(y_test, y_pred, average='binary')
    print(f"Precision: {precision:.3f}, Recall: {recall:.3f}, F1: {f1:.3f}")
    
    # Feature importance — often the most valuable output
    importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    print(importance.head(10))
    
    return model
```

### Using Predictions: Test Ordering

The most immediate use of failure predictions is test ordering: run the tests most likely to fail first. If the model predicts 78% chance of failure and there's an authentication-related test in the affected set, run it in the first batch. If the build is going to fail, surface the failure in the first 2 minutes, not the last 8.

```python
# order_tests.py — reorder tests by predicted failure probability
import json
import subprocess

def order_tests_by_risk(test_names: list[str], features: dict) -> list[str]:
    """Order tests with highest failure probability first."""
    
    # Load the test-level failure probability model
    # (trained separately: for each test, what's its failure probability
    # given these build features?)
    model = load_test_failure_model()
    
    test_features = []
    for test in test_names:
        # Features specific to this test:
        # - Historical failure rate for this test
        # - Whether this test covers any of the changed files
        # - Average duration of this test
        test_features.append({
            **features,
            'test_historical_failure_rate': get_test_failure_rate(test),
            'test_covers_changed_file': covers_changed_file(test, features['changed_files']),
            'test_avg_duration_ms': get_test_avg_duration(test),
        })
    
    failure_probs = model.predict_proba(test_features)[:, 1]
    
    # Sort tests: highest failure probability first,
    # with ties broken by shortest duration (fail fast on cheap tests)
    sorted_tests = sorted(
        zip(test_names, failure_probs),
        key=lambda x: (-x[1], get_test_avg_duration(x[0]))
    )
    
    return [test for test, _ in sorted_tests]
```

```yaml
# In CI: use the ordered test list
      - name: Compute test order
        run: |
          python .ci/order_tests.py \
            --tests $(bazel query "kind('.*_test', rdeps(//..., changed))") \
            --features ${{ toJSON(steps.features.outputs) }} \
            --output ordered-tests.txt

      - name: Run tests (highest risk first)
        run: |
          # Run the first 20% of tests (highest risk) with immediate output.
          # If any fail, the build stops here with fast feedback.
          head -n $(( $(wc -l < ordered-tests.txt) / 5 )) ordered-tests.txt | \
            xargs bazel test --test_output=errors

          # Run the remaining 80% in parallel.
          tail -n +$(( $(wc -l < ordered-tests.txt) / 5 + 1 )) ordered-tests.txt | \
            xargs bazel test --test_output=errors --jobs=16
```

---

## AI-Assisted Pipeline Configuration

LLM-based tooling has genuine value in two CI contexts. It also has failure modes that require understanding before adoption.

### Where LLMs Help: Pipeline Configuration Generation

Writing GitHub Actions YAML, GitLab CI YAML, or Bazel BUILD files is tedious and error-prone for new users. The syntax is complex, the options are numerous, and the documentation is often incomplete. LLMs are genuinely useful here: given a description of what you want ("a CI pipeline for a Go service that builds a Docker image and pushes to ECR"), a capable LLM generates a correct starting point quickly.

**The honest caveat:** LLM-generated CI configurations are starting points, not finished configurations. They require review by someone who understands the security implications (secrets handling, permissions), the performance implications (caching, parallelism), and the correctness requirements (pinned versions, hermetic builds). A LLM will generate a valid-looking YAML that uses `docker/login-action` without explaining that you need to scope the token's permissions or that you should not expose secrets to PRs from forks.

**The recommended workflow:**
1. Use the LLM to generate a draft configuration
2. Review the security model: how are secrets scoped? Are permissions minimal?
3. Review the hermeticity: are base images pinned? Are lockfiles used?
4. Review the caching: is the cache keyed correctly? Is it safe?
5. Add the fan-out / fan-in structure if it's missing
6. Run it and iterate

### Where LLMs Help: Failure Triage

An LLM given a CI failure log can often identify the root cause faster than a developer reading the log manually. The CI failure log is structured text with a known vocabulary; LLMs that have been trained on large corpora of CI logs (Copilot for CLI, specialized CI triage tools) can identify "this is a DNS resolution failure in the test container" from a 1,500-line log in seconds.

```python
# failure_triage.py — use an LLM to triage CI failures
import anthropic

def triage_failure(log_output: str, changed_files: list[str]) -> str:
    """Given CI failure output, produce a triage summary."""
    client = anthropic.Anthropic()
    
    response = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": f"""You are a CI/CD expert triaging a build failure.

Changed files in this build:
{chr(10).join(changed_files)}

CI failure output (last 200 lines):
{log_output[-8000:]}  # Truncate to avoid token limits

Please provide:
1. Root cause (1-2 sentences)
2. Is this likely related to the changed files? (yes/no/maybe)
3. Is this likely a flaky test? (yes/no/maybe, with reasoning)
4. Recommended next action (1-2 sentences)

Be specific. If you can identify a specific test name, file, or line number, include it."""
        }]
    )
    
    return response.content[0].text
```

### Where LLMs Don't Help: Autonomous Pipeline Modification

The current generation of LLM agents (including the most capable available in 2024–2025) should not autonomously modify CI pipeline definitions or deployment configurations. The failure modes are severe:

- A pipeline modification that introduces a security vulnerability (weakening permissions, exposing secrets) can be difficult to detect and has broad blast radius
- LLMs confidently generate plausible-looking configurations that are subtly wrong in ways that only manifest under specific conditions
- "Self-healing CI" that modifies its own configuration in response to failures can produce a feedback loop that degrades the pipeline over time

The correct model: LLMs assist human engineers with suggestions, triage, and drafts. Engineers review, understand, and approve all pipeline modifications. Chapter 62 covers agentic CI/CD in depth — including the current state of autonomous agents and why the safety constraints are not temporary.

---

## Scale Considerations

**At 0–1,000 tests:** Flakiness tracking is the only predictive investment worth making. Simple SQL query against your CI system's data, weekly review, quarantine the top 10 flaky tests. No ML required.

**At 1,000–10,000 tests:** Test ordering by historical failure rate is valuable. A lookup table (test_name → historical failure rate) sorted by failure rate is sufficient. No ML model needed — a frequency table beats a complex model for this scale.

**At 10,000–100,000 tests:** Feature-based failure prediction (the LightGBM model above) starts paying off. You need 6+ months of build data to train a useful model. Plan your telemetry collection now.

**At 100,000+ tests:** This is Google's territory. Google's Test Selection System (TSS) uses a combination of change impact analysis, historical coverage data, and ML to select tests. For most engineering organizations, this scale requires dedicated tooling investment or commercial solutions (Launchable, BuildPulse, Gradle Enterprise).

---

## The Anti-Patterns

### ❌ Anti-Pattern: Using Failure Prediction Without Flakiness Filtering

**What it looks like:** The failure prediction model is trained on all historical failures, including flaky test failures. The model learns that "tests in the authentication module fail frequently" — not because authentication code is buggy, but because three of those tests are flaky. The model predicts authentication failures for every PR that touches auth, creating false urgency.

**Why it happens:** Training data isn't cleaned before model training.

**What breaks:** Model precision. Flaky failures are noise; training on them teaches the model to predict noise.

**The fix:** Filter flaky failures from the training data. A build outcome is only labeled "failure" if the failure was not resolved by a retry and the same commit passed on a subsequent run.

---

### ❌ Anti-Pattern: Acting on Low-Confidence Predictions

**What it looks like:** The failure prediction model outputs "34% probability of failure." The CI system re-orders tests significantly, running the predicted failures first. The developer sees an "AI predicted your build will fail" warning before any tests run. The build passes. This happens 66% of the time for that prediction threshold.

**Why it happens:** The team uses model predictions without considering the confidence level.

**What breaks:** Developer trust in the system. If the "predicted failure" warning fires on passing builds two-thirds of the time, developers learn to ignore it — and then ignore the 34% of cases where it's right.

**The fix:** Only surface predictions when confidence is high (>80%). Use lower-confidence predictions silently for test ordering only, not for user-visible warnings.

---

### ❌ Anti-Pattern: The Self-Updating CI Pipeline

**What it looks like:** An LLM agent is configured to watch for CI failures, analyze the root cause, and propose (or worse, automatically apply) changes to the pipeline configuration to fix them.

**Why it happens:** The appeal of self-healing infrastructure is real. Autonomous remediation sounds like reduced operational burden.

**What breaks:** Security posture, configuration auditability, and the trust model of the CI system. A CI pipeline that modifies itself is a CI pipeline that can be manipulated by a sufficiently clever CI failure — triggering an LLM analysis that produces a malicious configuration suggestion.

**The fix:** LLMs can analyze failures and suggest fixes. A human must review and approve the suggestion before it's applied. The review step is not overhead — it's the control plane.

---

## Field Notes

💀 **Not collecting CI telemetry** → Can't build any predictive system; can't answer "what's our flaky test rate?" → Instrument now. Even basic JSON logs to S3 parsed by Athena is enough to start.

💀 **Quarantine list that grows and is never drained** → Quarantine becomes a permanent home for broken tests → Quarantine is a 2-week holding period. A test quarantined for 2 weeks with no fix is deleted. Quarantine is not an excuse for deferring test maintenance.

💀 **Over-trusting LLM-generated CI configuration** → Security vulnerabilities, non-hermetic builds, broken caching → LLM configs are drafts. Review every security-relevant field: permissions, secret scoping, network access, fork PR handling.

💀 **Training on <6 months of data** → Model is poorly calibrated, seasonal patterns not captured → Wait for 12 months of data before training a failure prediction model. The flakiness tracker can start with 30 days.

---

## Chapter Summary

The predictive CI pattern has two components worth investing in at different scales: flakiness detection (universally applicable, no ML required, high immediate ROI) and failure prediction (applicable at 10K+ tests, requires historical data, provides test ordering and early warning capabilities).

The honest assessment of AI-assisted CI tooling in 2024: LLMs are useful for pipeline configuration generation and failure triage summarization. They are not ready for autonomous pipeline modification. The value of human review in the loop is not just organizational conservatism — it's the control plane that prevents a sophisticated attack from using the LLM as a vector to modify CI pipeline behavior.

Invest in telemetry first. You cannot build predictive systems on data you haven't collected. The flakiness query from this chapter can run today against your existing CI data if you have a database with historical test results. Everything else requires the telemetry foundation.

---

## What's Next

Chapter 9 addresses the infrastructure that all of Part II's patterns run on: dynamic provisioning. On-demand runners that spin up per-job and tear down after, Kubernetes-based CI infrastructure that scales with demand, and the economics of warm pools vs. scale-to-zero. If the patterns in Chapters 3–8 are the CI strategy, Chapter 9 is the CI substrate.

[→ Next: Chapter 9 — The Dynamic Provisioning Pattern](./chapter-09-dynamic-provisioning.md)

---
*[← Previous: Chapter 7 — The Test Impact Analysis (TIA) Pattern](./chapter-07-test-impact-analysis.md) |
[→ Next: Chapter 9 — The Dynamic Provisioning Pattern](./chapter-09-dynamic-provisioning.md)*
