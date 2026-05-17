# Part I: Principles of Modern Release Engineering

## What This Part Is About

In 2006, if you wanted to see whether your build was broken, you waited until morning. That wasn't laziness — that was the state of the art. A "nightly build" was considered sophisticated engineering practice. Integration was a scheduled event, like a dentist appointment you'd been dreading. Every few weeks, all the branches merged together, and for the next three days, everyone stopped writing features and became archaeologists, excavating why six different people's code had turned into a smoking crater when combined.

This part is about how that world ended — and why most organizations are still haunted by its ghost.

The two chapters here don't cover patterns. They cover the *substrate* that every other pattern in this book depends on. Chapter 1 traces the historical arc from nightly builds through CI to the modern synthesis of CI, CD, and Continuous Training as a unified discipline. Chapter 2 establishes the principles that the rest of the book assumes: trunk-based development, hermetic reproducibility, immutable artifacts, and the deployment safety contract. If you skip these chapters and jump straight to Chapter 17 (Blue-Green Deployments), you'll be able to implement the pattern. You won't understand why it breaks the way it breaks.

The unifying insight of this part is that release engineering is not a set of tools. It's a set of *commitments* — to the codebase, to your team, and to your users. Tools implement those commitments. Pipelines encode them. But before you can choose the right tools or design the right pipeline, you need to be precise about what you're actually committing to. That precision is what this part builds.

## Why These Chapters Belong Together

Chapter 1 and Chapter 2 are a matched pair. Chapter 1 gives you the *historical context* for why things are the way they are — why the industry converged on certain practices, what pain those practices were responding to, and what the paradigm shifts actually meant. Chapter 2 gives you the *principled foundation* — the first-order commitments that follow logically from that history and that every subsequent pattern in the book extends.

Without Chapter 1, Chapter 2 reads like a list of dogma. Without Chapter 2, Chapter 1 is just a history lesson. Together, they answer the question: *What is modern release engineering actually trying to accomplish, and why?*

## Chapter Map

```
Chapter 1: The Evolution of CI, CD, and CT
    │
    │  Establishes: vocabulary, historical context, the three disciplines
    │  Answers: "Where did all this come from? Why does it work this way?"
    │
    ▼
Chapter 2: Core Principles
    │
    │  Establishes: trunk-based dev, hermetic builds, immutable artifacts,
    │               the deployment safety contract, the testing philosophy
    │  Answers: "What does a well-designed pipeline actually guarantee?"
    │
    ▼
    ┌─────────────────────────────────────────────────────┐
    │  Part II (CI Patterns) — build on Chapter 2's       │
    │  hermetic and reproducibility principles             │
    │                                                     │
    │  Part III (CD Patterns) — build on Chapter 2's      │
    │  safety contract and immutable artifact axioms       │
    │                                                     │
    │  All subsequent parts — assume Chapter 1's          │
    │  vocabulary (CI/CD/CT) is understood                 │
    └─────────────────────────────────────────────────────┘
```

Read Chapter 1 before Chapter 2. Read both before anything else.

## Prerequisites

Before reading this part, you should be comfortable with:
- Basic familiarity with at least one CI system (GitHub Actions, Jenkins, GitLab CI, CircleCI, or similar) — not expert-level, just enough to have written a `.yml` file and watched it run
- Basic Git workflow: commits, branches, pull requests, merges
- The concept of automated testing: unit tests, integration tests — not the theory, just the fact that they exist and get run somewhere

You do *not* need to know Kubernetes, Terraform, Argo CD, or any deployment tooling to read this part. That comes later.

## Chapters in This Part

| Chapter | Title | Core Question Answered |
|---|---|---|
| [1](./chapter-01-evolution-ci-cd-ct.md) | The Evolution of CI, CD, and CT | How did the industry get here, and what does the vocabulary actually mean? |
| [2](./chapter-02-core-principles.md) | Core Principles | What does a well-designed pipeline guarantee, and what axioms does it rest on? |
