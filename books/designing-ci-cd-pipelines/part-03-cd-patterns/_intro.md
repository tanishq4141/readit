# Part III: Delivery & Deployment Patterns (CD)

## What This Part Is About

Getting code to compile and pass tests — Part II's territory — is the easier half of release engineering. The harder half is getting that verified code to production safely, repeatedly, and at speed. Deployment is where the blast radius is real. A broken build hurts one developer's workflow. A broken deployment hurts users.

The patterns in this part address the seven distinct problems that make continuous delivery hard in practice. They are not theoretical constructs — each one emerged from organizations hitting specific walls and engineering their way through them. Push-based deployment broke at Kubernetes scale when credential sprawl meant CI pipelines had outbound network access to hundreds of clusters. GitOps emerged as the answer. Shared staging environments broke developer velocity when a single bad migration could block everyone for hours. Ephemeral environments emerged as the answer. Environment configuration drift caused prod to behave differently than staging despite "identical" configurations. Immutable artifact promotion emerged as the answer.

The unifying principle of this part: **deployment is a data problem as much as an automation problem**. What is deployed, where, in what version, with what configuration, at what time, authorized by whom — this data must be explicit, versioned, auditable, and accurate. Deployments that rely on implicit state, ambient configuration, or undocumented manual steps are deployments that fail in ways you can't debug.

## Why These Chapters Belong Together

All seven chapters in this part address the question: *how does a verified artifact get from the CI system to a running production environment, safely?* They progress from fundamental architecture (push vs. pull) through the operational patterns that make the architecture work in practice (GitOps, promotion, multi-service coordination) to the economic and strategic constraints that shape deployment architecture at scale (FinOps).

The chapters are more interdependent than Part II's chapters. GitOps (Chapter 11) depends on understanding push vs. pull (Chapter 10). Environment promotion (Chapter 13) depends on understanding GitOps. Ephemeral environments (Chapter 12) work best inside a GitOps framework. Multi-microservice coordination (Chapter 14) requires environment promotion. Read them in order for the first time.

## Chapter Map

```
Chapter 10: Push vs. Pull
    │  The architectural choice that determines everything else.
    │  Most modern deployment architectures use pull for Kubernetes
    │  and push for simple/serverless targets.
    │
    └──────────────────────────────▶ Chapter 11: GitOps
                                      (pull-based deployment formalized
                                       as an operational pattern)
                                            │
                                ┌───────────┴────────────┐
                                ▼                        ▼
                    Chapter 12: Ephemeral          Chapter 13: Environment
                    Environments                    Promotion
                    (GitOps extended to            (GitOps artifacts move
                     per-PR preview envs)           through environments)
                                                         │
                                                         ▼
                                              Chapter 14: Multi-Microservice
                                              Coordination
                                              (Promotion for multiple
                                               interdependent services)
                                                         │
                                           ┌─────────────┴──────────┐
                                           ▼                        ▼
                               Chapter 15: Branch by          Chapter 16: FinOps
                               Abstraction                     Target
                               (Making big changes            (Making deployments
                                without big-bang deploys)      economically accountable)
```

## Prerequisites

Before reading this part, you should be comfortable with:
- Docker and container images (Part II, Chapter 3)
- Basic Kubernetes: what a Pod, Deployment, and Service are. Not an expert — just the concepts.
- The vocabulary from Part I: immutable artifacts, trunk-based development, the deployment safety contract
- Git basics: you understand what a commit, branch, and merge request are

You do not need prior knowledge of Argo CD, Flux, Helm, or Terraform. The chapters introduce them with enough context to follow the implementation.

## Chapters in This Part

| Chapter | Title | Core Question Answered |
|---|---|---|
| [10](./chapter-10-push-vs-pull.md) | The Push vs. Pull Deployment Pattern | Should CI push changes to environments, or should agents pull them? |
| [11](./chapter-11-gitops.md) | The GitOps Pattern | How do you use Git as the single source of truth for production state? |
| [12](./chapter-12-ephemeral-environment.md) | The Ephemeral Environment Pattern | How do you give every PR its own isolated, production-fidelity environment? |
| [13](./chapter-13-environment-promotion.md) | The Environment Promotion Pattern | How do you safely move artifacts from dev → staging → production? |
| [14](./chapter-14-multi-microservice-coordination.md) | The Multi-Microservice Coordination Pattern | How do you deploy interdependent services without breaking each other? |
| [15](./chapter-15-branch-by-abstraction.md) | The Branch by Abstraction Pattern | How do you make large-scale changes without long-lived feature branches? |
| [16](./chapter-16-finops-target.md) | The FinOps Target Pattern | How do you make cloud cost a first-class pipeline constraint? |
