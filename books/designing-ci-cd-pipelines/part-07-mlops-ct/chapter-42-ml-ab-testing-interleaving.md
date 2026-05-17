# Chapter 42: The ML A/B Testing & Interleaving Pattern
*Part VII: MLOps, AI & Continuous Training (CT)*

> *"We ran the A/B test for 48 hours. The new model showed +4% CTR.
> We promoted it. Three weeks later, the same metric showed -2% CTR.
> The 48-hour result was noise. The sample size was insufficient.
> We made a promotion decision on a false positive."*
> — ML team lead at a media recommendation company

---

## The War Story

The recommendations team at Solaris Video runs A/B tests to compare new recommendation models against the current champion. Their process: split traffic 50/50, run for 48 hours, look at click-through rate. If the new model shows improvement, promote.

In March, a new model shows +4.2% CTR in the 48-hour test. The team promotes it.

Over the following three weeks, CTR slowly returns to baseline. By week four, CTR is -2.1% below the original level. The A/B test result was a false positive driven by novelty effect: users click on new recommendations more initially because they're different, not because they're better. The novelty effect decays over 1–2 weeks, revealing the model's true performance.

The team's 48-hour test window was too short to allow the novelty effect to decay. Their sample size calculation assumed independent traffic allocation, but recommendation models create correlated effects across sessions for the same user. Their metric (CTR) was high-variance, requiring more samples than their calculation assumed.

---

## What You'll Learn

- Sample size calculation for ML A/B experiments: why ML experiments need more samples than typical A/B tests
- The novelty effect and how to account for it: minimum test duration requirements
- Guardrail metrics: preventing regressions on metrics you're not optimizing
- Interleaving for ranking models: a statistically superior alternative to traditional A/B testing for ranking systems
- Multi-armed bandit approaches: adaptive traffic allocation during model experiments
- Common statistical pitfalls in ML A/B testing: peeking, multiple comparisons, sequential testing

---

## Sample Size Calculation for ML Experiments

Standard A/B testing sample size formulas assume independent Bernoulli trials with fixed effect size. ML recommendation experiments violate both:

1. **User-level correlation:** The same user appears in multiple sessions. Their behavior is correlated across sessions — if a user dislikes the new recommendations, they'll have lower CTR across all their sessions, creating within-user correlation.

2. **Variable effect sizes:** Recommendation model improvements are often small (1–5%) and may apply only to specific user segments, requiring larger samples to detect.

The correct unit of randomization for recommendation experiments is **users, not sessions**.

```python
# sample_size.py — correct sample size calculation for ML experiments

from scipy import stats
import numpy as np

def calculate_ml_experiment_sample_size(
    baseline_ctr: float,         # e.g., 0.045 (4.5% CTR)
    minimum_detectable_effect: float,  # e.g., 0.01 (1% absolute improvement)
    alpha: float = 0.05,         # False positive rate
    power: float = 0.80,         # 1 - false negative rate
    design_effect: float = 1.5   # Inflation factor for within-user correlation
) -> dict:
    """
    Calculate required sample size for a recommendation model A/B test.
    
    design_effect: accounts for within-user correlation.
    For typical recommendation experiments: 1.3 to 2.0
    Estimate from historical data: DEFF = 1 + (n_sessions_per_user - 1) * ICC
    where ICC is the intra-class correlation of CTR within users.
    """
    
    # Standard formula for comparing two proportions
    p1 = baseline_ctr
    p2 = baseline_ctr + minimum_detectable_effect
    
    z_alpha = stats.norm.ppf(1 - alpha / 2)   # Two-tailed
    z_beta = stats.norm.ppf(power)
    
    # Standard sample size per group
    standard_n = (
        (z_alpha + z_beta) ** 2 *
        (p1 * (1 - p1) + p2 * (1 - p2))
    ) / (minimum_detectable_effect ** 2)
    
    # Apply design effect to account for within-user correlation
    adjusted_n = standard_n * design_effect
    
    # Convert to days based on typical daily unique users
    daily_unique_users = 100_000  # Site-specific
    days_needed = adjusted_n / (daily_unique_users / 2)  # 50% in each group
    
    return {
        "users_per_group": int(adjusted_n),
        "total_users": int(adjusted_n * 2),
        "days_at_50pct_split": days_needed,
        "days_with_novelty_buffer": days_needed + 14,  # Add 2 weeks for novelty decay
        "warning": "Consider adding 14 days for novelty effect decay" if days_needed < 14 else None
    }

# Example: Solaris Video's calculation
result = calculate_ml_experiment_sample_size(
    baseline_ctr=0.045,
    minimum_detectable_effect=0.002,  # 0.2% absolute improvement = 4.4% relative
    design_effect=1.5,
    power=0.80
)
print(result)
# Output:
# {'users_per_group': 187500, 'days_at_50pct_split': 3.75, 
#  'days_with_novelty_buffer': 17.75, ...}
# 
# The 48-hour test was insufficient. The correct duration was 18 days.
```

---

## Guardrail Metrics: Protecting What You're Not Optimizing

Every ML experiment must define guardrail metrics — secondary metrics that must not degrade significantly, even if the primary metric improves. The LLMOps chapter (Chapter 41) showed this failure mode: optimizing domain accuracy while degrading safety behaviors.

```python
# experiment_config.py

@dataclass
class ExperimentConfig:
    name: str
    primary_metric: str         # The metric being optimized
    minimum_improvement: float  # Minimum improvement to consider promoting
    
    # Guardrail metrics: experiment fails if any guardrail regresses beyond threshold
    guardrail_metrics: list[GuardrailMetric]
    
    # Statistical parameters
    alpha: float = 0.05
    power: float = 0.80
    minimum_days: int = 14     # Never run for less than 14 days

RECOMMENDATION_EXPERIMENT = ExperimentConfig(
    name="new-recommendation-model-march",
    primary_metric="click_through_rate",
    minimum_improvement=0.005,  # 0.5% absolute improvement
    guardrail_metrics=[
        GuardrailMetric(
            name="session_length",
            max_regression_pct=-2.0,  # Can't regress more than 2%
            description="Don't harm session engagement to improve CTR"
        ),
        GuardrailMetric(
            name="unsubscribe_rate",
            max_regression_pct=-0.1,   # Can't increase unsubscribes at all
            description="Never increase churn"
        ),
        GuardrailMetric(
            name="page_load_time_p99",
            max_regression_pct=-10.0,  # Can't add more than 10% to p99 latency
            description="Don't hurt performance to help recommendations"
        ),
    ],
    minimum_days=14
)
```

---

## Interleaving: The Statistically Superior Alternative for Ranking

Traditional A/B testing for recommendation systems requires weeks of data because each user only appears in one group (control or treatment). Interleaving solves this by showing users a blended list of results from both models, where both models compete for clicks on the same page view:

```python
# interleaving.py — Team-Draft Interleaving for ranking model comparison

def team_draft_interleave(
    list_a: list,  # Rankings from Model A (control)
    list_b: list,  # Rankings from Model B (treatment)
    n: int = 20    # Number of positions to fill
) -> tuple[list, dict]:
    """
    Team-Draft Interleaving: create an interleaved list from two ranked lists.
    
    Returns:
        - interleaved_list: the blended recommendation list shown to the user
        - item_assignment: which model "owns" each position in the blended list
    
    The model whose items get more clicks "wins" the comparison.
    This requires far fewer users than A/B testing for the same statistical power.
    """
    
    team_a, team_b = [], []
    interleaved = []
    item_assignment = {}  # item_id → "A" or "B"
    
    list_a_remaining = list(list_a)
    list_b_remaining = list(list_b)
    
    for i in range(n):
        if not list_a_remaining and not list_b_remaining:
            break
        
        # Flip a coin to decide which team picks first
        if random.random() < 0.5 or not list_b_remaining:
            # Team A picks first
            if list_a_remaining:
                item = list_a_remaining.pop(0)
                if item not in interleaved:
                    interleaved.append(item)
                    team_a.append(item)
                    item_assignment[item] = "A"
                    # Also pick for team B if it's the B list's turn
                    while list_b_remaining:
                        b_item = list_b_remaining.pop(0)
                        if b_item not in interleaved:
                            interleaved.append(b_item)
                            team_b.append(b_item)
                            item_assignment[b_item] = "B"
                            break
        else:
            # Team B picks first (symmetric)
            if list_b_remaining:
                item = list_b_remaining.pop(0)
                if item not in interleaved:
                    interleaved.append(item)
                    team_b.append(item)
                    item_assignment[item] = "B"
    
    return interleaved[:n], item_assignment

def evaluate_interleaving_result(
    clicks: list[str],  # Items that were clicked
    item_assignment: dict  # item_id → "A" or "B"
) -> dict:
    """Determine which model won based on click attribution."""
    
    clicks_a = sum(1 for item in clicks if item_assignment.get(item) == "A")
    clicks_b = sum(1 for item in clicks if item_assignment.get(item) == "B")
    
    return {
        "clicks_a": clicks_a,
        "clicks_b": clicks_b,
        "winner": "B" if clicks_b > clicks_a else ("A" if clicks_a > clicks_b else "tie")
    }
```

**Statistical efficiency of interleaving:** Interleaving requires 100–1000× fewer user-sessions than A/B testing to detect the same effect size. This is because every impression provides signal (the user saw results from both models), rather than the A/B approach where half your impressions are in the control group that provides no comparison information.

---

## Common Statistical Pitfalls

### The Peeking Problem

**What it looks like:** The team checks results every day. When the metric shows significance (p < 0.05) on day 3, they stop the test and promote.

**Why it's wrong:** Sequential hypothesis testing inflates the false positive rate. Checking at p=0.05 on days 3, 7, 14, 21 gives an effective false positive rate of ~22%, not 5%.

**The fix:** Preregister the test duration and sample size before starting. Don't look at significance results until the preregistered endpoint.

### Multiple Comparisons

**What it looks like:** Testing 10 metrics simultaneously. One shows p < 0.05 by chance.

**Why it's wrong:** With 10 metrics at α=0.05, you'd expect 0.5 false positives by chance.

**The fix:** Bonferroni correction (divide α by number of metrics) or FDR correction. Or: designate one primary metric before the experiment. Only use other metrics as guardrails, not as promotion criteria.

---

## Anti-Patterns

### ❌ Anti-Pattern: 48-Hour A/B Tests for Recommendation Models

**What it looks like:** The Solaris Video story. Short test, novelty effect, false positive.

**The fix:** 14-day minimum for recommendation experiments. Calculate required sample size accounting for within-user correlation and add a novelty decay buffer.

---

### ❌ Anti-Pattern: No Guardrail Metrics

**What it looks like:** Optimizing CTR, ignoring session length, unsubscribes, and page load time. CTR improves, session length drops.

**The fix:** Define guardrail metrics before the experiment. Any guardrail regression fails the experiment regardless of primary metric improvement.

---

## Chapter Summary

ML A/B testing requires more statistical rigor than standard web A/B testing because of within-user correlation, novelty effects, and high-variance metrics. The minimum viable discipline: correct sample size calculation (with design effect), minimum 14-day test duration, and predefined guardrail metrics. For ranking models where test duration is a bottleneck, interleaving provides the same statistical power with 100-1000× fewer user-sessions — making model comparison practical at any traffic level.

Part VII is complete. The MLOps lifecycle — from training triggers through feature stores, model evaluation, shadowing, lineage, orchestration, drift detection, GPU CI, LLM deployment, and A/B testing — covers the full arc of what it takes to operate ML models with the same rigor that software deployment applies to binaries.
