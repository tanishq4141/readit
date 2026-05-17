# Chapter 33: The Continuous Training (CT) Trigger Pattern
*Part VII: MLOps, AI & Continuous Training (CT)*

> *"The model was trained in October. It's now January.
> Our fraud detection precision is 71%. It was 94% in October.
> We lost $2.3 million to fraudsters whose patterns emerged in November.
> The model didn't change. The world did. We weren't watching."*
> — ML engineering lead, quarterly review, 2022

---

## The War Story

The fraud detection team at Veritas Bank deploys their gradient boosting model in October. It achieves 94% precision and 89% recall on the October test set. The model is deployed to production. It processes 800,000 transactions per day.

Nobody sets up automated retraining. The plan is to retrain "quarterly." There is no trigger, no monitoring, no alert on model performance degradation. The retrain is a calendar event.

In November, a new fraud ring emerges: card-not-present fraud using synthetic identity profiles with specific behavioral patterns — micro-transactions followed by a large withdrawal within 36 hours. The training data from September and earlier has essentially zero examples of this pattern. The model has never seen it.

By December, the fraud ring accounts for 12% of fraud attempts. The model catches 8% of them. By January, the precision has dropped to 71% on the full fraud dataset because the model is correctly classifying the old patterns but missing the new ones. 71% precision means 29% of flagged transactions are false positives — legitimate transactions being blocked. The fraud team is drowning in false positive reviews while the real fraud goes through.

At the quarterly review in January, the engineering team pulls the metrics and sees the degradation. They retrain. The new model achieves 93% precision and 91% recall within a week. But the damage — $2.3 million in fraudulent transactions that the retrained model would have caught — is done.

The fix is not retraining faster. The fix is triggering retraining automatically when performance degrades below a threshold, rather than waiting for a quarterly review that nobody accelerates even when the world is changing.

---

## What You'll Learn

- The four CT trigger types: schedule, data arrival, performance degradation, and data drift
- Implementing CT pipelines in Kubeflow Pipelines, Vertex AI Pipelines, and SageMaker Pipelines
- Training pipeline idempotency: ensuring the same trigger produces the same model
- CT as a first-class CI/CD event: integrating model training into the deployment pipeline
- The monitoring infrastructure required to support performance-degradation triggers
- Governance: who approves automated model deployment from a CT run?

---

## The Four CT Trigger Types

### Trigger 1: Scheduled Retraining

The simplest trigger: retrain on a fixed schedule (daily, weekly, monthly). The model is retrained whether or not performance has degraded, ensuring it always has recent training data.

```python
# Kubeflow Pipelines: scheduled CT pipeline

from kfp import dsl
from kfp.components import load_component_from_text

@dsl.pipeline(
    name="fraud-detection-retraining",
    description="Periodic retraining of the fraud detection model"
)
def fraud_retraining_pipeline(
    training_data_path: str,
    model_output_path: str,
    eval_data_path: str,
    champion_model_path: str,
):
    # Step 1: Validate training data quality
    data_validation_op = data_validation_component(
        data_path=training_data_path,
        min_rows=100_000,           # Fail pipeline if too little data
        max_null_rate=0.05,         # Fail if >5% nulls in critical columns
        schema_path="schema/fraud_features.yaml"
    )
    
    # Step 2: Train the challenger model
    training_op = training_component(
        training_data=data_validation_op.outputs["validated_data"],
        hyperparams={
            "n_estimators": 500,
            "max_depth": 8,
            "learning_rate": 0.05
        }
    ).set_gpu_limit(1)  # Request 1 GPU for training
    
    # Step 3: Evaluate challenger against champion (Champion/Challenger pattern)
    evaluation_op = evaluation_component(
        challenger_model=training_op.outputs["model"],
        champion_model=champion_model_path,
        eval_data=eval_data_path,
        # Fail the pipeline if challenger doesn't beat champion
        min_improvement_precision=0.005,  # Must be 0.5% better in precision
        min_improvement_recall=0.002
    )
    
    # Step 4: Register the model if it beats the champion
    register_op = model_registry_component(
        model=training_op.outputs["model"],
        evaluation_results=evaluation_op.outputs["results"],
        model_name="fraud-detection",
        stage="staging"
    ).after(evaluation_op)
```

```python
# Schedule the pipeline to run weekly on Vertex AI
from google.cloud import aiplatform
from google.cloud.aiplatform import PipelineJob

pipeline_job = PipelineJob(
    display_name="fraud-detection-weekly-retrain",
    template_path="fraud_retraining_pipeline.yaml",
    parameter_values={
        "training_data_path": "gs://mycompany-ml-data/fraud/training/latest/",
        "model_output_path": "gs://mycompany-ml-artifacts/fraud/",
        "eval_data_path": "gs://mycompany-ml-data/fraud/eval/",
        "champion_model_path": "gs://mycompany-ml-artifacts/fraud/champion/"
    }
)

# Create a schedule: run every Sunday at 2 AM UTC
pipeline_job.create_schedule(
    display_name="fraud-detection-weekly",
    cron="0 2 * * 0",  # Every Sunday at 2 AM
    max_concurrent_run_count=1,  # Never run two trainings simultaneously
    max_run_count=None  # Run indefinitely
)
```

### Trigger 2: Upstream Data Pipeline Completion

Retrain when new data becomes available, rather than on a fixed schedule. This aligns training with data freshness:

```python
# Airflow DAG: trigger CT when data pipeline completes

from airflow import DAG
from airflow.sensors.external_task import ExternalTaskSensor
from airflow.operators.python import PythonOperator
from datetime import datetime

with DAG(
    dag_id="ct_trigger_on_data_arrival",
    start_date=datetime(2024, 1, 1),
    schedule_interval="@daily"
) as dag:
    
    # Wait for the upstream data pipeline to complete successfully
    wait_for_feature_pipeline = ExternalTaskSensor(
        task_id="wait_for_feature_pipeline",
        external_dag_id="fraud_feature_engineering",
        external_task_id="write_training_features",
        # Wait up to 4 hours for the upstream pipeline
        execution_delta=timedelta(hours=0),
        timeout=14400,
        poke_interval=300  # Check every 5 minutes
    )
    
    # Check if enough new data has arrived to justify retraining
    check_data_volume = PythonOperator(
        task_id="check_data_volume",
        python_callable=lambda: check_new_rows_since_last_train(
            table="fraud_features",
            min_new_rows=50_000  # Only retrain if 50k+ new rows available
        )
    )
    
    # Trigger Kubeflow Pipeline run
    trigger_training = PythonOperator(
        task_id="trigger_training_pipeline",
        python_callable=trigger_kubeflow_pipeline,
    )
    
    wait_for_feature_pipeline >> check_data_volume >> trigger_training
```

### Trigger 3: Performance Degradation

The trigger type that would have saved Veritas Bank: retrain when model performance drops below a threshold:

```python
# performance_monitor.py — runs hourly, triggers CT if performance degrades

import mlflow
from prometheus_client import Gauge

PRECISION_GAUGE = Gauge('fraud_model_precision', 'Current model precision')
RECALL_GAUGE = Gauge('fraud_model_recall', 'Current model recall')

def check_and_trigger(
    model_name: str,
    precision_threshold: float = 0.88,  # Alert if precision drops below 88%
    recall_threshold: float = 0.85,
    window_hours: int = 24
):
    """Check model performance metrics and trigger retraining if below threshold."""
    
    # Get current precision and recall from the prediction outcome table
    # (requires that actual fraud labels flow back from the fraud investigation team)
    current_metrics = compute_metrics_from_outcomes(
        model_name=model_name,
        hours=window_hours
    )
    
    PRECISION_GAUGE.set(current_metrics.precision)
    RECALL_GAUGE.set(current_metrics.recall)
    
    if current_metrics.precision < precision_threshold:
        trigger_retraining(
            reason="precision_degradation",
            current_precision=current_metrics.precision,
            threshold=precision_threshold
        )
    
    if current_metrics.recall < recall_threshold:
        trigger_retraining(
            reason="recall_degradation",
            current_recall=current_metrics.recall,
            threshold=recall_threshold
        )

def trigger_retraining(reason: str, **context):
    """Trigger a Kubeflow pipeline run for model retraining."""
    
    # Check: has a retraining already been triggered recently?
    # Prevent multiple triggers from firing simultaneously
    if retraining_in_progress(model_name="fraud-detection"):
        print("Retraining already in progress. Skipping duplicate trigger.")
        return
    
    print(f"Triggering retraining. Reason: {reason}. Context: {context}")
    
    # Fire the training pipeline
    run = client.create_run_from_pipeline_func(
        fraud_retraining_pipeline,
        arguments={"trigger_reason": reason, **context},
        run_name=f"auto-retrain-{reason}-{datetime.now().strftime('%Y%m%d-%H%M')}"
    )
    
    # Notify the ML team
    notify_slack(
        channel="#ml-ops",
        message=f"🔄 Automatic retraining triggered for fraud-detection\nReason: {reason}\nContext: {context}"
    )
```

### Trigger 4: Data Drift

Trigger retraining when the distribution of input features shifts significantly from the training distribution. Chapter 39 covers drift detection in full depth; here the integration point is the trigger:

```python
# drift_triggered_retraining.py
def on_drift_detected(feature: str, drift_score: float, p_value: float):
    """Callback invoked by the drift detection system when drift is detected."""
    
    if p_value < 0.01 and drift_score > 0.2:  # Statistically significant drift
        trigger_retraining(
            reason="data_drift",
            drifted_feature=feature,
            drift_score=drift_score,
            p_value=p_value
        )
```

---

## Training Pipeline Idempotency

A CT trigger should produce the same model for the same data and hyperparameters, regardless of when it runs or how many times it's triggered. This is ML's version of the hermetic build principle.

```python
# training_component.py — idempotent training with artifact deduplication

def train_model(training_data_hash: str, hyperparams: dict) -> str:
    """
    Idempotent training: return existing model if same data+hyperparams were used before.
    
    The model artifact is content-addressed by the hash of its inputs.
    Same data + same hyperparams → same model. Return cached version.
    """
    
    run_key = compute_run_key(training_data_hash, hyperparams)
    
    # Check if we already have a model trained with these exact inputs
    existing_run = mlflow.search_runs(
        filter_string=f"tags.run_key = '{run_key}' AND status = 'FINISHED'",
        order_by=["start_time DESC"],
        max_results=1
    )
    
    if not existing_run.empty:
        print(f"Found existing run with same inputs. Returning cached model: {run_key}")
        return existing_run.iloc[0]["artifact_uri"]
    
    # Train a new model
    with mlflow.start_run(tags={"run_key": run_key}) as run:
        model = train(training_data_hash, hyperparams)
        mlflow.sklearn.log_model(model, "model")
        mlflow.log_params(hyperparams)
        mlflow.set_tag("training_data_hash", training_data_hash)
        return run.info.artifact_uri
```

---

## The Governance Question

Automated CT raises an important question: if a triggered retraining produces a new model that beats the champion, does it automatically deploy to production?

The answer depends on the risk profile of the model:

| Model Type | Auto-deploy? | Governance |
|---|---|---|
| Recommendation engine | Yes (with canary) | Automated if challenger improves metric by ≥1% |
| Fraud detection | Human review | ML team reviews before production promotion |
| Credit scoring | Required review | Risk team + model risk management must approve |
| Medical diagnosis | Regulatory gate | FDA/CE validation before any production use |

For fraud detection (the Veritas case), automated retraining should produce a staging model automatically, with human review before production promotion. The automated trigger saves time; the human review maintains accountability.

---

## Anti-Patterns

### ❌ Anti-Pattern: Retrain Without Comparing to Champion

**What it looks like:** Automated retraining deploys the new model regardless of whether it's better than the current production model.

**What breaks:** A retrained model on degraded data (data quality issue in the training pipeline) deploys and makes the production model worse.

**The fix:** Champion/Challenger evaluation (Chapter 35) is a required gate in every CT pipeline.

---

### ❌ Anti-Pattern: No Label Feedback Loop

**What it looks like:** The model scores transactions but the outcomes (was it actually fraud?) never flow back into the training data. The model is retrained on the same stale data forever.

**What breaks:** Retraining doesn't improve the model because the new training data doesn't contain the new fraud patterns.

**The fix:** Build a label feedback pipeline that ingests fraud investigation outcomes and appends them to the training dataset. The CT trigger is only valuable if the retraining data includes recent ground truth.

---

## Field Notes

💀 **"We retrain quarterly"** → $2.3M fraud loss in November–January → Performance-degradation triggers with real-time label feedback. Quarterly retraining is a policy, not a monitoring system.

💀 **CT pipeline triggered multiple times simultaneously** → Multiple conflicting training runs, corrupted model registry → Add idempotency checks and "retraining in progress" locks before triggering.

---

## Chapter Summary

Continuous Training is not a feature — it's the acknowledgment that deployed ML models have a decay rate. The world changes. The model's training distribution becomes stale. The trigger mechanism determines how quickly the pipeline responds. Scheduled triggers are simple but lag behind reality. Performance degradation triggers close the feedback loop automatically but require real-time label ingestion. Data drift triggers (Chapter 39) close the loop earlier — before performance degrades visibly. The right answer is usually a combination: drift detection as the early warning, performance thresholds as the hard gate.
