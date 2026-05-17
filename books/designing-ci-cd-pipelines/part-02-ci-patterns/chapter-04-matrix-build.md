# Chapter 4: The Matrix Build Pattern
*Part II: Foundational Build & Integration Patterns (CI)*

> *"We tested it. Just not on the version our users were running."*
> — the sentence that ends careers

---

## The War Story

Sofia Reyes maintains `pyvalidate`, an open-source Python data validation library with 340,000 weekly downloads on PyPI. In September 2022, she merges a contribution from a new community member — a performance optimization for the `validate_email` function that uses the `re.fullmatch` API. The tests pass. The PR is clean. She merges and releases v2.1.0.

Four days later, her GitHub Issues queue looks like a fire alarm panel.

The issue title, repeated with minor variations across eighteen separate reports: `AttributeError: module 're' has no attribute 'fullmatch'`.

`re.fullmatch` was introduced in Python 3.4. `pyvalidate`'s stated minimum Python version is 3.6. On Python 3.4 and 3.5, the library now crashes immediately on import.

But wait — Sofia's CI says Python 3.6+ is supported. Her CI ran the tests on Python 3.9. Not 3.6. Not 3.7. Not 3.8. Just 3.9, because that's the version installed on her GitHub Actions runner and nobody had set up a matrix.

The blast radius: 340,000 weekly downloads. Unknown fraction running Python 3.6, 3.7, or 3.8. `pyvalidate` v2.1.0 silently breaks their validation on import, with no warning before the crash. Downstream systems that import `pyvalidate` without a try/except fail silently or crash depending on their error handling. Three downstream libraries that depend on `pyvalidate` are indirectly broken.

Hotfix v2.1.1 ships in three hours, replacing `re.fullmatch` with a compatibility shim. But the damage — broken pipelines, user trust eroded, a CVE-level regression in a security-adjacent library — is done.

The root cause: the CI matrix covered one Python version out of five that users depend on. The fix: a matrix that covers all of them. The cost of adding the matrix: 45 minutes of configuration work. The cost of not having it: three days of incident response and a permanent note in the project's issue tracker.

---

## What You'll Learn

- The matrix build pattern: what it is, when it applies, and what the correct dimensions are for different project types
- Implementation in GitHub Actions, GitLab CI, and Azure Pipelines — including the specific configuration choices that prevent combinatorial explosion
- Intelligent matrix pruning: how to test full coverage on main without bankrupting yourself on every PR
- Fail-fast and fail-slow strategies: when you want early exit and when you need complete coverage
- The matrix expansion problem and the five techniques for keeping it under control

---

## The Matrix Build Pattern: What It Is

A matrix build is a CI configuration that runs the same set of build and test steps across multiple combinations of variables. The variables form a matrix: each combination of variable values becomes a separate CI job.

The canonical case is a cross-platform library:

```
Dimensions:
  os:      [ubuntu-22.04, macos-13, windows-2022]
  python:  [3.8, 3.9, 3.10, 3.11, 3.12]

Matrix: 3 × 5 = 15 jobs
```

Fifteen jobs run in parallel. Each job installs a specific Python version on a specific OS and runs the test suite. If the test for Python 3.8 on Ubuntu fails, the failure is visible immediately, in the CI run that contains the change that caused it.

The matrix build pattern answers the question: *Does this change work correctly across every context our users depend on?* The "context" can be any variable that affects the behavior of the software:

- **Language runtime versions** (Python 3.8–3.12, Node.js 18/20/22, Ruby 3.1/3.2/3.3, Go 1.21/1.22)
- **Operating systems** (Linux, macOS, Windows)
- **CPU architectures** (amd64, arm64, armv7)
- **Database versions** (Postgres 14/15/16, MySQL 8.0/8.1)
- **Dependency versions** (testing against the minimum supported version and the latest version of a critical dependency)
- **Build configurations** (debug/release, with/without optional features, FIPS mode enabled/disabled)

The matrix is not optional for libraries. It is a correctness requirement. A library that claims compatibility with Python 3.8–3.12 but only tests on 3.11 is making a claim it has not verified. That unverified claim will eventually be falsified in a user's production environment, not in CI.

For services (deployed to a fixed environment), the matrix is optional but useful. You probably don't need to test your payment service on Windows. You probably do want to test it on both amd64 and arm64 if you're deploying to a mixed Kubernetes cluster that includes Graviton (arm64) nodes.

---

## Implementation: GitHub Actions Matrix Strategy

GitHub Actions' `matrix` strategy is the most widely used matrix build implementation. It is powerful, but has non-obvious failure modes that catch teams regularly.

### Basic Matrix Configuration

```yaml
# .github/workflows/test-matrix.yml
name: Test Matrix

on: [push, pull_request]

jobs:
  test:
    name: Test Python ${{ matrix.python-version }} on ${{ matrix.os }}
    runs-on: ${{ matrix.os }}

    strategy:
      # fail-fast: true (default) means: if one matrix job fails, cancel all
      # remaining jobs immediately. This saves CI minutes when you know the
      # build is broken, but prevents you from seeing ALL failures across the
      # matrix in a single run.
      # 
      # fail-fast: false means: run all matrix jobs to completion even if some
      # fail. Better for debugging — you see "fails on Python 3.8, passes on 3.9+"
      # rather than just "failed" with the rest cancelled.
      #
      # For PRs: fail-fast: true is usually right (save minutes, fail early)
      # For the main branch: fail-fast: false (get full failure picture)
      fail-fast: false

      matrix:
        os: [ubuntu-22.04, macos-13, windows-2022]
        python-version: ["3.8", "3.9", "3.10", "3.11", "3.12"]

        # Exclusions: remove specific combinations that don't make sense.
        # Example: a dependency doesn't support Windows on Python 3.8.
        # Rather than letting those jobs fail, exclude them explicitly and
        # document why in a comment.
        exclude:
          # some-legacy-dep doesn't support Windows + Python < 3.9
          - os: windows-2022
            python-version: "3.8"

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python ${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
          # Cache pip dependencies per Python version.
          # Different Python versions have different wheel artifacts,
          # so the cache key must include the Python version.
          cache: pip
          cache-dependency-path: requirements/*.txt

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          # Install in --no-deps mode for the main package to test that
          # our declared dependencies are complete.
          pip install -r requirements/base.txt
          pip install -r requirements/test.txt

      - name: Run tests
        run: pytest tests/ -v --tb=short

      - name: Upload test results
        # Always upload, even on failure — lets you compare results
        # across matrix dimensions in the Actions summary.
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${{ matrix.os }}-${{ matrix.python-version }}
          path: test-results.xml
```

### Including Specific Extra Combinations

Sometimes you need to test one extra combination that isn't part of the regular matrix — a specific OS/version pairing that warrants deeper testing, or an experimental dimension you're evaluating:

```yaml
    strategy:
      matrix:
        os: [ubuntu-22.04, macos-13]
        python-version: ["3.10", "3.11", "3.12"]

        # include: adds specific jobs to the matrix that don't fit the regular grid.
        # Use case: test Python 3.13 (pre-release) to catch forward-compatibility
        # issues before 3.13 GA, without committing to full 3.13 support yet.
        include:
          - os: ubuntu-22.04
            python-version: "3.13.0-alpha.3"
            # Custom variable available in matrix context for this job only.
            # Used below to mark this job as allowed to fail.
            experimental: true

    steps:
      # ...
      - name: Run tests
        # continue-on-error: true means this job can fail without failing the
        # overall workflow. Use for experimental/informational matrix entries.
        continue-on-error: ${{ matrix.experimental == true }}
        run: pytest tests/ -v
```

---

## Implementation: GitLab CI Parallel Matrix

GitLab CI's `parallel:matrix` syntax is slightly different but equivalent in capability:

```yaml
# .gitlab-ci.yml

test:
  image: python:${PYTHON_VERSION}-slim
  
  parallel:
    matrix:
      - PYTHON_VERSION: ["3.8", "3.9", "3.10", "3.11", "3.12"]
        OS_TARGET: ["linux"]  # GitLab CI runners are Linux only;
                               # use GitHub Actions or Azure for cross-OS

  before_script:
    - pip install -r requirements/test.txt --quiet

  script:
    - pytest tests/ --junitxml=report.xml

  artifacts:
    reports:
      # GitLab parses JUnit XML and shows test results in the MR UI.
      junit: report.xml
    # Keep artifacts for 7 days. Long enough for retrospective debugging,
    # short enough not to accumulate storage cost indefinitely.
    expire_in: 7 days

  # GitLab CI interoperability: use rules to control when the matrix runs.
  # On MRs: run the matrix. On main branch merges: run plus upload coverage.
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

---

## The Combinatorial Explosion Problem

Here is the number nobody talks about when recommending matrix builds: **the combinatorial explosion**.

Start with a reasonable matrix for a widely-used library:
- 5 Python versions
- 3 operating systems
- 2 architectures (amd64, arm64)
- 2 database versions (the minimum supported and latest)

That's 5 × 3 × 2 × 2 = **60 jobs**. At 5 minutes per job with 20 concurrent runners, that's 300 compute-minutes per CI run. If you run CI 200 times per day across all branches, you're spending 60,000 compute-minutes per day, or 1,000 compute-hours. At GitHub Actions pricing (~$0.008/minute for ubuntu runners, ~$0.016 for macOS), that's $480–$960 per day. Monthly: $14,400–$28,800.

For a company with 200 engineers, that's not catastrophic. For a startup with 10 engineers, it's a budget line that generates questions at all-hands meetings.

The five techniques for keeping the matrix under control:

### Technique 1: Tiered Matrix by Branch

Run the full matrix on main. Run a reduced matrix on PRs. The logic: PRs get fast feedback on the most important dimensions; the main branch merge gets full verification.

```yaml
    strategy:
      matrix:
        # On PRs: test only the latest stable versions for speed.
        # On main: test the full matrix for completeness.
        python-version: ${{ github.ref == 'refs/heads/main' && fromJSON('["3.8", "3.9", "3.10", "3.11", "3.12"]') || fromJSON('["3.8", "3.12"]') }}
        os: ${{ github.ref == 'refs/heads/main' && fromJSON('["ubuntu-22.04", "macos-13", "windows-2022"]') || fromJSON('["ubuntu-22.04"]') }}
```

The PR matrix covers the minimum Python version (3.8, most likely to have regressions) and the current latest (3.12, most likely to have forward-compatibility issues). The macOS and Windows coverage waits for the main branch merge.

**Trade-off:** A regression on Python 3.9, macOS, won't be caught until the main branch merge. For most projects this is acceptable — the cost of false negatives is low and the cost of full CI on every PR branch is high.

### Technique 2: Test Impact Routing Within the Matrix

Not every change needs every matrix dimension. A change to a pure Python algorithm doesn't need Windows coverage; it needs Python version coverage. A change to platform-specific filesystem handling doesn't need Python version coverage; it needs OS coverage.

This is harder to implement in practice but powerful at scale: use the Test Impact Analysis pattern (Chapter 7) to route changes to the matrix dimensions that are relevant to what changed.

### Technique 3: Sharding Within Matrix Jobs

If each matrix job has a test suite that takes 20 minutes, and you have 15 matrix jobs, the total matrix takes 300 minutes even with full parallelism (because each job runs all tests). Sharding splits the test suite across multiple workers:

```yaml
    strategy:
      matrix:
        python-version: ["3.8", "3.9", "3.10", "3.11", "3.12"]
        os: [ubuntu-22.04, macos-13, windows-2022]
        # Shard the test suite across 4 workers per OS/version combination.
        # Total jobs: 5 × 3 × 4 = 60. Each job runs 1/4 of the tests.
        # With 60 concurrent runners and 5-minute jobs: 5 minutes total CI time
        # instead of 20 minutes. (60 runners is expensive; right-size for your scale.)
        shard: [1, 2, 3, 4]

    steps:
      - name: Run tests (shard ${{ matrix.shard }} of 4)
        run: |
          pytest tests/ \
            --shard-id=${{ matrix.shard }} \
            --num-shards=4 \
            --junitxml=test-results-shard-${{ matrix.shard }}.xml
          # pytest-shard plugin splits the test suite deterministically
          # by test node ID hash. Each shard gets roughly 1/N of the tests.
```

### Technique 4: Caching Aggressively Across Matrix Dimensions

Each matrix job should restore and populate a build cache keyed by its specific dimension values. Without this, every matrix job reinstalls all dependencies from scratch, multiplying your per-job overhead by the number of matrix dimensions.

```yaml
      - name: Cache pip packages
        uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          # Include Python version in cache key — different versions have
          # different wheel artifacts and cannot share a cache.
          key: pip-${{ matrix.os }}-${{ matrix.python-version }}-${{ hashFiles('requirements/*.txt') }}
          # Restore from a partial match: same OS, same Python version,
          # different requirements hash. Gets most of the packages from cache,
          # only installs the delta.
          restore-keys: |
            pip-${{ matrix.os }}-${{ matrix.python-version }}-
            pip-${{ matrix.os }}-
```

### Technique 5: Nightly Full Matrix, PR Reduced Matrix

For large matrices, run the full matrix on a nightly schedule rather than on every commit. PRs get the fast reduced matrix; the nightly run catches regressions across the full dimension space. This is particularly useful for dimensions that change rarely (e.g., testing against a new database version that was just released).

```yaml
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    # Run nightly at 2 AM UTC
    - cron: '0 2 * * *'

jobs:
  test:
    strategy:
      matrix:
        python-version: ${{ (github.event_name == 'schedule') && fromJSON('["3.8","3.9","3.10","3.11","3.12"]') || fromJSON('["3.8","3.12"]') }}
        os: ${{ (github.event_name == 'schedule') && fromJSON('["ubuntu-22.04","macos-13","windows-2022"]') || fromJSON('["ubuntu-22.04"]') }}
```

---

## When the Matrix Build Pattern Breaks

### Break Mode 1: OS-Dependent Test Behavior Without OS-Specific Assertions

Running tests on Windows reveals that your Linux-only test suite has a Windows problem: path separators. Your code uses `os.path.join()`, but one test hardcodes `/tmp/test-fixture.json` as an expected path. On Linux, this passes. On Windows, `tmp` doesn't exist and the path separator is `\`, so the test fails in ways that have nothing to do with your code's behavior.

The symptom: a large fraction of Windows matrix jobs fail with path-related errors. The fix is not to exclude Windows from the matrix — it's to fix the test. Use `tmp_path` (pytest fixture), `tempfile.mkdtemp()`, or `pathlib.Path` rather than hardcoded Unix paths.

### Break Mode 2: Matrix Jobs That Share Mutable State

Matrix jobs run in parallel. If they share a mutable resource — a database, a file on a shared filesystem, a third-party API with rate limits — they will interfere with each other in timing-dependent ways. The failure mode is intermittent: tests pass when run alone, fail when run concurrently with other matrix jobs.

The fix: each matrix job must own its own isolated resources. Use per-job database namespaces (`test_db_py39_ubuntu`, `test_db_py311_ubuntu`), per-job temp directories, and per-job rate limit tokens. The Dynamic Provisioning pattern (Chapter 9) covers how to spin up per-job ephemeral infrastructure.

### Break Mode 3: Exponential Matrix Growth Without Budget Control

A matrix that starts with 3 dimensions and grows to 6 dimensions over 18 months becomes 729 jobs (3^6). This happens organically: someone adds a new OS version, someone adds a new runtime version, someone adds a new deployment target. Each addition seems reasonable in isolation. The compound effect is a matrix that takes 40 minutes and costs more than the team's AWS bill.

The symptom is slow: your matrix CI run starts taking 45+ minutes even with full parallelism. Detection: track CI compute cost per merge to main as a metric. Set an alert at 2x the baseline cost.

The fix: treat the matrix as a budget. Every time a dimension is added, something must be removed. The oldest supported Python version that accounts for less than 3% of downloads is a candidate for removal. Track version distribution in your download stats (PyPI provides this), set a deprecation policy, and enforce it.

---

## Scale Considerations

**At 1–5 services/libraries:** A 2×3 or 3×3 matrix (OS × runtime version) is sufficient and costs pennies. Don't overthink it. Add it now; optimize later.

**At 5–20 services/libraries:** Per-PR reduced matrix + per-merge full matrix is the right model. The economics work: PRs are 10× more frequent than merges; spending 10× less per PR is the correct trade.

**At 20+ services in a monorepo:** The matrix multiplies across services. 20 services × 15 matrix jobs each = 300 jobs per CI run. The only economical approach is Test Impact Analysis (Chapter 7) to run only the matrix dimensions relevant to the changed service, plus Bazel's remote cache to avoid rebuilding unchanged services at all.

**Numbers to know:**
- GitHub-hosted macOS runners cost 10× the price of Linux runners (as of 2024)
- Windows runners cost 2× Linux
- A matrix CI run that takes 8 minutes on Linux takes ~80 minutes worth of equivalent cost on macOS if you run the same matrix
- Rule of thumb: test on macOS and Windows in nightly runs only unless you have specific, known cross-platform bugs to prevent

---

## The Anti-Patterns

### ❌ Anti-Pattern: Single-Version CI for a Multi-Version Library

**What it looks like:** A library with a documented minimum Python version of 3.7 that only runs CI on Python 3.11. "We'll add other versions when we have time."

**Why it happens:** The minimum version is theoretical — the developers use the latest. No one is watching 3.7 users closely.

**What breaks:** Runtime version-specific API changes (like `re.fullmatch`, `dict` ordering guarantees, `asyncio` API changes) silently break old versions. The breakage is discovered by users, not by CI.

**The fix:** Your minimum supported version must be in the CI matrix. Non-negotiable. If you don't test it, you don't support it — you just claim to.

---

### ❌ Anti-Pattern: `fail-fast: true` on the Main Branch

**What it looks like:** The matrix on the main branch merge runs with `fail-fast: true` (the default). When Python 3.8 fails, GitHub Actions cancels all other matrix jobs. You see one failure, not the full picture.

**Why it happens:** `fail-fast: true` is the default and nobody changed it.

**What breaks:** Debugging efficiency. When a change breaks multiple matrix dimensions, you need to see all the failures simultaneously to understand the blast radius. Canceling after the first failure means you run CI again after fixing the first failure, only to discover a second failure — repeated until all dimensions are fixed, which takes N times as long as seeing all failures at once.

**The fix:** Set `fail-fast: false` on the main branch matrix. Set `fail-fast: true` on PR branches where you want early failure signals. Different branches, different fail-fast settings.

---

### ❌ Anti-Pattern: Hardcoded Platform Assumptions in Tests

**What it looks like:** Tests use `/tmp/` hardcoded, `\` as a path separator in assertions, `os.getenv('HOME')` for fixture paths, or Unix-specific signals (`SIGTERM`, `SIGKILL`). The test suite runs fine on Linux CI but fails on half the Windows matrix jobs.

**Why it happens:** The test authors never ran on Windows. The matrix build is the first time someone checked.

**What breaks:** The Windows matrix jobs. And more importantly, the signal: "Windows users encounter bugs we don't catch." This matters even for server software — ARM-based Windows development environments and Windows-based CI runners are increasingly common.

**The fix:** Use `pathlib.Path`, `tempfile` module, `pytest`'s `tmp_path` fixture, and `sys.platform` guards rather than hardcoded paths. Treat platform compatibility as a first-class requirement, not an afterthought.

---

### ❌ Anti-Pattern: Infinite Matrix Expansion

**What it looks like:** The matrix grows monotonically. Old versions are never removed. New dimensions are added without removing old ones. After two years, the matrix has 8 Python versions × 3 OS × 3 architectures × 2 database versions = 144 jobs, and CI costs $2,000 per month.

**Why it happens:** Removing a version from the matrix feels like "dropping support." Teams are reluctant to drop support. No one owns the CI cost budget.

**What breaks:** CI economics and feedback latency. 144 parallel jobs is fast; 144 jobs with only 20 concurrent runners means 7 sequential batches and 35-minute CI times.

**The fix:** Define a version support policy and automate its enforcement. For Python libraries: support versions with ≥5% download share in your metrics (PyPI download stats by Python version are public via BigQuery). When a version drops below 5%, open a deprecation issue, give users 3 months notice, remove it from the matrix. The matrix size stays bounded.

---

## Field Notes

💀 **"We'll add the full matrix later"** → "Later" is a production incident with a user's bug report → Add the minimum supported version to your matrix today. Everything else can wait; the floor cannot.

💀 **`fail-fast: true` on a nightly full matrix run** → You see one failure, re-run, see the next, repeat until you've run CI 4 times to find 4 failures → Set `fail-fast: false` on scheduled and main-branch runs. Set `fail-fast: true` on PR runs where you want speed.

💀 **Not caching dependencies per matrix dimension** → Each 15-job matrix installs all dependencies 15 times → Add a cache step with a key that includes `matrix.os` and `matrix.python-version`. This reduces per-job setup time from 3 minutes to 15 seconds on cache hits.

💀 **macOS runners on every PR** → macOS runners cost 10× Linux → Move macOS and Windows testing to nightly or main-branch-only runs unless you have a specific history of macOS-only bugs.

---

## Chapter Summary

The matrix build pattern is not an optimization — it is a correctness requirement for any software that claims to support multiple runtime versions, operating systems, or architectures. The gap between "we support Python 3.8+" and "we test on Python 3.8+" is the gap where Sofia's incident lived. The pattern itself is straightforward: GitHub Actions `matrix` strategy, GitLab CI `parallel:matrix`, or equivalent. The engineering challenge is managing combinatorial explosion through tiered matrices, intelligent pruning, and a version deprecation policy that keeps the matrix bounded.

The controversial take: most teams test too few dimensions on PRs and have no nightly coverage of the full matrix. The right model is the inverse of what most teams do — fast reduced coverage on PRs (to not block developers), full coverage on merge to main and nightly (to catch regressions before users do).

---

## What's Next

Chapter 5 addresses the performance problem that the matrix build amplifies: how do you run many parallel build and test jobs quickly when each one starts from scratch? The Build Cache & Fan-Out Pattern covers remote build caching, dependency sharing across matrix dimensions, and the fan-out/fan-in model for parallelizing monorepo builds — turning a 47-minute serial build into a sub-10-minute parallel one.

[→ Next: Chapter 5 — The Build Cache & Fan-Out Pattern](./chapter-05-build-cache-fan-out.md)

---
*[← Previous: Chapter 3 — The Hermetic Build Pattern](./chapter-03-hermetic-build.md) |
[→ Next: Chapter 5 — The Build Cache & Fan-Out Pattern](./chapter-05-build-cache-fan-out.md)*
