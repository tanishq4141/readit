# Chapter 5: The Build Cache & Fan-Out Pattern
*Part II: Foundational Build & Integration Patterns (CI)*

> *"Our CI pipeline takes 47 minutes. We measured. Eleven minutes of that is
> actually building and testing things. The other 36 minutes is waiting for
> things that haven't changed to rebuild themselves."*
> — platform engineer at a fintech company, 2022, right before a rewrite

---

## The War Story

It's a Wednesday morning standup at Meridian Payments, a B2B payments infrastructure company. Dev Patel, the lead platform engineer, is showing the engineering team a graph. The x-axis is time (the last six months). The y-axis is CI pipeline duration in minutes. The line is not flat. It goes from 18 minutes in January to 47 minutes in July.

The team has added five new services. Each service has its own tests. The CI pipeline runs all of them on every commit, regardless of what changed. A one-line documentation fix in the README triggers the full test suite for all eleven services.

Dev has done the math. At 180 commits per day and 47 minutes per pipeline run: that's **8,460 compute-minutes per day**. At their cloud provider's cost ($0.008/minute), it's $67.68 per day, or roughly $25,000 per year. And the cost isn't just money — it's latency. Engineers wait 47 minutes for feedback on a change that took them 10 minutes to write. The feedback loop is destroying flow.

The specific breakdown, which Dev spent three days measuring:

- 8 minutes: dependency installation (no caching, every job starts from scratch)
- 6 minutes: Docker image build (no layer cache, full rebuild every time)
- 11 minutes: actual test execution
- 22 minutes: **11 services running in serial, each waiting for the previous to complete**

That last item is the killer. The 11 services are independent. They share no state. They could all run simultaneously. Instead they run in a queue, because the original pipeline was written for one service and was copy-pasted eleven times into a single sequential job.

The fix takes two weeks to implement properly. After the fix: 8 minutes for the same workload. The math: 8 minutes vs. 47 minutes, on 180 commits per day, over a year, represents **$23,400 in recovered compute cost** and — less quantifiable but more important — a developer experience that no longer makes people angry at the CI system.

This chapter is about that fix.

---

## What You'll Learn

- The fan-out/fan-in model: how to parallelize independent build and test stages with correct dependency management
- Remote build caching: how content-addressed caches make incremental builds safe and fast
- Turborepo for JavaScript/TypeScript monorepos, Bazel remote cache for polyglot systems, and Docker BuildKit cache for container builds
- Cache invalidation strategies: what to key on, what not to key on, and the failure modes of over-aggressive caching
- Cache poisoning: the supply chain attack vector that hermetic builds mitigate and that cache backends must address separately

---

## The Fan-Out / Fan-In Model

The fan-out/fan-in model separates a pipeline into three phases:

1. **Fan-out:** Independent work units are distributed across parallel workers. No work unit waits for another unless there is an explicit dependency.
2. **Parallel execution:** All work units run simultaneously, each completing in its own time.
3. **Fan-in:** A gate waits for all parallel work units to complete, then aggregates results.

The model is not new — it is the standard architecture for any embarrassingly parallel computation. What is surprisingly uncommon is applying it correctly to CI pipelines, which tend to evolve organically into sequential chains because sequential pipelines are easy to write and nobody goes back to parallelize them.

```
BEFORE (sequential):
────────────────────────────────────────────────────────────────────────── time →
[ setup ] → [ build-svc-a ] → [ test-svc-a ] → [ build-svc-b ] → [ test-svc-b ] → ...
                                                                              47 min total

AFTER (fan-out/fan-in):
[ setup ] → ┌─ [ build+test svc-a ] ──────────────┐
             ├─ [ build+test svc-b ] ──────────┐   │
             ├─ [ build+test svc-c ] ────────┐ │   │
             ├─ [ build+test svc-d ] ──────┐ │ │   │
             └─ [ build+test svc-e ] ────┐ │ │ │   │
                                         └─┴─┴─┴───┘ → [ fan-in: all pass? ] → deploy
                                                                              8 min total
```

The fan-in gate is critical. It answers the question: *did everything that was supposed to succeed actually succeed?* Without a fan-in gate, a failed parallel job can be silently ignored — the pipeline continues because it doesn't know to wait.

### Implementing Fan-Out in GitHub Actions

```yaml
# .github/workflows/monorepo-pipeline.yml
name: Monorepo Build & Test

on: [push, pull_request]

jobs:
  # Detect which services changed. This is the foundation of proportional builds:
  # only fan out to services that have changed, not all services every time.
  detect-changes:
    runs-on: ubuntu-22.04
    outputs:
      # These outputs are arrays of service names that changed.
      # Downstream jobs use these arrays as their matrix.
      changed-services: ${{ steps.detect.outputs.changed-services }}
      any-changed: ${{ steps.detect.outputs.any-changed }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Need full history to compute diffs

      - name: Detect changed services
        id: detect
        run: |
          # Use git diff to find which service directories changed.
          # This is a simplified version; Chapter 7 covers TIA in full detail.
          CHANGED=$(git diff --name-only ${{ github.event.before }} ${{ github.sha }} \
            | grep -oP '^services/[^/]+' \
            | sort -u \
            | jq -R . \
            | jq -sc .)
          echo "changed-services=${CHANGED}" >> $GITHUB_OUTPUT
          echo "any-changed=$([ "${CHANGED}" != "[]" ] && echo true || echo false)" >> $GITHUB_OUTPUT

  # Fan-out: each changed service gets its own parallel job.
  build-and-test:
    needs: detect-changes
    if: needs.detect-changes.outputs.any-changed == 'true'
    runs-on: ubuntu-22.04
    name: Build & Test ${{ matrix.service }}

    strategy:
      fail-fast: false  # Don't cancel other jobs if one service fails
      matrix:
        # The matrix is dynamically generated from the changed-services output.
        # Only changed services get jobs. Unchanged services are skipped entirely.
        service: ${{ fromJSON(needs.detect-changes.outputs.changed-services) }}

    steps:
      - uses: actions/checkout@v4

      - name: Restore build cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/pip
            services/${{ matrix.service }}/.cache
          # Cache key includes: service name, OS, and hash of the service's
          # dependency manifest. Cache is invalidated only when dependencies change.
          key: build-${{ matrix.service }}-${{ runner.os }}-${{ hashFiles(format('services/{0}/requirements*.txt', matrix.service)) }}
          restore-keys: |
            build-${{ matrix.service }}-${{ runner.os }}-

      - name: Build ${{ matrix.service }}
        run: |
          cd services/${{ matrix.service }}
          make build

      - name: Test ${{ matrix.service }}
        run: |
          cd services/${{ matrix.service }}
          make test

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${{ matrix.service }}
          path: services/${{ matrix.service }}/test-results.xml

  # Fan-in: this job runs only after ALL parallel build-and-test jobs complete.
  # It is the gate that blocks deployment if any service failed.
  all-services-green:
    needs: build-and-test
    runs-on: ubuntu-22.04
    if: always()  # Run even if build-and-test was skipped (no changes)
    steps:
      - name: Check all jobs passed
        run: |
          if [[ "${{ needs.build-and-test.result }}" == "failure" ]]; then
            echo "One or more services failed CI. Blocking deployment."
            exit 1
          fi
          echo "All services passed. Ready to deploy."

  # Deployment only proceeds if the fan-in gate passes.
  deploy:
    needs: all-services-green
    if: github.ref == 'refs/heads/main' && needs.all-services-green.result == 'success'
    runs-on: ubuntu-22.04
    steps:
      - name: Deploy to staging
        run: echo "Deploying changed services..."
```

---

## Remote Build Caching

Fan-out parallelizes independent work. Remote build caching eliminates redundant work: if the inputs to a build step haven't changed since the last time it ran, the cached output from the previous run is used directly, skipping the build entirely.

The key principle: **cache hits are only safe if the cache key perfectly captures all inputs to the build step**. An over-inclusive cache key (includes irrelevant inputs) causes unnecessary cache misses. An under-inclusive cache key (misses relevant inputs) causes false cache hits — serving stale output for changed inputs, which is a correctness bug.

### Remote Caching with Docker BuildKit

Docker BuildKit supports remote build caches stored in a container registry (OCI cache) or a general-purpose cache backend (S3, GCS, AZBLOB). This means the layer cache is shared across all CI runners and all developer machines — a cache layer built last Tuesday on a different runner is available today.

```yaml
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        with:
          # BuildKit is required for remote caching. Standard docker build
          # does not support remote cache backends.
          driver: docker-container

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push with remote cache
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

          # Pull cache layers from the registry before building.
          # mode=max: export all layers (intermediate and final) to the cache.
          # This maximizes cache utility: if layer 4 of 8 changes, layers 1-3
          # are still cached and reused in the next build.
          cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache
          cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache,mode=max
```

**Cache hit rates in practice.** For a well-structured Dockerfile (stable layers at the bottom, frequently-changing layers near the top), you can expect:
- Base image layer: ~100% hit rate (changes only when you update the base image)
- Package installation layer (after COPY requirements.txt): 80–90% hit rate (changes only when dependencies change)
- Source code compilation layer: 30–60% hit rate (changes with every code change)
- Overall build time reduction: 60–75% for warm caches on typical development workloads

### Remote Caching with Turborepo (JavaScript/TypeScript Monorepos)

Turborepo is a build orchestration system for JavaScript and TypeScript monorepos that provides dependency-aware task scheduling, content-addressed remote caching, and parallel execution. It is the right tool for JS/TS monorepos where Bazel is overkill.

```jsonc
// turbo.json — Turborepo pipeline configuration
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      // This task depends on the build task of all packages that this
      // package depends on (declared via ^build).
      // Turborepo builds the dependency graph from package.json "dependencies"
      // and ensures builds run in topological order.
      "dependsOn": ["^build"],

      // These are the output files that Turborepo caches.
      // If the inputs haven't changed, Turborepo restores these outputs
      // from cache and skips running the build command.
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"],

      // Cache key inputs. Turborepo hashes these to determine if the cache
      // is valid. Changing any of these files invalidates the cache for this task.
      // By default: all files in the package directory + turbo.json.
      "inputs": ["src/**", "package.json", "tsconfig.json"]
    },

    "test": {
      // Tests depend on the build completing successfully.
      "dependsOn": ["build"],
      "outputs": ["coverage/**"],
      // "cache": false would disable caching for this task.
      // Leave it enabled — test results are cacheable when inputs don't change.
      "cache": true
    },

    "lint": {
      // Lint is independent of build. Run in parallel with build.
      "outputs": []
    }
  },
  
  // Remote cache configuration.
  // TURBO_TOKEN and TURBO_TEAM are set as CI secrets.
  // The remote cache is Turborepo's managed cache service (Vercel).
  // Self-hosted alternative: configure an S3-compatible endpoint.
  "remoteCache": {
    "signature": true  // Sign cache artifacts. Prevents cache poisoning.
  }
}
```

```yaml
# GitHub Actions with Turborepo remote caching
- name: Run build and tests
  env:
    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
    TURBO_TEAM: ${{ vars.TURBO_TEAM }}
  run: |
    # --filter=...[HEAD^1] means: run for all packages that changed since
    # the previous commit. This is Turborepo's incremental mode.
    # On a cache hit, the task output is restored from the remote cache
    # and the command is not executed at all — the task is "replayed."
    npx turbo run build test lint --filter=...[HEAD^1]
```

**Turborepo vs. Bazel:** Turborepo is JavaScript-native and significantly simpler to adopt (configuration is JSON + package.json, not a new DSL). Bazel supports any language but requires significant upfront investment. For a pure JS/TS monorepo: Turborepo. For a polyglot monorepo: Bazel or Buck2.

### Remote Caching with Bazel Remote Cache

Bazel's remote cache stores build action outputs (compiled artifacts, test results, container image layers) in a content-addressed store. Any build action whose input hash matches a stored result is skipped — the output is downloaded from the cache instead.

```yaml
      - name: Build with Bazel remote cache
        run: |
          bazel build //... \
            --remote_cache=grpcs://remotecache.mycompany.com \
            --remote_header=x-api-key=${BAZEL_CACHE_TOKEN} \
            # Upload local results to the remote cache after the build.
            # This populates the cache from this run for future runs.
            --remote_upload_local_results=true \
            # If the remote cache is unavailable, fall back to local build.
            # Don't fail the build because the cache is down.
            --remote_local_fallback=true \
            # Timeout for individual cache operations. Prevents the build
            # from hanging if the cache server is slow.
            --remote_timeout=60s
```

**Cache hit rates with Bazel.** Bazel's content-addressed cache is more precise than Docker's layer cache — it operates at the level of individual build actions (compiling a single Go package, running a single test binary) rather than filesystem layers. For a monorepo where most changes affect only a few packages:
- 90–98% cache hit rate for builds where a single package changes
- Mean build time reduction: 70–90% compared to cold builds
- Cost: cache storage grows over time; implement LRU eviction at 50GB

---

## Cache Invalidation: The Hard Part

Phil Karlton's famous observation — "there are only two hard things in computer science: cache invalidation and naming things" — applies directly. The cache key determines everything: get it wrong in either direction and you have either slow builds (too many misses) or wrong builds (stale hits).

### What Makes a Good Cache Key

A cache key should include exactly the inputs that affect the output of the cached step. No more, no less.

```yaml
# For a package installation step:
key: |
  ${{ runner.os }}-              # OS affects which wheel packages are available
  ${{ matrix.python-version }}-  # Python version affects which packages are compatible
  pip-                           # Namespace to avoid collisions with other caches
  ${{ hashFiles('requirements/base.txt', 'requirements/test.txt') }}
  # Hash of the requirements files is the content fingerprint.
  # Any change to requirements files invalidates this cache entry.
  # The hash is computed by hashFiles(), which hashes file content, not mtime.
```

### What NOT to Include in a Cache Key

- **Timestamps or build numbers.** A cache key that includes the current timestamp is a cache key that never hits. This is the most common mistake.
- **Branch names** (usually). The main branch's cache should be usable by PR branches. If you key on branch name, every new PR branch starts with a cold cache.
- **Full file contents when a hash is available.** The hash is what you want; the full content doesn't fit in a key.
- **Environment variables that change between builds but don't affect the output.** `$GITHUB_RUN_ID`, `$GITHUB_RUN_NUMBER`, etc. will produce a unique key for every run, guaranteeing zero cache hits.

### Restore Keys: Hierarchical Cache Fallback

GitHub Actions' `restore-keys` parameter allows hierarchical fallback: if the exact cache key misses, try progressively less specific keys to get a partial cache hit.

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          # Exact key: matches only if this exact requirements hash was cached before.
          key: pip-${{ runner.os }}-py${{ matrix.python-version }}-${{ hashFiles('requirements/*.txt') }}
          # Restore keys: tried in order if the exact key misses.
          # Level 1: same OS + Python version, any requirements hash.
          #   Gets most packages from cache; only installs changed/new packages.
          # Level 2: same OS, any Python version. 
          #   Worst-case partial hit; still faster than a full cold install.
          restore-keys: |
            pip-${{ runner.os }}-py${{ matrix.python-version }}-
            pip-${{ runner.os }}-
```

Partial hits save time: even if the exact requirements weren't cached, the base packages (pytest, black, common utilities) probably were. Installing 5 new packages from the network is much faster than installing 80 packages.

---

## Cache Poisoning: The Security Consideration

Remote build caches are a supply chain attack surface. If an attacker can write to your build cache, they can substitute malicious build artifacts for legitimate ones. A developer (or CI runner) that downloads a poisoned cache entry will use the attacker's artifact instead of building from source.

This attack is non-theoretical. It requires:
1. Write access to the cache backend (your S3 bucket, your Bazel cache server, your Docker registry cache tag)
2. Knowledge of the cache key for the artifact to be poisoned

Mitigations:

**Sign cache artifacts.** Turborepo's `"signature": true` configuration signs all cache entries with a team-specific secret. A tampered artifact fails signature verification. Bazel supports similar signing via `--remote_upload_local_results` combined with remote execution API authentication.

**Restrict write access to CI only.** Developers should be able to read from the remote cache but not write to it. CI runners with appropriate credentials write new cache entries. This limits the blast radius: an attacker would need to compromise a CI runner (not just network access to the cache) to poison the cache.

**Use read-only caches for untrusted PRs.** PRs from forks should pull from the cache but not write to it. A malicious PR cannot poison the cache for the main branch.

```yaml
      - name: Build with cache (read-only for fork PRs)
        uses: docker/build-push-action@v5
        with:
          cache-from: type=registry,ref=${{ env.CACHE_IMAGE }}
          # Only push to cache if this is not a fork PR.
          # Fork PRs run in the fork's GitHub context and don't have write
          # access to the main repo's registry.
          cache-to: ${{ github.event.pull_request.head.repo.full_name == github.repository && 'type=registry,ref=${{ env.CACHE_IMAGE }},mode=max' || '' }}
```

---

## When the Cache & Fan-Out Pattern Breaks

### Break Mode 1: Cache Thrashing

Cache thrashing happens when the cache key changes so frequently that the cache never actually hits. Symptoms: CI always runs "cache miss" even though the same work runs repeatedly. Investigation: examine what's included in the cache key. Common culprit: a cache key that includes a build number, timestamp, or any other value that is unique per run.

### Break Mode 2: Fan-Out Without Fan-In

A fan-out without a fan-in gate means there's no single job that aggregates the pass/fail results of all parallel jobs. A failing parallel job gets "lost" — the pipeline continues because no job was waiting for it. The deployment happens. The broken service is deployed.

Always implement a fan-in gate. In GitHub Actions, use a job with `needs: [job-a, job-b, job-c]` and `if: always()` to aggregate results. The fan-in job checks the results of all upstream jobs and fails if any failed.

### Break Mode 3: False Cache Hits from Under-Inclusive Keys

If the cache key doesn't include an important input — for example, a system library version that affects compilation — the cache may serve stale output when that system library changes. This is the most dangerous failure mode: the build succeeds, the tests pass, and the artifact is wrong in a way that only manifests at runtime.

Detection: periodically run a full cold build (bypassing cache) and compare the digest of the output to the cached artifact. If they differ, the cache key is under-inclusive.

---

## Scale Considerations

At 10 services with a warm remote cache, expect 60–75% CI time reduction. The economic break-even point for setting up a remote cache is roughly 5 engineers — above that, the time saved per day exceeds the setup and maintenance cost within the first month.

At 100 services, the remote cache becomes a critical piece of infrastructure. Treat it like production infrastructure: SLO on cache availability (>99.9%), alerting on cache hit rate drops (below 70% is a signal worth investigating), and a capacity plan for storage growth (Bazel caches can grow to terabytes at monorepo scale without LRU eviction).

At 1000 services (Google/Meta scale), the remote cache is paired with remote execution — not just cache hits, but actual distributed build execution across hundreds of workers. This is the territory of Bazel Remote Execution API, EngFlow, BuildBuddy, and internal build infrastructure teams whose entire job is the build system. Chapter 56 covers this in the Google case study.

---

## The Anti-Patterns

### ❌ Anti-Pattern: The 47-Minute Sequential Pipeline

**What it looks like:** Ten independent services, each built and tested sequentially in a single CI job. The pipeline takes as long as the sum of all service build times.

**Why it happens:** The pipeline started with one service. Copy-paste added the rest. Nobody refactored.

**What breaks:** Developer feedback latency and CI economics. 47 minutes per run at 200 runs per day is a real budget line and a real productivity tax.

**The fix:** Identify the dependency graph. Services that are truly independent (no shared build inputs) can fan out immediately. Use `needs:` in GitHub Actions or `needs:` in GitLab CI to express the actual dependency structure.

---

### ❌ Anti-Pattern: Caching Everything, Including the Wrong Things

**What it looks like:** The cache includes the compiled application binary in addition to the dependency cache. A developer's commit is shadowed by a cached binary from a previous commit. The "new" build is actually an old build with a different source file.

**Why it happens:** Over-aggressive caching. The engineer who set up the cache included `dist/**` in the cache path without thinking through when that should be invalidated.

**What breaks:** Correctness. The cached artifact is wrong for the current source. This is a correctness bug that can ship to production if the fan-in gate doesn't verify artifact freshness.

**The fix:** Cache dependencies and build tools, not build artifacts. Build artifacts should be produced fresh from source on every run (they are fast to build once dependencies are cached) and should be identified by their input hash, not stored in a mutable cache.

---

### ❌ Anti-Pattern: No Cache Size Management

**What it looks like:** The remote Bazel cache or Docker registry cache grows unbounded. After 18 months, it's consuming 4TB and costing $800/month in storage. Cache eviction is manual and irregular.

**Why it happens:** The cache was set up once and nobody thought about lifecycle management.

**What breaks:** Budget and eventually cache server performance (large caches can have slower lookup times without proper indexing).

**The fix:** Configure LRU eviction at the cache backend. For S3-based caches, use lifecycle policies to expire objects older than 30 days. For Bazel remote cache servers (EngFlow, BuildBuddy), configure the `max_size` eviction policy. Cache hit rates tell you the right retention window: if hit rates don't change when you reduce retention from 90 days to 30 days, the longer retention wasn't buying you anything.

---

## Field Notes

💀 **Sequential jobs in a monorepo CI** → Linear CI time that grows with service count → Audit your pipeline for serial jobs with no dependencies between them. Each one is a fan-out candidate. One afternoon of refactoring typically halves CI time.

💀 **Cache key includes `$GITHUB_RUN_ID`** → Zero cache hits, every build is a cold build, the cache does nothing → Audit your cache keys. The key must be stable across runs for the same inputs. Remove any unique-per-run identifiers.

💀 **Fan-out without a fan-in gate** → A failing parallel job silently doesn't block the deployment → Add a `check-all-passed` job with `needs: [every, parallel, job]` and `if: always()` that validates all upstream results. This is the correctness gate for the fan-out.

💀 **Writable cache for fork PRs** → An external contributor can poison your build cache → Set cache writes to CI-only, read-only for fork PRs. One YAML condition prevents an entire supply chain attack vector.

---

## Chapter Summary

The fan-out/fan-in model and remote build caching are the two interventions with the highest ROI in CI optimization. Fan-out addresses serial execution — independent work that was running sequentially for historical reasons, not logical ones. Remote caching addresses redundant execution — work that was already done on a previous run with identical inputs and doesn't need to be done again.

Together, they transform a 47-minute pipeline into an 8-minute one for typical development workloads. The implementation is not complex: GitHub Actions' `matrix` strategy and `needs:` dependencies handle fan-out; `actions/cache` or BuildKit remote cache handles caching. The operational discipline required — maintaining cache key correctness, managing cache size, implementing fan-in gates — is more important than the tooling choice.

The safety warning that belongs in every discussion of build caching: caches are only safe for hermetic builds. A non-hermetic build that produces different outputs from the same inputs will produce false cache hits. Fix the hermeticity first (Chapter 3). Then add caching.

---

## What's Next

The Sidecar Verification Pattern (Chapter 6) addresses a different kind of CI efficiency: how to run compliance, security, and policy checks without blocking the main build. Security scans, license audits, and policy checks are critical but should not be on the critical path of a developer's feedback loop. Running them as parallel sidecars — non-blocking by default, blocking only for critical violations — is how mature CI systems integrate security without sacrificing speed.

[→ Next: Chapter 6 — The Sidecar Verification Pattern](./chapter-06-sidecar-verification.md)

---
*[← Previous: Chapter 4 — The Matrix Build Pattern](./chapter-04-matrix-build.md) |
[→ Next: Chapter 6 — The Sidecar Verification Pattern](./chapter-06-sidecar-verification.md)*
