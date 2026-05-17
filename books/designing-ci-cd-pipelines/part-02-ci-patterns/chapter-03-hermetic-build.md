# Chapter 3: The Hermetic Build Pattern
*Part II: Foundational Build & Integration Patterns (CI)*

> *"It works in CI" and "it works in production" should be the same statement.
> When they're not, you don't have a bug in your code.
> You have a bug in your build system's epistemology."*
> — internal postmortem, Edgeflow Platform Team, 2023

---

## The War Story

Lena Kovacs is a senior SRE at Edgeflow, a video processing platform that handles about 40 million transcoding jobs per day. On a Wednesday afternoon in February, her team deploys a new version of the transcoding service — a Go binary that wraps FFmpeg via CGO for frame-level manipulation. The deploy is unremarkable: CI passed, staging tests passed, the rollout looks clean. Lena closes her laptop and goes to dinner.

At 9:47 PM, the on-call fires. Transcoding jobs are crashing with exit code 139 (segfault) on roughly 30% of the production fleet. The other 70% are fine. The difference, which takes two hours to identify, is the OS version: the 30% running Ubuntu 22.04 (recently rolled out by the infra team) are crashing. The 70% still on Ubuntu 20.04 are fine.

The error, once Lena adds enough logging to capture it, is not in her code:

```
./transcoder: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.34' not found
(required by ./transcoder)
```

The binary was built on the CI runner, which runs Ubuntu 20.04 with glibc 2.31. It was dynamically linked against glibc 2.31 — meaning the binary assumes glibc 2.31 is present on the host. Ubuntu 22.04 ships glibc 2.35. glibc is backward-compatible but the presence check for `GLIBC_2.34` (a specific versioned symbol introduced in glibc 2.34) fails because the binary declares a minimum version requirement based on the symbols it used from the CI runner's glibc, and those symbols must exist in the host's glibc at the exact version or higher.

The CI runner is Ubuntu 20.04. Production is increasingly Ubuntu 22.04. The build was not hermetic: it silently inherited a host dependency — the OS's glibc version — that the build system didn't declare and didn't package. The binary works on any host where glibc ≥ 2.34 is available. It fails on hosts where glibc is exactly 2.31.

Lena's team rolls back in 8 minutes. The post-incident timeline shows the real cost: 2 hours debugging, 800,000 failed transcoding jobs, approximately $14,000 in customer credits. The root cause is four words: *the build was not hermetic*.

The fix takes one afternoon: move the build into a Docker container that is pinned to a specific base image, compile with `CGO_ENABLED=0` where possible and static linkage where CGO is required, and add a CI step that verifies the binary has no dynamic host library dependencies. The fix ships the next morning. It has not broken since.

This chapter is about building that fix into your pipeline before the incident, not after.

---

## What You'll Learn

- The precise definition of a hermetic build and the three specific properties it must satisfy
- Why Docker alone does not give you hermetic builds — and the specific Dockerfile patterns that do
- How Bazel achieves language-level hermeticity with content-addressed dependency management
- When to use Nix for full system-level reproducibility (and when it's overkill)
- How to verify that your build is actually hermetic using reproducibility checks and digest comparison
- The specific failure modes that look like hermetic builds but aren't — and how to catch them in CI before they reach production

---

## What Is a Hermetic Build?

A hermetic build satisfies three properties simultaneously:

**Property 1: Isolation.** The build process can access only explicitly declared inputs. It cannot read from the host filesystem (except declared inputs), make network calls, access ambient environment variables, or depend on tools installed on the host machine. If an undeclared dependency exists, the build fails rather than silently using it.

**Property 2: Reproducibility.** Given identical inputs — the same source code, the same declared dependencies, the same tool versions — the build produces bit-for-bit identical outputs, regardless of when it runs or on what machine. A build that produces identical outputs on developer laptops, CI runners, and production build agents is reproducible. A build that works on your laptop but fails on CI is not.

**Property 3: Completeness.** All dependencies are declared explicitly and with version pinning. There are no implicit dependencies — no "this requires Python 3.11 to be installed on the host," no "this assumes `git` is in PATH," no "this reaches out to PyPI at build time to install the latest version of a package."

Notice what this definition does *not* require: it does not require a specific build tool. It does not require Docker. It does not require Bazel or Nix. Hermetic builds are a property of how you manage inputs and isolation, not of which tool you use to execute the build.

What hermetic builds buy you:

**Debugging transfers across environments.** When CI passes and production fails, and you've verified that the CI artifact and the production artifact are identical (same digest), the problem is in your code or your environment configuration — not in the build. You have eliminated an entire category of explanation. This sounds modest. After debugging one non-hermetic build failure, it stops sounding modest.

**Incremental builds are trustworthy.** Caching a build step is only safe if you can guarantee that the same inputs produce the same outputs. If a build step can produce different outputs from the same inputs — because it reached out to the internet, because it read from the host filesystem, because it depended on an ambient environment variable — then a cached result from yesterday might not be equivalent to a fresh build today. Non-hermetic builds make build caches dangerous. Hermetic builds make them safe.

**Supply chain attacks are harder.** A hermetic build with pinned, verified dependencies limits the attack surface for supply chain compromise to the moment when the lockfile or pin is updated — a code-reviewed, version-controlled, auditable event. A non-hermetic build that resolves dependencies from the internet on every build run is exposed to compromised packages for the entire window between your last clean build and now.

The rest of this chapter covers implementation: how to achieve these three properties using Docker, Bazel, and Nix, and how to verify that you've succeeded.

---

## Implementation: Hermetic Docker Builds

Docker is the most common tool for build isolation, and most Docker builds are not hermetic. The gap between "containerized" and "hermetic" is where most build reliability problems live.

### Why Most Dockerfiles Are Not Hermetic

```dockerfile
# ❌ This is a typical production Dockerfile. It is not hermetic.
FROM node:18

# Problem 1: "node:18" is a floating tag. The base image changes every time
# Node.js releases a patch, every time the base OS (Debian/Alpine) patches a
# vulnerability, every time the image maintainer makes any change. You are not
# pinning to a specific state of the world. You're pinning to "whatever node:18
# means today," which changes without your knowledge or consent.
WORKDIR /app

COPY package.json ./

# Problem 2: npm install resolves dependencies from the internet at build time.
# It uses package.json, not package-lock.json. If you have "^3.0.0" in
# package.json, you'll get whatever 3.x.y npm serves today. If a new 3.x.y
# was published between your last build and this build, you get a different
# dependency tree. Your tests passed against the old tree. The new tree is untested.
RUN npm install

# Problem 3: apt-get without pinned versions.
# "curl" will install whatever version apt serves today.
# This can change the behavior of your build steps.
RUN apt-get update && apt-get install -y curl

COPY . .
RUN npm run build
```

```dockerfile
# ✅ A hermetic Docker build. Every input is explicit and pinned.

# Pin to a specific digest, not a tag. The tag "node:18.19.0-bookworm-slim"
# can be overwritten by the image maintainer. The digest cannot — it is a
# cryptographic hash of the image content. This specific image, with this
# specific digest, will always contain exactly the same layers.
# Get the current digest with: docker buildx imagetools inspect node:18.19.0-bookworm-slim
FROM node:18.19.0-bookworm-slim@sha256:e4b3e4a619d7b3dbd60cd4ce6c0b580c2a5a574c64d53ff61c9c0b89e2e0b17a

WORKDIR /app

# Copy BOTH package.json AND package-lock.json.
# The lockfile is the authoritative specification of the exact dependency tree.
# Without it, npm install is free to resolve different transitive versions.
COPY package.json package-lock.json ./

# --frozen-lockfile: Fail if package-lock.json is inconsistent with package.json.
# --prefer-offline: Use the local cache before reaching out to the network.
#   This doesn't fully prevent network access, but it documents the intent.
# The node_modules directory produced by this command is bit-for-bit identical
# on every machine, every time, as long as the lockfile is unchanged.
RUN npm ci --frozen-lockfile

# Pin system packages to specific versions.
# Find the version string with: apt-cache policy curl
# The version pin ensures the build uses the same curl regardless of when
# apt-get update is run or what the registry serves at that moment.
RUN apt-get update && apt-get install -y curl=7.88.1-10+deb12u5 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*  # Clean apt cache to keep image size down

COPY . .
RUN npm run build
```

### Multi-Stage Builds for Build-Time vs. Runtime Isolation

The hermetic build above runs in a Node.js image. If you're deploying a Node.js application, that image also becomes your runtime image — with `npm`, the Node.js compiler, and all the build tooling baked in. That's wasteful and expands the attack surface. Multi-stage builds solve this by separating the build environment (which needs compilers and build tools) from the runtime environment (which needs only the compiled artifact and its runtime dependencies).

```dockerfile
# ✅ Multi-stage hermetic build.
# Stage 1: build environment. Everything needed to compile/transpile.
FROM node:18.19.0-bookworm-slim@sha256:e4b3e4a619d7b3dbd60cd4ce6c0b580c2a5a574c64d53ff61c9c0b89e2e0b17a AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile
COPY . .

# This produces a /app/dist directory with the compiled application.
RUN npm run build

# Stage 2: runtime environment. Only what's needed to run the app.
# distroless/nodejs18 has no shell, no package manager, no build tools.
# The attack surface is dramatically smaller. The image is ~50MB vs ~250MB.
FROM gcr.io/distroless/nodejs18-debian12@sha256:a91c312d5b867c0f26b7f7e5fd9f52a5e94c87f4f81a3b6b8fd25c8eab8a39dd

WORKDIR /app

# Copy only the compiled output from the builder stage.
# node_modules from builder stage are production-only because npm ci
# was run against the lockfile, which includes devDependencies.
# If you want to exclude devDependencies at runtime, run a separate
# npm ci --omit=dev after the build stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Run as non-root. This is a security property, not a convenience.
# distroless images have a nonroot user built in.
USER nonroot

CMD ["/nodejs/bin/node", "dist/server.js"]
```

### Verifying Hermetic Build Outputs with Digest Pinning

The test of hermeticity is reproducibility: build the same commit twice and get the same digest.

```bash
# Build the image twice from the same commit.
# If the build is hermetic, both digests should be identical.
GIT_SHA=$(git rev-parse HEAD)

docker build --no-cache -t myapp:test-1 .
DIGEST_1=$(docker inspect myapp:test-1 --format='{{.Id}}')

docker build --no-cache -t myapp:test-2 .
DIGEST_2=$(docker inspect myapp:test-2 --format='{{.Id}}')

if [ "$DIGEST_1" != "$DIGEST_2" ]; then
  echo "BUILD IS NOT REPRODUCIBLE"
  echo "Digest 1: $DIGEST_1"
  echo "Digest 2: $DIGEST_2"
  # This failure tells you there's a non-deterministic element in your build.
  # Common culprits: timestamps embedded in generated files, random UUIDs,
  # non-deterministic ordering in file globbing, npm install vs npm ci.
  exit 1
fi

echo "Build is reproducible. Digest: $DIGEST_1"
```

Add this check to CI as a periodic job (not every build — it doubles build time). Run it on every base image update and every lockfile change. A single failure tells you exactly when non-hermeticity was introduced.

---

## Implementation: Bazel for Language-Level Hermeticity

Docker gives you OS-level isolation: the same OS environment, the same system packages. It does not give you language-level hermeticity unless you pin all package manager dependencies explicitly. Bazel goes further: it provides a build system where every dependency — including compiler versions, language runtime versions, and all transitive library dependencies — is declared in the build definition and content-addressed.

Bazel was built at Google to manage the 2-billion-line monorepo (Piper) where, at any given moment, tens of thousands of engineers are making changes simultaneously. The core insight: at that scale, you cannot afford to rebuild everything on every change. But you also cannot afford to use a cache that might be stale. The solution is content-addressing: a build target's cache key is the cryptographic hash of all its inputs. If the inputs haven't changed, the cached output is guaranteed correct. If any input changes, the cache is invalidated automatically. This makes incremental builds both fast and safe.

### Bazel BUILD File Structure

```python
# //services/payment-api/BUILD
# This is a complete, hermetic build definition for a Go service.

load("@io_bazel_rules_go//go:def.bzl", "go_binary", "go_library", "go_test")
load("@rules_oci//oci:defs.bzl", "oci_image", "oci_push")
load("@rules_pkg//:pkg.bzl", "pkg_tar")

go_library(
    name = "payment_api_lib",
    srcs = glob(["*.go"]),            # All .go files in this directory
    importpath = "github.com/myorg/payment-api",
    deps = [
        # Every dependency is referenced by its Bazel label.
        # The label resolves to a pinned version in the WORKSPACE or MODULE.bazel file.
        # There is no "install the latest version" in Bazel.
        "@com_github_gin_gonic_gin//:gin",
        "@com_github_go_redis_redis_v8//:redis",
        "//internal/auth:auth_lib",   # Internal dependency, also Bazel-managed
    ],
    visibility = ["//visibility:private"],
)

go_binary(
    name = "payment_api",
    embed = [":payment_api_lib"],
    # pure = "on" forces Go to compile without CGO.
    # The resulting binary is fully statically linked — no host library dependencies.
    # This is what prevents the glibc version mismatch that Lena encountered.
    # The binary will run on any Linux system regardless of glibc version.
    pure = "on",
    static = "on",
)

go_test(
    name = "payment_api_test",
    srcs = glob(["*_test.go"]),
    embed = [":payment_api_lib"],
    # Tests are also hermetic. They cannot access the network by default.
    # If your test makes a real HTTP call, it will fail. This is correct behavior.
    # Tests that need external dependencies should use fakes, stubs, or
    # testcontainers (which are declared as test dependencies, not ambient state).
)

# Build a minimal OCI container image.
# The base image is pinned by digest in the WORKSPACE/MODULE.bazel.
# The binary is added as a single layer on top of the base image.
# This image will reproduce bit-for-bit across builds because:
# - The Go binary is deterministically compiled (pure + static)
# - The base image is pinned by digest
# - The layer addition is deterministic
pkg_tar(
    name = "payment_api_layer",
    srcs = [":payment_api"],
    # Place the binary at /app/payment_api in the image
    package_dir = "/app",
)

oci_image(
    name = "payment_api_image",
    base = "@distroless_base",   # Defined in MODULE.bazel, pinned by digest
    tars = [":payment_api_layer"],
    entrypoint = ["/app/payment_api"],
)
```

```python
# MODULE.bazel — central dependency and tool version management
# This file is the single source of truth for all hermetic inputs.

module(
    name = "my_services",
    version = "0.1.0",
)

# Pin the Go toolchain version. Bazel downloads this exact version.
# Every developer, every CI runner, every build agent uses this toolchain.
# "But my computer already has Go 1.21 installed" — Bazel ignores it.
# This is what hermeticity looks like at the toolchain level.
bazel_dep(name = "rules_go", version = "0.44.2")
go_sdk = use_extension("@rules_go//go:extensions.bzl", "go_sdk")
go_sdk.download(version = "1.21.5")  # Exact version. No "^1.21". No "latest".

# Pin the base container image for all services.
# The sha256 digest is a cryptographic commitment to specific image content.
# Even if "distroless/base:latest" is updated tomorrow, this build uses
# exactly the image identified by this digest.
oci = use_extension("@rules_oci//oci:extensions.bzl", "oci")
oci.pull(
    name = "distroless_base",
    image = "gcr.io/distroless/base-debian12",
    digest = "sha256:5ecc1f56c7a3e2a8b3b0f3c7a3e7e3c0c2f3a1e8b9c4d5e6f7a8b9c0d1e2f3a4",
    platforms = ["linux/amd64", "linux/arm64"],
)
```

### Running Bazel Builds in CI

```yaml
# .github/workflows/build.yml
name: Build and Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - name: Set up Bazel
        uses: bazel-contrib/setup-bazel@0.8.1
        with:
          # Pin Bazel itself to a specific version.
          # The Bazel binary is downloaded and cached by the action.
          # CI and local development use the same Bazel version.
          bazel-version: "7.0.2"
          # Connect to the remote build cache.
          # Cache keys are content-addressed — hits are always correct.
          # This means a build that ran on a different machine yesterday
          # can reuse its cached outputs today, safely.
          disk-cache: ${{ github.workflow }}
          repository-cache: true

      - name: Build all services
        run: |
          # //... means "all targets in all packages recursively".
          # Bazel only rebuilds targets whose inputs have changed since last build.
          # On a warm cache, this often means 0 recompilations for a PR that
          # changes a single service.
          bazel build //...

      - name: Run all tests
        run: |
          # --test_output=errors: Only print output for failing tests.
          # --jobs=8: Run up to 8 test actions in parallel.
          # Bazel's test caching is safe because tests are hermetic.
          # A test that passed with these inputs yesterday doesn't need
          # to run again today if the inputs haven't changed.
          bazel test //... --test_output=errors --jobs=8

      - name: Verify reproducibility (on schedule, not every build)
        if: github.event_name == 'schedule'
        run: |
          # Build twice, compare digests.
          # Bazel provides --noremote_upload_local_results for second build
          # to force a fresh build without cache.
          bazel build //services/payment-api:payment_api_image
          DIGEST_1=$(bazel cquery --output=files //services/payment-api:payment_api_image | xargs sha256sum)

          bazel clean --expunge
          bazel build //services/payment-api:payment_api_image
          DIGEST_2=$(bazel cquery --output=files //services/payment-api:payment_api_image | xargs sha256sum)

          if [ "$DIGEST_1" != "$DIGEST_2" ]; then
            echo "Reproducibility check FAILED"
            echo "Build 1: $DIGEST_1"
            echo "Build 2: $DIGEST_2"
            exit 1
          fi
```

### Bazel vs. Docker for Hermetic Builds: When to Use Which

Bazel is strictly more hermetic than Docker, but also strictly more operationally complex. The decision matrix:

| Criterion | Docker (with pinned deps) | Bazel |
|---|---|---|
| Setup complexity | Low (30 min) | High (1–2 weeks for non-trivial project) |
| Language support | Any (build runs in container) | Excellent for Go, Java, Python, C++; good for others via community rules |
| Incremental build support | Limited (layer caching only) | Full content-addressed incremental builds |
| Monorepo support | Poor (rebuild everything or write custom scripts) | Designed for it |
| Hermetic toolchain management | No (uses host toolchain or pins in Dockerfile) | Yes (downloads and manages exact toolchain versions) |
| Right for N < 10 services | Yes | Usually overkill |
| Right for N > 50 services / monorepo | Limited | Yes |

The honest recommendation: Docker with pinned digests and frozen lockfiles is sufficient for most teams up to roughly 30–50 services. Beyond that, the incremental build problem becomes acute — a monorepo with 50 services where every change rebuilds all 50 services has a CI latency problem that Docker alone cannot solve. That's when Bazel (or Buck2, Pants, or Nx for JavaScript) earns its operational complexity.

---

## Implementation: Nix for Full System Hermeticity

Nix takes hermeticity further than both Docker and Bazel. Where Docker pins the base OS image, and Bazel pins the build toolchain and application dependencies, Nix pins *the entire closure* — every package, library, compiler, system utility, and their transitive dependencies — to a specific, content-addressed state. A Nix derivation describes exactly what the build requires down to the C standard library.

```nix
# default.nix — a hermetic Nix build for a Python service
# Every input to this build is content-addressed via nixpkgs commit hash.
{ pkgs ? import (fetchTarball {
    # Pin nixpkgs to a specific commit. This is the equivalent of pinning
    # both the OS, all system libraries, AND the language runtime in a
    # single declaration. Nobody has to remember to update the Dockerfile
    # AND the requirements.txt AND the base image separately.
    url = "https://github.com/NixOS/nixpkgs/archive/nixos-23.11.tar.gz";
    # The sha256 hash verifies the tarball content. If nixpkgs changes,
    # this hash breaks the build — preventing silent drift.
    sha256 = "1ndiv385w1qyb9n2k1p7lf9bk2kbgn98kfj6qk9p8w9f3a6m0nd";
  }) {}
}:

pkgs.python311Packages.buildPythonApplication {
  pname = "payment-service";
  version = "1.0.0";

  src = ./.;

  # All Python dependencies, declared with exact versions.
  # No requirements.txt parsed at runtime. No pip install at build time.
  # Each package here is itself a Nix derivation with its own pinned inputs.
  propagatedBuildInputs = with pkgs.python311Packages; [
    fastapi          # pinned to the version in the nixos-23.11 snapshot
    uvicorn
    sqlalchemy
    psycopg2         # includes the libpq C library in its closure, pinned
  ];

  # The build environment is completely isolated from the host.
  # No access to /usr/local, /home, or the network.
  # If the build tries to reach the network, it fails.
}
```

Nix is the right tool when you need:
- Full system-level reproducibility (not just application dependencies)
- Cross-compilation with guaranteed toolchain isolation
- Reproducible development environments that match CI exactly (`nix develop`)
- The ability to audit the complete dependency closure of a binary

Nix is overkill when you have a single-language service with a well-managed lockfile and a pinned Docker base image. The operational complexity of Nix — the learning curve is steep, the error messages are famously hostile, and the ecosystem documentation assumes significant prior knowledge — is substantial. Use it when you need what it uniquely provides.

---

## When Hermetic Builds Break

Achieving true hermeticity requires eliminating a catalog of common violations. These are the ones that look hermetic but aren't.

### Violation 1: Build-Time Network Access

The most common violation. Any `RUN` step in a Dockerfile that downloads from the internet is a hermetic build violation. This includes:

```dockerfile
# ❌ All of these are network calls during build. Each one can return
# different content on different days.
RUN curl -O https://example.com/some-tool.tar.gz
RUN wget https://releases.hashicorp.com/terraform/1.6.0/terraform_1.6.0_linux_amd64.zip
RUN pip install -r requirements.txt  # resolves versions from PyPI at build time
RUN go get ./...                     # resolves modules from proxy.golang.org
RUN gem install bundler              # installs from rubygems.org
```

**Detection:** Run your build with `--network=none` (Docker) or in an air-gapped environment. Every build failure is a hermetic violation. Fix it by moving the download to a pre-build artifact fetch step that runs separately and is content-verified.

```dockerfile
# ✅ The network call happens before the Docker build, in a step that
# verifies the downloaded content against a known hash.
# The Dockerfile only uses pre-downloaded, verified artifacts.
COPY terraform_1.6.0_linux_amd64.zip /tmp/
RUN echo "e0a4a50b4b8a92fb5ab8d90a46a7b28e  /tmp/terraform_1.6.0_linux_amd64.zip" | md5sum -c \
    && unzip /tmp/terraform_1.6.0_linux_amd64.zip -d /usr/local/bin/
```

### Violation 2: Timestamp Embedding

Go, Java, and many other languages can embed build timestamps in binaries. This is useful for debugging ("when was this binary built?") but fatal for reproducibility — the same code, built one second apart, produces binaries with different digests.

```go
// ❌ This makes the binary non-reproducible.
var BuildTime = time.Now().Format(time.RFC3339)
```

```go
// ✅ Accept the build time as a linker flag, injected from the CI system.
// The binary is reproducible for the same source inputs.
// The build time is still available, but it's injected at CI time, not at
// compile time, so two builds from the same commit at the same CI run
// produce identical binaries.
var BuildTime string  // Set via: go build -ldflags="-X main.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

```yaml
# In CI — inject the build time as a linker flag, not embedded in source.
- name: Build
  run: |
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    go build -ldflags="-X main.BuildTime=${BUILD_TIME} -X main.GitSHA=${GITHUB_SHA}" -o ./bin/service ./cmd/service
```

### Violation 3: Non-Deterministic File Ordering

Some build tools process files in filesystem order, which is not guaranteed to be deterministic across operating systems, filesystems, or kernel versions. A build that globs files and processes them in directory-listing order may produce different outputs on macOS (HFS+, alphabetical) vs. Linux ext4 (inode order) vs. Linux tmpfs (arbitrary).

**Detection:** Build on two different machines and compare digests. If they differ for reasons you can't explain, investigate file ordering in glob patterns.

**Fix:** Sort all file lists explicitly before processing. Many modern build tools (Bazel, Webpack 5+, esbuild) do this by default.

### Violation 4: Ambient Environment Variables

A build that reads environment variables from the host environment is not hermetic. `BUILD_ENV`, `NODE_ENV`, `RAILS_ENV` — if these are read during the build and change what the build produces, you have an ambient dependency.

```dockerfile
# ❌ If $NODE_ENV is "production" on the build agent, this behaves differently
# than when $NODE_ENV is "development". Non-hermetic.
RUN npm run build  # reads NODE_ENV from the environment

# ✅ Explicitly set the environment variable within the build step.
# The build behavior is now defined by the Dockerfile, not the build agent.
ENV NODE_ENV=production
RUN npm run build
```

### Violation 5: Generated Code Not Committed

Some projects generate code from specifications (Protobuf definitions, OpenAPI specs, database schema migrations) and don't commit the generated code. The generation step runs during the build, using whatever code generator version is available in the build environment. If the generator version changes between builds, the generated code changes, and the build output changes even though no input source changed.

**Resolution:** Either commit generated code and fail the build if it would regenerate differently, or pin the code generator version in the build definition and verify the generated output is bit-for-bit identical to the committed version.

```yaml
# ✅ CI step that verifies generated code is up to date
- name: Verify generated code is committed
  run: |
    # Re-run code generation using the pinned generator
    make generate
    # If any files changed, the committed generated code is stale
    if ! git diff --exit-code; then
      echo "Generated code is out of date. Run 'make generate' and commit the result."
      git diff
      exit 1
    fi
```

---

## Scale Considerations

### At 1–10 Services: Hermetic Docker Builds Are Sufficient

For small teams and small service counts, the full Bazel/Nix toolchain is overkill. A well-structured Dockerfile with pinned base images, frozen lockfiles, and multi-stage builds satisfies the hermetic build requirement at acceptable cost. Setup time: an afternoon per service. Maintenance cost: update base image digests monthly (automate this with Dependabot or Renovate).

### At 10–50 Services: Remote Build Caching Becomes Essential

With 50 services in CI, cold-build time per pipeline run adds up. If each service takes 4 minutes to build and you run 100 CI pipelines per day, that's 200 compute-hours per day of raw build time — before you add tests.

The solution is a remote build cache shared across all CI runners and developer machines. Docker's BuildKit supports remote caching via `--cache-from` and `--cache-to`. Every build checks the remote cache before building; cache hits skip the build entirely.

```bash
# Build with remote cache push/pull via GitHub Actions cache or S3
docker buildx build \
  --cache-from type=registry,ref=myregistry.io/myapp:buildcache \
  --cache-to type=registry,ref=myregistry.io/myapp:buildcache,mode=max \
  --tag myapp:${GIT_SHA} \
  --push \
  .
# mode=max: cache every layer, not just the final one.
# This maximizes cache hits for builds that differ only in the final layers.
```

Remote Docker caches are safe only for hermetic builds. A non-hermetic build might get a false cache hit — using a cached layer that was built with different implicit inputs than the current build. Hermetic builds guarantee that same inputs → same outputs → safe to cache.

### At 50+ Services / Monorepo Scale: Bazel Remote Execution

At 100+ services in a monorepo, build caching is necessary but not sufficient. You also need parallelism across machines — the ability to distribute build and test actions across a pool of workers.

Bazel supports Remote Execution via the Remote Execution API (REAPI). With remote execution, Bazel's scheduler sends build actions to a pool of workers (EngFlow, BuildBuddy, Google Cloud Build, or self-hosted RBE), each of which executes a hermetic action in an isolated sandbox. The result is uploaded to the remote cache. Subsequent builds that hit the cache skip the execution entirely.

Benchmark numbers from publicly available case studies:
- Netflix (monorepo with ~4,000 build targets): Bazel with remote execution reduced CI build time from 45 minutes to 6 minutes
- Dropbox (Python + Go monorepo): Remote execution with a 50-worker pool reduced mean CI time from 22 minutes to 4 minutes
- Airbnb (JavaScript monorepo with Nx + remote cache): 73% reduction in CI build time after enabling remote caching

The inflection point where Bazel earns its adoption cost is typically around 50 services or whenever CI build time exceeds 15 minutes on a warm cache. Below that threshold, Docker with remote caching is usually sufficient.

---

## The Anti-Patterns

### ❌ Anti-Pattern: The `latest` Base Image

**What it looks like:** `FROM node:18` or `FROM python:3.11` — floating tags without a digest pin.

**Why it happens:** It's convenient. The tag automatically tracks minor/patch updates "for free." Teams convince themselves this is a maintenance benefit.

**What breaks:** Silent base image changes can introduce behavioral differences between builds. A glibc security patch in the base image can change linking behavior (exactly Lena's problem). An OpenSSL update can change TLS handshake behavior. Pinning by digest means you control when the base image updates, and you can test the update before it silently affects production builds.

**The fix:** Pin all base images by digest. Automate digest updates with Dependabot or Renovate, which opens PRs when new image versions are available and runs CI on the update before it merges.

---

### ❌ Anti-Pattern: CGO Without Static Linking in Multi-OS Deployments

**What it looks like:** A Go binary built with CGO enabled on the CI runner, dynamically linked against the host glibc, deployed to production servers with a different glibc version than the CI runner.

**Why it happens:** CGO is required for some libraries (SQLite, certain crypto libraries, OS-specific bindings). Developers don't think about dynamic linking until the binary fails on a different OS version.

**What breaks:** The binary fails to start on hosts with a different glibc version than the build host. This is a runtime crash, not a build failure — it passes CI completely and fails in production.

**The fix:** `CGO_ENABLED=0` where possible. When CGO is required, build inside a container with the same glibc as the target, use Alpine with musl libc (which is statically linked by default), or use `go build -ldflags='-linkmode external -extldflags "-static"'` to force static linking. Bazel's `pure = "on"` setting enforces this at the build system level.

---

### ❌ Anti-Pattern: The Dockerfile That Runs Tests

**What it looks like:** The Dockerfile's build stage runs `npm test` or `pytest` or `go test ./...` to generate a "build passed tests" label on the image.

**Why it happens:** Someone wanted a single artifact that "proves" it passed tests. Running tests in the Docker build seems like a way to bake that proof into the image.

**What breaks:** Test results become part of the build cache in ways that are hard to reason about. If the test results are cached from a previous run, the tests didn't actually run. Test execution adds build time to every image pull (Docker layer cache behavior is non-obvious). Network-dependent tests break the hermetic build requirement. And the Docker build cache means tests may be skipped in ways you don't expect.

**The fix:** Run tests in CI as a separate job that produces a test results artifact. Build the image separately. Use SLSA attestations or a CI job dependency to establish provenance: "this image was built from commit X, which passed test suite Y." The image build and the test execution are separate concerns; don't combine them.

---

### ❌ Anti-Pattern: Ignoring Package Manager Lockfiles

**What it looks like:** `requirements.txt` with `requests>=2.28.0` (no upper bound, no exact pin). Or `package.json` with `"^3.0.0"` dependencies and no committed `package-lock.json`. Or `go.sum` not committed to the repository.

**Why it happens:** Version ranges feel flexible and low-maintenance. Pinning everything feels like busywork that slows down dependency updates.

**What breaks:** Two builds from the same source code commit, run on different days, can install different transitive dependency versions. The difference is silent — no error, no warning. The behavioral difference (if any) only appears in testing or production.

**The fix:** Commit lockfiles for all package managers (`package-lock.json`, `yarn.lock`, `Pipfile.lock`, `poetry.lock`, `go.sum`, `Gemfile.lock`, `Cargo.lock`). Use `--frozen-lockfile` (npm), `--require-hashes` (pip), or equivalent flags to fail the build if the lockfile and the manifest are inconsistent. The lockfile is the canonical specification of your dependency tree — treat it with the same rigor as source code.

---

## Field Notes

💀 **`RUN curl | bash` in a Dockerfile** → Whatever that URL serves today becomes part of your production binary tomorrow → Find the script, vendor it, pin the version, verify the hash. This pattern is a supply chain attack waiting to happen.

💀 **"Our builds are reproducible" (unverified)** → Assuming hermeticity without testing it → Add a nightly CI job that builds the same commit twice and compares digests. The first failure will identify a violation you didn't know existed.

💀 **Skipping lockfile updates because "it works"** → Stale lockfiles accumulate security vulnerabilities in transitive dependencies → Use Dependabot or Renovate to automate lockfile updates as weekly PRs. Review the diff, run the tests, merge. The automation makes the maintenance cost negligible.

💀 **Not enforcing immutable tags in the artifact registry** → A `latest` tag overwritten during a rollout destroys the previous version's rollback target → Enable immutable tag enforcement in ECR/GCR/Artifactory. This takes five minutes. Not doing it takes one incident.

---

## Chapter Summary

A hermetic build is not a Docker build. It is a build with three specific properties — isolation, reproducibility, and completeness — that together guarantee that the artifact you tested in CI is identical to the artifact you deploy to production. Docker is a tool that can implement hermetic builds when used correctly (pinned base image digests, frozen lockfiles, no network access at build time). Used incorrectly, it gives you the aesthetics of a hermetic build with none of the guarantees.

Bazel achieves deeper hermeticity by managing toolchain versions in addition to application dependencies. It is the right choice for large monorepos where the content-addressed incremental build capability pays back its operational complexity many times over. For smaller systems, a well-configured Docker build is sufficient.

The three most important concrete actions: pin all base images by digest, commit all lockfiles and use `--frozen-lockfile`, and run a nightly reproducibility check. These three changes cost an afternoon and prevent an entire class of production incidents that are notoriously hard to debug after the fact.

---

## What's Next

Hermetic builds give you reproducibility. The Matrix Build Pattern (Chapter 4) gives you coverage: the ability to verify that a hermetic build produces correct artifacts across every platform, OS version, language runtime version, and architecture combination your users depend on. It also introduces the combinatorial explosion problem — and the strategies for managing it before your CI matrix becomes a runaway cost center.
