# Chapter 7: The Test Impact Analysis (TIA) Pattern
*Part II: Foundational Build & Integration Patterns (CI)*

> *"We run 12,000 tests on every commit. A typo fix in a README
> triggers the full distributed test suite. We know this is wrong.
> We don't know what to do about it."*
> — senior engineer at a monorepo-scale company, describing their CI

---

## The War Story

Marcus Webb is the CI platform lead at Veridian Software, a B2B enterprise platform with a monorepo containing 47 services, 1,200 Go packages, and 34,000 automated tests. The test suite takes 18 minutes to run on 24 parallel workers. Not bad for 34,000 tests. Except that 99% of commits touch at most 3 packages out of 1,200. For those commits, 97% of the tests are testing code that didn't change.

The math Marcus does one afternoon:
- 34,000 tests × average 31ms per test = 1,054 seconds = 17.5 minutes
- Average commit affects 3 packages out of 1,200 = 0.25% of packages
- Tests actually relevant to a typical commit: approximately 340 (1% of the suite)
- Tests relevant to a typical commit could run in: ~11 seconds

The gap between 17.5 minutes and 11 seconds for a typical commit is not a performance problem — it's an architecture problem. The CI system is running 99% irrelevant tests because it has no concept of what changed and what that change could possibly affect.

Marcus's team is not alone. At the time he writes up his analysis, Veridian is spending $47,000 per month on CI compute. His back-of-envelope estimate: if TIA cut redundant test execution by 80%, the bill drops to $9,400. The remaining 20% is the full test suite run on changes to high-impact packages (the core data model, the authentication library, shared infrastructure code).

This chapter covers how Marcus implements that reduction. The answer is Test Impact Analysis: a system that maps every test to the code it exercises and every code change to the tests that might detect a regression in it.

---

## What You'll Learn

- The three approaches to TIA: static dependency analysis, dynamic coverage-based mapping, and hybrid — when to use each
- Implementation with Jest `--changedSince`, pytest-testinfra, Bazel `bazel query --affected_targets`, and Azure DevOps' built-in TIA
- The "escape hatch" problem: when TIA misses tests it should have run, and how to catch it before it becomes a production regression
- When TIA lies: integration boundaries, shared utilities, and the cases where running fewer tests is actually less safe
- The full/partial run strategy: TIA for PRs, full run on merge to main

---

## What Is Test Impact Analysis?

Test Impact Analysis (TIA) is the practice of determining, for a given set of code changes, the minimal set of tests that must run to verify that the changes didn't introduce a regression — and running only those tests, rather than the full test suite.

The key word is "minimal set that must run." TIA is not about reducing coverage. It's about eliminating tests that cannot possibly detect a regression in the changed code because they don't exercise that code. If you change `services/payment-api/handler.go` and there are 2,000 tests in `services/user-profile/`, those 2,000 tests cannot tell you whether your payment handler change introduced a bug. Running them is a waste.

TIA systems maintain a mapping: **code unit → tests that exercise it**. When a change touches a code unit, TIA identifies the tests that cover it and runs only those. There are three approaches to building this mapping:

### Approach 1: Static Dependency Analysis

Build the code dependency graph from source code imports and declarations. If `test_payments.py` imports `payments.handler`, then `test_payments.py` is "impacted" by changes to `payments/handler.py`.

**Strengths:** Fast to compute (no test execution required), works before any tests run, deterministic.

**Weaknesses:** Cannot detect indirect dependencies. If `test_payments.py` imports `payments.handler`, which imports `common.crypto`, then a change to `common/crypto.py` should also run `test_payments.py` — but a simple import graph might not trace the transitive chain correctly for all dependency types (dynamic imports, reflection, monkey-patching).

**Best for:** Strongly-typed languages with explicit imports (Go, Java, TypeScript). Bazel uses static dependency analysis via BUILD files that explicitly declare all dependencies.

### Approach 2: Dynamic Coverage-Based Mapping

Instrument the test suite with coverage tracking. For each test, record exactly which lines of which files it executed. Build a reverse mapping: for each file:line, which tests executed it?

When code changes, look up which tests covered the changed lines. Run those tests.

**Strengths:** Highly accurate. Catches indirect dependencies that static analysis misses. Accounts for dynamic dispatch, reflection, and runtime-resolved calls.

**Weaknesses:** Requires at least one full instrumented test run to build the initial mapping. The mapping must be updated regularly (at minimum: when a test changes, the affected mappings must be refreshed). Coverage instrumentation adds 20–40% overhead to test execution time during the mapping phase.

**Best for:** Dynamic languages (Python, Ruby, JavaScript) where static import analysis is insufficient due to dynamic module loading, metaprogramming, or complex inheritance chains.

### Approach 3: Hybrid (Static + Dynamic)

Use static analysis for the dependency graph (fast, always available) and supplement with dynamic coverage data for high-uncertainty areas (shared utilities, framework code, infrastructure layer). The static analysis identifies the obviously-affected tests; the coverage data catches the non-obvious dependencies.

This is the approach Bazel takes with its remote cache integration, and it's the approach most mature CI platforms converge on.

---

## Implementation: Bazel Affected Targets

Bazel's BUILD file system makes static dependency analysis exact: every dependency is explicitly declared, so Bazel can compute precisely which build targets depend on a changed file.

```bash
# The key Bazel TIA query.
# rdeps(//..., set($(bazel query "change_targets")))
# Reads as: "find all targets that (transitively) depend on the changed targets"

# Step 1: Identify which files changed in this PR.
CHANGED_FILES=$(git diff --name-only origin/main...HEAD)

# Step 2: Find the Bazel targets that own those files.
# `bazel query` maps source files to the targets that declare them.
CHANGED_TARGETS=$(echo "$CHANGED_FILES" | while read file; do
  bazel query "$file" --output=package 2>/dev/null
done | sort -u | sed 's|^|//|' | sed 's|$|:all|')

# Step 3: Find all targets that transitively depend on the changed targets.
# These are the targets that could be affected by the changes.
AFFECTED_TARGETS=$(bazel query \
  "rdeps(//..., set($CHANGED_TARGETS))" \
  --output=label 2>/dev/null | grep "_test$\|_tests$")

echo "Changed targets: $CHANGED_TARGETS"
echo "Affected test targets: $AFFECTED_TARGETS"

# Step 4: Run only the affected test targets.
if [ -n "$AFFECTED_TARGETS" ]; then
  bazel test $AFFECTED_TARGETS \
    --test_output=errors \
    --jobs=20
else
  echo "No test targets affected by this change."
fi
```

A real Bazel dependency query for a service change:

```bash
# Example output for a change to //services/payment-api/internal/handler.go

# Changed targets:
# //services/payment-api/internal:internal

# Affected test targets (transitively depend on internal:internal):
# //services/payment-api/internal:internal_test
# //services/payment-api:payment_api_test  
# //integration-tests/payment:payment_integration_test
# //e2e:checkout_flow_test

# NOT included (correctly):
# //services/user-profile:user_profile_test  (no dependency on payment-api/internal)
# //services/notification:notification_test  (no dependency)
# ... (31 other services' test suites)
```

This query is fast: it runs the Bazel query engine against the BUILD graph, which is in-memory and returns in seconds. No test execution required.

### Implementing Bazel TIA in CI

```yaml
# .github/workflows/ci.yml
name: CI with TIA

on: [pull_request]

jobs:
  compute-affected-tests:
    runs-on: ubuntu-22.04
    outputs:
      affected-targets: ${{ steps.compute.outputs.targets }}
      has-targets: ${{ steps.compute.outputs.has-targets }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: bazel-contrib/setup-bazel@0.8.1
        with:
          bazel-version: "7.0.2"

      - name: Compute affected test targets
        id: compute
        run: |
          # Find changed files vs. the merge base (not vs. HEAD~1, which
          # breaks on rebases and merge commits).
          BASE=$(git merge-base HEAD origin/main)
          CHANGED=$(git diff --name-only $BASE HEAD | tr '\n' ' ')

          if [ -z "$CHANGED" ]; then
            echo "has-targets=false" >> $GITHUB_OUTPUT
            exit 0
          fi

          # Convert changed files to Bazel targets.
          # bazel query handles the mapping from source file paths to target labels.
          TARGETS=$(for f in $CHANGED; do
            bazel query "$f" 2>/dev/null
          done | sort -u)

          if [ -z "$TARGETS" ]; then
            echo "has-targets=false" >> $GITHUB_OUTPUT
            exit 0
          fi

          # Find all test targets that depend on the changed targets.
          AFFECTED=$(bazel query \
            "kind('.*_test', rdeps(//..., set($TARGETS)))" \
            --output=label 2>/dev/null \
            | tr '\n' ' ')

          echo "targets=${AFFECTED}" >> $GITHUB_OUTPUT
          echo "has-targets=$([ -n "$AFFECTED" ] && echo true || echo false)" >> $GITHUB_OUTPUT

  run-affected-tests:
    needs: compute-affected-tests
    if: needs.compute-affected-tests.outputs.has-targets == 'true'
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: bazel-contrib/setup-bazel@0.8.1
        with:
          bazel-version: "7.0.2"

      - name: Run affected tests
        run: |
          TARGETS="${{ needs.compute-affected-tests.outputs.affected-targets }}"
          bazel test $TARGETS --test_output=errors

  # CRITICAL: On merge to main, always run the full test suite.
  # TIA is for PR feedback speed. The full run on merge is the
  # correctness guarantee for the mainline.
  full-test-on-main:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: bazel-contrib/setup-bazel@0.8.1
        with:
          bazel-version: "7.0.2"
      - run: bazel test //... --test_output=errors
```

---

## Implementation: Jest `--changedSince` for JavaScript

Jest has built-in support for running only tests affected by changed files, via the `--changedSince` flag and `--testPathPattern`:

```bash
# Run only tests that Jest determines are affected by changes
# since the branch diverged from origin/main.
# Jest uses a static analysis of import/require statements to build
# the dependency graph and identify affected tests.
npx jest \
  --changedSince=origin/main \
  --testPathPattern='src/' \
  --coverage \
  --coverageDirectory=coverage-partial

# For monorepos with Turborepo:
# Turborepo handles TIA at the package level (which packages changed),
# Jest handles it at the file level within a package.
# Use both together for maximum efficiency.
```

Jest's `--changedSince` uses `git diff` to find changed files, then traverses the Jest module dependency graph (built from static imports/requires analysis) to find tests that import those files (directly or transitively). The analysis has the same limitations as static analysis generally: dynamic imports and runtime-resolved modules are not detected.

```json
// jest.config.js — configure Jest for accurate TIA
{
  "testEnvironment": "node",
  
  // watchPathIgnorePatterns: these paths never invalidate the test cache.
  // Documentation, fixtures, and build artifacts don't affect test behavior.
  "watchPathIgnorePatterns": [
    "node_modules",
    "dist",
    "docs",
    "*.md"
  ],
  
  // collectCoverageFrom: defines which files are tracked for coverage.
  // Used by --changedSince to build the reverse coverage map.
  "collectCoverageFrom": [
    "src/**/*.{js,ts}",
    "!src/**/*.d.ts",
    "!src/**/__mocks__/**"
  ],
  
  // testResultsProcessor: write results to XML for CI aggregation.
  "testResultsProcessor": "jest-junit"
}
```

---

## Implementation: pytest with Coverage-Based TIA

Python's dynamic nature makes static import analysis insufficient. The right approach is coverage-based TIA: run the full test suite with coverage instrumentation on the main branch, store the per-test coverage data, then use the stored mapping to determine which tests are affected by PR changes.

```bash
# Install required tools
pip install pytest pytest-cov coverage[toml] pytest-testmon

# pytest-testmon implements coverage-based TIA for Python.
# On first run (or full run), it instruments tests and records coverage.
# On subsequent runs, it uses the stored mapping to select affected tests.

# Full run (on main branch merge): record all test-to-code mappings
pytest tests/ \
  --testmon \
  --testmon-forceupdate \   # Force full run, update the mapping database
  -v

# Partial run (on PR): run only tests affected by changed files
pytest tests/ \
  --testmon \   # Use the stored mapping. Only runs affected tests.
  -v

# The .testmondata file stores the coverage-to-test mapping.
# Commit this file or cache it in CI — it's the TIA database.
# Without it, every run is a full run.
```

```yaml
# GitHub Actions with pytest-testmon
      - name: Restore TIA database
        uses: actions/cache@v4
        with:
          path: .testmondata
          # Key based on the merge base: the TIA database is valid for
          # the commit tree it was built from. If the merge base changes,
          # rebuild.
          key: testmon-${{ hashFiles('**/*.py') }}-${{ github.base_ref }}
          restore-keys: |
            testmon-

      - name: Run affected tests (PR)
        if: github.event_name == 'pull_request'
        run: pytest --testmon -v

      - name: Run full test suite (main)
        if: github.ref == 'refs/heads/main'
        run: pytest --testmon --testmon-forceupdate -v

      - name: Save TIA database
        uses: actions/cache/save@v4
        if: github.ref == 'refs/heads/main'  # Only update on main
        with:
          path: .testmondata
          key: testmon-${{ hashFiles('**/*.py') }}-${{ github.ref_name }}
```

---

## When TIA Lies: The Escape Hatches

TIA has known failure modes. Every TIA implementation needs escape hatches — conditions under which the system falls back to running the full test suite.

### Lie 1: Changes to Shared Utilities

A change to a shared utility function used by 200 services should run tests for all 200 services. Static analysis detects this correctly (all 200 services import the utility). The escape hatch is necessary for a different reason: the developer didn't realize the utility was that widely used. TIA correctly expands the test scope, but the developer needs to see that expansion clearly, not have it hidden.

Show developers the TIA-computed test scope before the run. "This change affects 47 test targets across 12 services" is information that should influence whether the developer reconsiders the scope of the change.

### Lie 2: Integration Test Boundaries

TIA based on static imports will miss integration tests that test the interaction between services via network calls, message queues, or shared databases. If `service-a` calls `service-b` via HTTP, and you change `service-b`, a static analysis of `service-a`'s imports won't find the dependency — because `service-a` doesn't import `service-b`'s Go packages, it calls it over the network.

The escape hatch: integration tests that test cross-service boundaries are tagged explicitly (`//integration-tests/...`) and are always run when any service in their scope changes, regardless of TIA.

```bash
# After TIA computes affected unit tests, always add integration tests
# for any changed service.
CHANGED_SERVICES=$(git diff --name-only $BASE HEAD | grep -oP 'services/[^/]+' | sort -u)

for svc in $CHANGED_SERVICES; do
  # Always run integration tests for changed services, even if unit TIA
  # didn't select them. Integration tests test the service's external contract,
  # which changes even when unit tests don't detect it.
  INTEGRATION_TARGETS="$INTEGRATION_TARGETS //integration-tests/${svc}/..."
done

bazel test $AFFECTED_UNIT_TESTS $INTEGRATION_TARGETS
```

### Lie 3: Generated Code and Schema Changes

Changes to Protobuf `.proto` files, GraphQL schemas, or database migration files don't change Go/Python/TypeScript source files directly — they generate source files. If your CI pipeline regenerates code before running TIA, the generated file changes will be correctly detected. If TIA runs before code generation, the generated changes are invisible to it.

**Fix:** Run code generation before TIA. Treat generated files as first-class source files for the purposes of TIA.

### Lie 4: Environment and Configuration Changes

A change to a `.env.test` file, a Docker Compose configuration used in integration tests, or a test fixture database seed can affect test outcomes without changing any application source code. Static analysis misses these because they're not in the import graph.

**Fix:** Maintain an explicit list of "always trigger full test run" file patterns. Changes to `docker-compose.test.yml`, `fixtures/**`, and `.env.test` bypass TIA and run the full suite.

```yaml
# In the TIA computation step:
FULL_RUN_PATTERNS=(
  "docker-compose.test.yml"
  "fixtures/**"
  ".env.test"
  "Makefile"
  ".github/workflows/**"  # Changes to CI config itself = run everything
)

for pattern in "${FULL_RUN_PATTERNS[@]}"; do
  if git diff --name-only $BASE HEAD | grep -q "$pattern"; then
    echo "Change to $pattern detected — running full test suite."
    bazel test //...
    exit 0
  fi
done

# Only reach here if no full-run pattern matched.
# Proceed with TIA-selected test targets.
```

---

## The Full Run / Partial Run Strategy

The most important architectural decision in TIA is: **when do you run TIA-selected tests, and when do you run the full suite?**

The right answer, which almost every mature team converges on:

| Trigger | Test scope |
|---|---|
| PR push (developer feedback) | TIA-selected tests for changed packages |
| Merge to main | Full test suite (always) |
| Nightly schedule | Full test suite + integration + contract tests |
| Deployment gate | Integration tests + smoke tests for the deployed service |

The PR run is for developer feedback speed. The main branch run is for correctness. Never use TIA as the gate for the main branch merge. The main branch must be verified by the full suite every time.

This seems conservative. It is. But consider the failure mode: TIA misses a test (because of an integration boundary or a dynamic dependency it couldn't trace), the PR merges, the missed test would have caught a regression, the regression ships to production. The cost of that outcome vastly exceeds the cost of running the full suite on each main branch merge.

---

## Scale Considerations

**At 100–1,000 tests:** TIA overhead (computing the dependency graph, determining affected targets) costs more than running all the tests. Don't implement TIA at this scale. Run everything.

**At 1,000–10,000 tests:** TIA saves meaningful time. Expect 40–60% reduction in test execution time for typical PRs. Bazel's `rdeps` query and Jest's `--changedSince` are both appropriate at this scale.

**At 10,000–100,000 tests:** TIA is not optional — it's the difference between 20-minute CI and 3-hour CI. Coverage-based TIA (pytest-testmon, JVM-based tools like Predictive Test Selection) provides better accuracy than static analysis at this scale.

**At 100,000+ tests (Google/Netflix scale):** Coverage-based TIA combined with ML-based test selection (Chapter 8). The test selection model uses historical test execution data to rank tests by their probability of detecting a regression given a specific set of changed files. This is the territory where Bazel's remote execution + test analytics pipeline becomes necessary infrastructure.

---

## The Anti-Patterns

### ❌ Anti-Pattern: TIA Without Full-Run Fallback on Main

**What it looks like:** TIA runs on every commit, including merges to main. The full test suite never runs. A regression slips through because TIA missed a dynamic dependency.

**Why it happens:** The team was so pleased with 8-minute CI that they applied TIA everywhere.

**What breaks:** Mainline correctness. A PR that passes TIA-selected tests but would fail the full suite can now merge. The regression is discovered in production.

**The fix:** Always run the full test suite on merge to main. TIA is a PR feedback tool, not a merge gate.

---

### ❌ Anti-Pattern: Stale TIA Mapping Database

**What it looks like:** The coverage-based TIA database (`.testmondata`, coverage JSON) was last updated two months ago. Since then, 40 new tests were added and 20 files were refactored. TIA is now selecting tests based on a stale mapping that doesn't reflect the current code structure. Some tests are never selected (new tests not in the old mapping). Some tests are over-selected (files were moved and the old mapping still points to the old path).

**Why it happens:** The TIA database is updated only when someone remembers to run the full suite and commit the results.

**What breaks:** Test coverage confidence. TIA is either missing tests (false negative) or running irrelevant tests (false positive).

**The fix:** Rebuild the TIA database on every merge to main. This naturally keeps the database fresh: every main-branch full run updates the mapping. The fresh mapping is committed or cached and used by subsequent PR runs.

---

### ❌ Anti-Pattern: TIA for a Test Suite with Extensive Shared State

**What it looks like:** The test suite for a monolithic application has 500 tests. 300 of them share a global database fixture that is set up once per suite and mutated by tests. TIA selects 50 tests. Those 50 tests run. But because they depend on the database state left by the 250 tests that didn't run, they fail intermittently.

**Why it happens:** The test suite was not designed for selective execution — it was designed for sequential, full-suite execution with shared state.

**What breaks:** TIA reliability. False failures from shared state make TIA look unreliable and get it turned off.

**The fix:** Test suites must be isolatable by default before TIA is applied. Each test (or at minimum each test class) must set up and tear down its own state. This is good test design regardless of TIA — it prevents test ordering dependencies.

---

## Field Notes

💀 **TIA without tracking the "unmapped tests" count** → Unmapped tests are never selected and never run → Track the percentage of tests that have no TIA mapping. Above 10% is a signal that the mapping database is stale or that new tests aren't being mapped.

💀 **TIA applied to end-to-end tests** → E2E tests test the system, not individual code paths — TIA analysis may incorrectly select none of them → Keep E2E tests out of TIA. They test deployment-level behavior, not code-level behavior. Run them on merge and on deploy.

💀 **Never auditing TIA accuracy** → TIA misses increase silently → Monthly: take a random sample of 10 PRs that used TIA. Run the full test suite for the same commits. Compare which tests TIA selected vs. which would have run. Any test that the full run would have selected but TIA didn't is a miss. Track miss rate.

---

## Chapter Summary

Test Impact Analysis is the operationalization of a simple insight: tests that don't exercise changed code can't detect regressions in that code, so running them is waste. The implementation of that insight — building and maintaining an accurate code-to-test mapping — ranges from trivial (Bazel's BUILD-file dependency graph) to complex (coverage-based dynamic mapping for dynamic languages).

The right architecture is layered: TIA for PR feedback speed, full test suite on merge to main for correctness guarantee. Never use TIA as the only gate. The PR is where speed matters; the main branch merge is where correctness is non-negotiable.

The hardest part of TIA is not the implementation — it's maintaining the accuracy of the mapping over time, handling the edge cases where static or dynamic analysis misses indirect dependencies, and building the escape hatches that catch the cases TIA can't handle. Those escape hatches (always-run lists, integration test expansion, full runs on main) are not failures of the pattern; they are essential components of it.

---

## What's Next

Chapter 8 takes the TIA concept further: instead of just mapping changes to affected tests, it applies machine learning to predict which tests are likely to fail, optimal test ordering, and build failure probability — using historical CI data as the training signal. This is the pattern used by Google, Microsoft, and Uber at the frontier of CI optimization.

[→ Next: Chapter 8 — The Predictive & AI-Assisted Build Pattern](./chapter-08-predictive-ai-build.md)

---
*[← Previous: Chapter 6 — The Sidecar Verification Pattern](./chapter-06-sidecar-verification.md) |
[→ Next: Chapter 8 — The Predictive & AI-Assisted Build Pattern](./chapter-08-predictive-ai-build.md)*
