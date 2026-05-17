# Part X: Real-World Architectures (Case Studies)

## What This Part Is About

The eleven parts of this book describe patterns in the abstract — the problems they solve, the implementations they use, the failure modes they create. This part grounds those abstractions in four real organizations that have built production-grade delivery systems at different scales and under different constraints.

The four organizations represent four distinct deployment contexts:

**Vercel** represents the startup that ships fast at the edge. Their deployment pipeline is not just internal tooling — it is the product. Preview deployments, instant edge propagation, and the build cache are customer-facing features. Understanding how Vercel ships teaches what's possible when the pipeline is designed as a product rather than a utility.

**Netflix** represents the enterprise microservices organization. Over 1,000 microservices, hundreds of engineers, global operations, and a culture of team autonomy that would collapse into chaos without the "paved road" platform engineering model. Spinnaker, Kayenta, and Chaos Monkey all emerged from Netflix's specific operational context.

**Capital One** represents the regulated financial services organization. SOX compliance, PCI-DSS requirements, change advisory boards, and air-gapped network environments create constraints that make "just deploy continuously" feel naive. Capital One's public documentation of their cloud-native transformation shows how compliance becomes code rather than bureaucracy.

**Google** represents planetary-scale hyperscale. Piper (the world's largest monorepo), Blaze/Bazel, the submit queue, TAP (Test Automation Platform), and a dedicated Release Engineering discipline that treats the deployment pipeline as a first-class engineering product.

Chapter 57 synthesizes these case studies into a maturity model and decision framework — given your scale, constraints, and team, which patterns should you adopt, in what order, and what does the full lifecycle from IDE to production look like?

## Chapters in This Part

| Chapter | Title | Key Lesson |
|---|---|---|
| [53](./chapter-53-startup-pipeline-vercel.md) | The Startup Pipeline — How Vercel Ships | The pipeline as a product; preview deployments as a competitive feature |
| [54](./chapter-54-enterprise-pipeline-netflix.md) | The Enterprise Microservices Pipeline — How Netflix Delivers | The paved road; autonomy at scale; chaos as deployment validation |
| [55](./chapter-55-regulated-airgapped-capital-one.md) | The Regulated & Air-Gapped Pipeline — How Capital One Deploys | Compliance as code; automated evidence collection; cATO |
| [56](./chapter-56-hyperscale-pipeline-google.md) | The Global Hyper-Scale Pipeline — How Google Ships | The submit queue; Release Engineering as a discipline; one version at billion-user scale |
| [57](./chapter-57-ide-to-planet-scale-synthesis.md) | From IDE to Planet-Scale Deployment — A Synthesis | The maturity model; the decision framework; the full lifecycle |
