# Part V: Deployment Observability & Feedback Loops

## What This Part Is About

A deployment pipeline without feedback is a conveyor belt pointed at the unknown. The patterns in Parts II, III, and IV describe how to build, verify, and progressively deliver software. This part describes how to know whether what you delivered is actually working — and how to wire that knowledge back into the pipeline so the system learns from its own history.

The four chapters here address a gap that most engineering organizations have: deployments happen, metrics change, incidents occur, and postmortems are written — but the feedback loop from "what happened after we deployed" back to "how we deploy" is broken or missing. Teams measure DORA metrics on a dashboard that nobody looks at. They have SLOs that aren't connected to deployment gates. They have incidents with clear deployment-correlation that take hours to confirm because there are no deploy markers in the observability stack. They write postmortems with action items that never make it into the pipeline.

The unifying insight of this part: **the pipeline must be an instrumented system, not just an automation system**. It must emit events, consume metrics, and respond to signals from production. When the error budget is low, the pipeline should know. When a deployment correlates with a metric regression, the observability system should surface it within minutes. When an incident reveals a pipeline gap, the postmortem should produce a concrete pipeline change, not just a recommendation.

## Why These Chapters Belong Together

All four chapters address the signal flow between production and the pipeline:
- Chapter 23: production SLO state → deployment gate (block when error budget is low)
- Chapter 24: pipeline events → DORA metrics → pipeline improvements (measure what the pipeline produces)
- Chapter 25: deployment events → observability correlation → impact detection (know what each deploy did)
- Chapter 26: incidents → postmortems → pipeline changes (convert production pain into pipeline evolution)

They form a complete feedback loop: emit → measure → correlate → improve.

## Chapter Map

```
Production SLO State
        │
        ▼
Chapter 23: SLO-Based Release Gating
    (SLO health → deployment permission)
        │
        ├────────────────────────────▶ Chapter 24: DORA Metrics Feedback
        │                              (pipeline events → DORA measurement
        │                               → pipeline design improvements)
        │
        ▼
Chapter 25: Deployment Observability
    (deploy event → metric correlation
     → impact detection within minutes)
        │
        ▼
Chapter 26: Incident-Driven Feedback
    (incidents → postmortems
     → concrete pipeline changes)
```

## Prerequisites

- SLO basics: what a Service Level Objective is, what error budget means
- Basic familiarity with Prometheus (metrics, PromQL) or Datadog
- Parts III and IV: understanding of how deployments happen before wiring in the feedback

## Chapters in This Part

| Chapter | Title | Core Question Answered |
|---|---|---|
| [23](./chapter-23-slo-release-gating.md) | The SLO-Based Release Gating Pattern | How do you use error budget state to automatically gate or allow deployments? |
| [24](./chapter-24-dora-metrics-feedback.md) | The DORA Metrics Pipeline Feedback Pattern | How do you measure what your pipeline produces and use those measurements to improve it? |
| [25](./chapter-25-deployment-observability.md) | The Deployment Observability & Correlation Pattern | How do you connect deployment events to metric changes so you know what each deploy did? |
| [26](./chapter-26-oncall-incident-feedback.md) | The On-Call & Incident-Driven Release Feedback Pattern | How do you convert production incidents into pipeline improvements? |
