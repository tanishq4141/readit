# Chapter 39: The Data Drift Detection & Automated Retraining Pattern
*Part VII: MLOps, AI & Continuous Training (CT)*

> *"COVID hit in March 2020. Every model we had was wrong.
> Teams with drift detection noticed within 4 days.
> Teams without it noticed 6 weeks later when their business metrics cratered.
> That 6-week gap was the difference between 'we adapted' and 'we're explaining
> this to the board.'"*
> — data science director at a retail forecasting company

---

## The War Story

Prism Retail has a demand forecasting model that drives inventory decisions for 8,000 SKUs across 200 stores. The model was trained on three years of transaction data through January 2020. It was performing well: MAPE of 8.4%, consistently better than the industry benchmark of 12%.

March 15, 2020. Lockdowns. Consumer purchasing behavior changes overnight: toilet paper, hand sanitizer, frozen food surge. Seasonal items become irrelevant. Restaurant-adjacent categories collapse. The input distribution to Prism's forecasting model shifts so dramatically that the model's training distribution and the current production distribution have essentially zero overlap for hundreds of SKUs.

The demand forecasting model is now generating meaningless predictions. It continues generating them with full confidence for 43 days before anyone at Prism notices — because the accuracy metrics require comparing predictions to actuals, and actuals take time to materialize (goods ordered based on the forecast take 2–4 weeks to arrive and sell).

By the time the problem is identified (April 28), the model has informed purchasing decisions that result in $4.2M in excess inventory of wrong SKUs and stockouts in high-demand categories.

Teams with drift detection — monitoring the distribution of input features against the training baseline — detected the shift within 4 days of March 15 and immediately switched to simpler heuristic models while their demand forecasting models were retrained.

---

## What You'll Learn

- The three types of drift: covariate shift, concept drift, and label drift — and why each requires a different response
- Statistical drift detection: PSI (Population Stability Index), KS test, Jensen-Shannon divergence
- Evidently AI and WhyLabs for production drift monitoring
- Threshold-based and anomaly-detection-based retraining triggers
- The retraining trigger escalation ladder: soft alert → hard alert → automated retrain → human escalation
- When drift detection can't save you: sudden catastrophic shifts and the importance of model diversity

---

## The Three Types of Drift

### Covariate Shift (Input Distribution Drift)

The distribution of input features changes, but the relationship between inputs and outputs (the true function being modeled) remains the same. Example: a credit scoring model trained on users aged 25-45 is suddenly receiving requests from users aged 18-24 (new market segment). The model's learned patterns may not generalize to the new population.

Detection: compare the distribution of input features in production to the training baseline.

### Concept Drift

The relationship between inputs and outputs changes. The same inputs now map to different correct outputs. Example: COVID-19 changing the relationship between "proximity to a store" and "likelihood of visiting." The model's learned function is now wrong even for inputs within the training distribution.

Concept drift is harder to detect — it requires ground truth labels flowing back. You can detect it via performance monitoring (Chapter 33, Trigger 3) but not via input distribution monitoring alone.

### Label Drift

The distribution of target labels changes. Example: a fraud detection model where the fraud rate in production increases from 0.5% to 2% due to a new fraud ring. The model was calibrated for 0.5% fraud rate and its threshold is now miscalibrated.

Detection: monitor the prediction distribution (proxy for label distribution) against the training baseline.

---

## Statistical Drift Detection

### Population Stability Index (PSI)

PSI is the workhorse metric for drift detection in production ML systems. It compares the distribution of a feature in production against the training distribution:

```python
# drift_detection.py

import numpy as np
from scipy.stats import ks_2samp

def compute_psi(training_dist: np.array, production_dist: np.array, bins: int = 10) -> float:
    """
    Population Stability Index.
    
    PSI < 0.1:  No significant shift
    PSI 0.1–0.2: Moderate shift — investigate
    PSI > 0.2:  Significant shift — trigger retraining
    """
    # Create buckets based on training distribution
    breakpoints = np.percentile(training_dist, np.linspace(0, 100, bins + 1))
    breakpoints[0] = -np.inf
    breakpoints[-1] = np.inf
    
    # Count observations in each bucket
    train_counts = np.histogram(training_dist, bins=breakpoints)[0]
    prod_counts = np.histogram(production_dist, bins=breakpoints)[0]
    
    # Convert to proportions (add small epsilon to avoid log(0))
    eps = 1e-6
    train_pct = (train_counts + eps) / (len(training_dist) + eps * bins)
    prod_pct = (prod_counts + eps) / (len(production_dist) + eps * bins)
    
    # PSI formula: sum[(prod% - train%) * ln(prod% / train%)]
    psi = np.sum((prod_pct - train_pct) * np.log(prod_pct / train_pct))
    return psi


def compute_ks_drift(training_dist: np.array, production_dist: np.array) -> tuple[float, float]:
    """
    Kolmogorov-Smirnov two-sample test.
    Returns (statistic, p_value).
    p_value < 0.05 → statistically significant drift.
    """
    ks_stat, p_value = ks_2samp(training_dist, production_dist)
    return ks_stat, p_value
```

---

## Evidently AI: Production Drift Monitoring

Evidently AI is the leading OSS library for ML monitoring in production. It produces visual reports and JSON metrics for feature drift, prediction drift, and data quality:

```python
# production_drift_monitor.py

from evidently.report import Report
from evidently.metric_preset import DataDriftPreset, TargetDriftPreset
from evidently.metrics import DatasetDriftMetric, ColumnDriftMetric
import pandas as pd

def run_drift_report(
    reference_data: pd.DataFrame,  # Training data sample (reference distribution)
    current_data: pd.DataFrame,    # Recent production data (production distribution)
    output_path: str
) -> DriftResult:
    """
    Generate a comprehensive drift report comparing production to training.
    Runs daily or after significant data volume accumulates.
    """
    
    report = Report(metrics=[
        DataDriftPreset(),            # All features for drift
        TargetDriftPreset(),           # Target/prediction distribution
        DatasetDriftMetric(           # Summary: is the dataset drifting?
            stattest="psi",           # Use PSI as the primary test
            stattest_threshold=0.2    # PSI > 0.2 = drift detected
        ),
        # Per-feature drift for critical features
        ColumnDriftMetric(column_name="user_transaction_count_30d", stattest="psi"),
        ColumnDriftMetric(column_name="transaction_amount", stattest="ks"),
        ColumnDriftMetric(column_name="merchant_category", stattest="chisquare"),
    ])
    
    report.run(reference_data=reference_data, current_data=current_data)
    
    # Save HTML report for human review
    report.save_html(f"{output_path}/drift_report_{datetime.now().strftime('%Y%m%d')}.html")
    
    # Extract JSON metrics for automated alerting
    metrics_json = report.as_dict()
    
    dataset_drift = metrics_json["metrics"][2]["result"]
    drift_detected = dataset_drift["dataset_drift"]
    drift_share = dataset_drift["share_of_drifted_columns"]
    
    return DriftResult(
        drift_detected=drift_detected,
        drift_share=drift_share,
        drifted_features=dataset_drift.get("number_of_drifted_columns", 0)
    )
```

---

## The Retraining Trigger Escalation Ladder

Not all drift warrants the same response. The escalation ladder prevents both under-reaction (missing significant drift) and over-reaction (triggering retraining on noise):

```python
# drift_escalation.py

def handle_drift_result(drift_result: DriftResult, model_name: str):
    """
    Escalation ladder: respond proportionally to drift severity.
    """
    
    psi = drift_result.psi
    drift_share = drift_result.drift_share
    
    if psi < 0.1 and drift_share < 0.1:
        # Level 0: No significant drift — log and continue
        log_metric("model_psi", psi, model=model_name)
        return
    
    if 0.1 <= psi < 0.15 or (0.1 <= drift_share < 0.2):
        # Level 1: Moderate drift — alert the ML team for investigation
        notify_slack(
            channel="#ml-monitoring",
            message=f"⚠️ Moderate drift detected for {model_name}. "
                    f"PSI: {psi:.3f}, drifted features: {drift_share:.0%}. "
                    f"Investigate before next scheduled retrain."
        )
        return
    
    if 0.15 <= psi < 0.25 or (0.2 <= drift_share < 0.4):
        # Level 2: Significant drift — trigger automated retrain
        notify_slack(
            channel="#ml-monitoring",
            message=f"🔄 Significant drift detected for {model_name}. "
                    f"PSI: {psi:.3f}. Automated retraining triggered."
        )
        trigger_retraining(model_name, reason="data_drift", psi=psi)
        return
    
    if psi >= 0.25 or drift_share >= 0.4:
        # Level 3: Severe drift — trigger retrain AND alert leadership
        # COVID-level shift: automated response is insufficient
        notify_pagerduty(
            title=f"SEVERE DATA DRIFT: {model_name}",
            body=f"PSI: {psi:.3f}, {drift_share:.0%} of features drifted. "
                 f"Model predictions may be unreliable. "
                 f"Automated retraining triggered — manual review required."
        )
        trigger_retraining(model_name, reason="severe_drift", psi=psi)
        # Also consider: switch to fallback heuristic while model retrains
        enable_fallback_heuristic(model_name)
        return
```

---

## Covariate vs. Concept Drift Detection

The COVID example is concept drift, not covariate shift. The inputs (transaction patterns) changed AND the correct outputs (accurate forecasts) changed. Pure covariate shift detection (monitoring input distributions) would have detected the input distribution change, but wouldn't tell you whether the output relationship also changed.

For concept drift detection, you need label feedback — actual outcomes flowing back to compare against predictions:

```python
def detect_concept_drift(
    model_name: str,
    prediction_window_days: int = 7,
    min_labeled_samples: int = 1000
) -> ConceptDriftResult:
    """
    Detect concept drift using prediction vs. actual outcome comparison.
    Requires ground truth labels to flow back (may have latency for some tasks).
    """
    
    # Get predictions made in the past prediction_window_days
    # that now have actual outcomes available
    predictions_with_outcomes = load_predictions_with_outcomes(
        model_name=model_name,
        days=prediction_window_days
    )
    
    if len(predictions_with_outcomes) < min_labeled_samples:
        return ConceptDriftResult(inconclusive=True, reason="insufficient_labeled_data")
    
    # Compare accuracy in recent window to training baseline
    recent_accuracy = compute_accuracy(predictions_with_outcomes)
    baseline_accuracy = get_training_baseline_accuracy(model_name)
    
    degradation_pct = (baseline_accuracy - recent_accuracy) / baseline_accuracy * 100
    
    if degradation_pct > 10:  # >10% accuracy degradation
        return ConceptDriftResult(
            drift_detected=True,
            type="concept_drift",
            degradation_pct=degradation_pct
        )
    
    return ConceptDriftResult(drift_detected=False)
```

---

## Anti-Patterns

### ❌ Anti-Pattern: Monitoring Only Aggregate Drift

**What it looks like:** Computing PSI on the overall feature matrix. Missing that a single critical feature (e.g., `merchant_category_code = '5999'` — "Misc. Retail") has shifted dramatically while the overall PSI looks fine.

**The fix:** Per-feature drift metrics for the top-N most important features (from feature importance analysis). Aggregate drift can hide critical feature-level shifts.

---

### ❌ Anti-Pattern: No Fallback for Severe Drift

**What it looks like:** Severe drift triggers automated retraining. Retraining takes 4 hours. During those 4 hours, the degraded model continues serving predictions.

**What breaks:** Business decisions based on unreliable model predictions for 4 hours.

**The fix:** For models with severe drift, have a fallback heuristic (simple rule-based model or moving average) that activates immediately while the ML model retrains. The heuristic is less accurate but more robust to distribution shifts.

---

## Field Notes

💀 **No drift monitoring → 43-day detection lag** → $4.2M inventory impact → PSI monitoring on critical features, daily reports. Level 3 drift triggers PagerDuty immediately.

💀 **Automated retrain triggered on noisy daily data** → Constant retraining, unstable production models → Use 7-day rolling window for drift detection. Single-day anomalies are noise.

---

## Chapter Summary

Data drift detection is the monitoring system that connects the real world's changes to the model retraining pipeline. PSI and KS tests on input distributions detect covariate shift. Performance monitoring on labeled outcomes detects concept drift. The escalation ladder prevents over-reaction to noise and under-reaction to genuine distribution shifts. COVID showed the difference between organizations with drift monitoring (4-day detection) and those without (43-day detection). The gap is infrastructure, not intelligence.

[→ Next: Chapter 40 — The GPU/Accelerator-Aware CI/CD Pattern](./chapter-40-gpu-accelerator-cicd.md)

---
*[← Previous: Chapter 38 — The ML Pipeline Orchestration & Model Registry Pattern](./chapter-38-ml-pipeline-orchestration.md) |
[→ Next: Chapter 40 — The GPU/Accelerator-Aware CI/CD Pattern](./chapter-40-gpu-accelerator-cicd.md)*
