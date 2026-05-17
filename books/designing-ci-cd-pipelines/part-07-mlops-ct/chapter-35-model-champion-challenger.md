# Chapter 35: The Model Champion/Challenger Pattern
*Part VII: MLOps, AI & Continuous Training (CT)*

> *"The challenger had better offline metrics on our test set.
> We promoted it. Online metrics were worse.
> The test set was not representative of production traffic.
> The champion was actually better. We didn't know
> because we'd never compared them on production traffic."*
> — ML team lead at a recommendation engine company

---

## The War Story

The recommendations team at Solaris Media trains a new collaborative filtering model. Offline evaluation on the holdout test set shows:
- Challenger model: NDCG@10 = 0.412, precision@5 = 0.31
- Champion model: NDCG@10 = 0.387, precision@5 = 0.28

The challenger is 6.5% better on NDCG and 11% better on precision. The team promotes it to production.

Two weeks later, the engagement metrics are down: session length -3.2%, click-through rate -1.8%, video completion rate -4.1%. All statistically significant. The team suspects the recommendation model.

They roll back to the champion. The metrics recover.

The investigation reveals: the test set overrepresents heavy users (users with 100+ interactions), because those users generate most of the historical data. The challenger model is significantly better for heavy users. But production traffic is 68% light users (fewer than 10 interactions). For light users, the challenger is actually worse — it over-relies on collaborative signals that don't exist for users with sparse interaction history.

The test set was not representative of production traffic distribution. The champion/challenger evaluation was only comparing on the test set, not on production traffic.

---

## What You'll Learn

- The champion/challenger framework: statistical comparison of production model vs. challenger
- Evaluation pipeline design: what metrics to compare, what datasets to use, and what constitutes a statistically significant improvement
- The test set representativeness problem: ensuring offline evaluation matches production traffic
- Champion/Challenger as a CI gate: failing the training pipeline if the challenger doesn't beat the champion
- When to use shadow scoring vs. live A/B testing for champion/challenger evaluation

---

## The Champion/Challenger Framework

The champion is the model currently in production. The challenger is the newly trained model. The champion/challenger pattern requires that the challenger must statistically outperform the champion before being promoted to production.

This is distinct from "the challenger has better metrics on the test set." The evaluation must be:
1. **On a representative dataset** — one that matches production traffic distribution
2. **Statistically significant** — the improvement must exceed the noise floor
3. **On business-relevant metrics** — not just model metrics (NDCG) but downstream business metrics (engagement, conversion, revenue)
4. **Multi-metric** — improvement on one metric should not come at the cost of significant regression on another

```python
# champion_challenger.py — evaluation pipeline component

from scipy import stats
import numpy as np
from dataclasses import dataclass
from typing import Optional

@dataclass
class EvaluationResult:
    champion_metric: float
    challenger_metric: float
    improvement_pct: float
    p_value: float
    is_significant: bool
    recommendation: str  # "promote", "reject", "inconclusive"

def evaluate_champion_vs_challenger(
    champion_predictions: pd.DataFrame,
    challenger_predictions: pd.DataFrame,
    labels: pd.DataFrame,
    metric_fn: callable,
    min_improvement_pct: float = 1.0,    # Challenger must be ≥1% better
    significance_level: float = 0.05,    # p-value threshold
    # Correction for multiple comparisons (Bonferroni)
    n_metrics: int = 1
) -> EvaluationResult:
    
    # Compute metric per example for statistical testing
    # (not just aggregate metrics — we need sample-level values for tests)
    champion_per_sample = compute_per_sample_metric(
        champion_predictions, labels, metric_fn
    )
    challenger_per_sample = compute_per_sample_metric(
        challenger_predictions, labels, metric_fn
    )
    
    champion_metric = np.mean(champion_per_sample)
    challenger_metric = np.mean(challenger_per_sample)
    improvement_pct = (challenger_metric - champion_metric) / champion_metric * 100
    
    # Paired t-test: compare per-sample metrics between champion and challenger
    # Paired because both models scored the same examples
    t_stat, p_value = stats.ttest_rel(challenger_per_sample, champion_per_sample)
    
    # Bonferroni correction for multiple metrics
    adjusted_significance = significance_level / n_metrics
    is_significant = p_value < adjusted_significance and improvement_pct > 0
    
    if is_significant and improvement_pct >= min_improvement_pct:
        recommendation = "promote"
    elif p_value < adjusted_significance and improvement_pct < -min_improvement_pct:
        recommendation = "reject"  # Statistically significantly worse
    else:
        recommendation = "inconclusive"
    
    return EvaluationResult(
        champion_metric=champion_metric,
        challenger_metric=challenger_metric,
        improvement_pct=improvement_pct,
        p_value=p_value,
        is_significant=is_significant,
        recommendation=recommendation
    )
```

---

## The Representativeness Problem

The Solaris Media incident was caused by a non-representative test set. The fix: stratified evaluation that explicitly tests performance across user segments.

```python
def stratified_champion_challenger_evaluation(
    champion_model: Model,
    challenger_model: Model,
    eval_dataset: Dataset,
    user_segments: dict  # {"heavy": filter_heavy_users, "light": filter_light_users}
) -> dict:
    """
    Evaluate champion vs. challenger across user segments.
    
    An improvement in heavy users that comes at the cost of light users
    is NOT an overall improvement — because light users are 68% of traffic.
    """
    
    results = {}
    
    # Overall evaluation
    results["overall"] = evaluate_champion_vs_challenger(
        champion_model.predict(eval_dataset),
        challenger_model.predict(eval_dataset),
        eval_dataset.labels,
        metric_fn=ndcg_at_10
    )
    
    # Segment-level evaluation
    for segment_name, segment_filter in user_segments.items():
        segment_data = eval_dataset.filter(segment_filter)
        results[segment_name] = evaluate_champion_vs_challenger(
            champion_model.predict(segment_data),
            challenger_model.predict(segment_data),
            segment_data.labels,
            metric_fn=ndcg_at_10
        )
    
    # Gate: fail if improvement in overall comes at the cost of regression in any large segment
    for segment, result in results.items():
        if result.improvement_pct < -2.0:  # >2% regression in any segment
            raise ModelEvaluationFailed(
                f"Challenger regresses on segment '{segment}' by {result.improvement_pct:.1f}%. "
                f"This is not an acceptable trade-off."
            )
    
    return results
```

---

## Champion/Challenger as a CI Gate

In the CT pipeline, the champion/challenger evaluation is a blocking gate. The pipeline fails if the challenger doesn't beat the champion:

```python
# In the Kubeflow Pipeline (from Chapter 33):
@dsl.component
def evaluate_and_gate(
    challenger_model_uri: str,
    champion_model_uri: str,
    eval_data_uri: str,
    min_improvement_pct: float = 1.0
) -> str:
    """
    Compare challenger to champion. Fail the pipeline if challenger is not better.
    Returns the URI of the model to register (always the better one).
    """
    
    results = evaluate_champion_vs_challenger(
        champion_model=load_model(champion_model_uri),
        challenger_model=load_model(challenger_model_uri),
        eval_dataset=load_dataset(eval_data_uri),
        min_improvement_pct=min_improvement_pct
    )
    
    if results["overall"].recommendation == "reject":
        # Challenger is statistically significantly worse — stop the pipeline
        # The champion stays in production
        raise ValueError(
            f"Challenger model rejected: {results['overall'].improvement_pct:.1f}% worse "
            f"than champion (p={results['overall'].p_value:.4f}). "
            f"Champion remains in production."
        )
    
    if results["overall"].recommendation == "inconclusive":
        # Not enough evidence to promote — keep the champion
        # This is the safe default: don't promote without evidence
        print(f"Challenger evaluation inconclusive: {results['overall'].improvement_pct:.1f}% "
              f"improvement but p={results['overall'].p_value:.4f} (threshold: 0.05). "
              f"Champion retained.")
        return champion_model_uri
    
    # Challenger is better — return it for registration
    print(f"Challenger promoted: {results['overall'].improvement_pct:.1f}% improvement "
          f"(p={results['overall'].p_value:.4f})")
    return challenger_model_uri
```

---

## When to Use Shadow Scoring Instead of Offline Evaluation

For models where offline evaluation is demonstrably non-representative of production traffic (the Solaris Media case), shadow scoring (Chapter 36) provides a better evaluation baseline. Shadow the challenger against real production traffic before any comparison.

The decision framework:
- **Offline evaluation sufficient:** test set is well-designed and known to be representative, business impact of a wrong model is low, iteration speed matters
- **Shadow scoring required:** offline metrics have historically not predicted online performance, model serves highly heterogeneous user populations, business impact of a wrong model is high (fraud, pricing, safety)

---

## Anti-Patterns

### ❌ Anti-Pattern: Promoting Based on Offline Metrics Alone

**What it looks like:** The challenger shows better NDCG on the holdout set. It's promoted. Online metrics degrade. The test set wasn't representative.

**The fix:** Stratified evaluation across user segments. Shadow scoring against production traffic before promotion for high-stakes models.

---

### ❌ Anti-Pattern: Champion/Challenger Without Statistical Testing

**What it looks like:** "The challenger got 0.412 and the champion got 0.387. 0.412 is bigger. Promote."

**What breaks:** The difference may not be statistically significant. Promoting based on noise produces models that are not actually better.

**The fix:** Paired t-test or bootstrap confidence intervals on per-sample metric distributions. A p-value threshold (0.05) before promotion.

---

## Field Notes

💀 **Non-stratified test set for heterogeneous user population** → Heavy users dominate metrics, light users (68% of traffic) are undertested → Stratified evaluation is not optional for population-heterogeneous recommendation systems.

💀 **No minimum improvement threshold** → Challenger is 0.1% better, statistically significant, gets promoted — may not justify the risk of a new model version → Set a minimum practical significance threshold (1% improvement) in addition to the statistical significance threshold.

---

## Chapter Summary

The champion/challenger pattern ensures that production models only get replaced by provably better models. The statistical testing requirement prevents promoting models that appear better due to measurement noise. The representativeness requirement prevents the Solaris Media outcome: a model that looks better on the test set but is worse on production traffic. The CI gate implementation makes this evaluation automatic — every CT run either produces a better model or leaves the champion in place.

[→ Next: Chapter 36 — The Model Shadowing Pattern](./chapter-36-model-shadowing.md)

---
*[← Previous: Chapter 34 — The Feature Store Synchronization Pattern](./chapter-34-feature-store-sync.md) |
[→ Next: Chapter 36 — The Model Shadowing Pattern](./chapter-36-model-shadowing.md)*
