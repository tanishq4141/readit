# Part VIII: Pipeline Architecture & Day-Two Operations

## What This Part Is About

Parts II through VII covered patterns for what a pipeline does: build, test, deploy, observe, retrain. This part covers the architecture of the pipeline itself — how it's organized, governed, operated, and secured.

Day-one pipeline design is relatively easy: pick a CI system, write some YAML, ship code. Day-two operations are where most organizations discover that their pipeline decisions don't scale. Forty services with forty hand-crafted pipelines means forty places to apply security patches. An emergency hotfix at 11 PM with a 45-minute approval cycle means the vulnerability stays live until morning. A rollback that fails because a database migration already ran means the rollback just made things worse. A compromised base image in the container registry means the supply chain attack you didn't architect for is already inside your production systems.

The four chapters in this part address these day-two realities directly:

- **Chapter 43** covers Pipeline-as-Code and templates: how to design shared pipeline infrastructure that reduces per-team maintenance burden while maintaining governance
- **Chapter 44** covers break-glass (emergency hotfix): how to bypass pipeline gates in a genuine emergency without creating a security hole that attackers can exploit
- **Chapter 45** covers rollback and roll-forward: the mechanics of undoing a bad deployment, the cases where rollback is impossible, and when rolling forward is safer
- **Chapter 46** covers artifact security and supply chain: signing, attestation, SBOM generation, and defense against the class of attacks that target the build pipeline rather than the application code

## Chapters in This Part

| Chapter | Title | Core Question Answered |
|---|---|---|
| [43](./chapter-43-pipeline-as-code-template.md) | The Pipeline-as-Code & Template Pattern | How do you build reusable pipeline templates that scale across dozens of services? |
| [44](./chapter-44-break-glass-hotfix.md) | The Break-Glass (Emergency Hotfix) Pattern | How do you bypass pipeline gates in an emergency without compromising security? |
| [45](./chapter-45-rollback-roll-forward.md) | The Rollback & Roll-forward Patterns | When do you go back, when do you go forward, and how do you make either safe? |
| [46](./chapter-46-artifact-registry-supply-chain.md) | The Artifact Registry & Supply Chain Security Pattern | How do you verify that your artifacts are what you think they are? |
