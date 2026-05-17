# Chapter 59: The Carbon-Aware & Energy-Routed Deployment Pattern
*Part XI: Beyond Hyperscale — The Absolute Frontier*

> *"The data center that ran your model training last night
> was drawing from a grid with 820g CO₂/kWh.
> The grid 200 miles away had 42g CO₂/kWh at the same time.
> You didn't move the workload. You didn't know to.
> Carbon-aware scheduling means having that information
> and making the right routing decision automatically."*
> — Green Software Foundation, paraphrased

---

## The Physics Behind the Pattern

Electrical grids are not uniformly green. The carbon intensity of electricity — measured in grams of CO₂ equivalent per kilowatt-hour (gCO₂eq/kWh) — varies:

- **Geographically**: The US West Coast (heavy hydroelectric and wind) runs at 200–300 gCO₂eq/kWh. The US Midwest (coal-heavy grid) runs at 600–700 gCO₂eq/kWh. The differential is 3×.
- **Temporally**: On any given grid, carbon intensity varies by time of day. Solar-heavy grids are cleanest at noon; wind-heavy grids are cleanest during windy periods. A single grid can vary 3–5× across a 24-hour period.
- **Marginally**: The marginal carbon intensity (the carbon cost of the *next* kilowatt-hour consumed) differs from the average. When you add load to a grid, the grid brings online its most expensive (usually most carbon-intensive) generators first. Marginal intensity is what actually matters for decisions about whether to run a workload now.

Real numbers from WattTime data (publicly accessible at watttime.org):

```
US-NE (New England), 2024-03-15:
  3 AM UTC: 180 gCO₂eq/kWh (wind dominant)
  2 PM UTC: 420 gCO₂eq/kWh (peak demand, gas plants online)
  Differential: 2.3×

CAISO (California ISO), 2024-03-15:
  4 AM UTC: 160 gCO₂eq/kWh
  8 AM UTC: 310 gCO₂eq/kWh (before solar ramps up)
  12 PM UTC: 90 gCO₂eq/kWh (solar peak)
  Differential: 3.4×
```

For compute-intensive workloads (ML training, large Docker builds, batch processing), the carbon cost of running at peak-intensity time vs. low-intensity time — or in a coal-heavy region vs. a hydro-heavy region — is material. A 100 GPU-hour training job at 800 gCO₂eq/kWh emits 80kg of CO₂. The same job at 80 gCO₂eq/kWh emits 8kg. A 10× reduction in carbon, same work, same cost.

---

## The WattTime API

WattTime provides real-time and forecast marginal carbon intensity data for electrical grids globally. Their API is used by Google, Microsoft, and the Green Software Foundation's Carbon-Aware SDK.

```python
# carbon_intensity.py — real-time carbon intensity via WattTime API

import requests
import os
from dataclasses import dataclass
from datetime import datetime, timedelta

@dataclass
class CarbonIntensityForecast:
    region: str
    point_time: datetime
    value: float       # gCO₂eq/kWh (marginal)
    frequency: int     # Seconds between forecasts
    rating: str        # "best", "ok", "high"

def get_watttime_token() -> str:
    """Authenticate with WattTime API and get a bearer token."""
    resp = requests.get(
        "https://api2.watttime.org/v2/login",
        auth=(os.environ["WATTTIME_USER"], os.environ["WATTTIME_PASSWORD"])
    )
    resp.raise_for_status()
    return resp.json()["token"]

def get_current_carbon_intensity(region: str, token: str) -> float:
    """Get current marginal carbon intensity for a grid region."""
    resp = requests.get(
        "https://api2.watttime.org/v2/index",
        headers={"Authorization": f"Bearer {token}"},
        params={"ba": region}  # ba = balancing authority (e.g., "CAISO", "MISO", "PJM")
    )
    resp.raise_for_status()
    data = resp.json()
    return data["moer"]  # Marginal Operating Emissions Rate (gCO₂eq/kWh)

def get_carbon_forecast(region: str, token: str, hours: int = 24) -> list[CarbonIntensityForecast]:
    """Get carbon intensity forecast for the next N hours."""
    resp = requests.get(
        "https://api2.watttime.org/v2/forecast",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "ba": region,
            "starttime": datetime.utcnow().isoformat(),
            "endtime": (datetime.utcnow() + timedelta(hours=hours)).isoformat()
        }
    )
    resp.raise_for_status()
    return [
        CarbonIntensityForecast(
            region=region,
            point_time=datetime.fromisoformat(p["point_time"]),
            value=p["value"],
            frequency=p["frequency"],
            rating="best" if p["value"] < 200 else ("ok" if p["value"] < 400 else "high")
        )
        for p in resp.json()["forecast"]
    ]

def find_optimal_execution_window(
    region: str,
    duration_hours: float,
    deadline: datetime,
    token: str,
    max_carbon_threshold: float = 300.0  # gCO₂eq/kWh
) -> datetime:
    """
    Find the lowest-carbon window to run a workload within the deadline.
    
    Returns the start time that minimizes average carbon intensity
    while completing before the deadline.
    """
    forecast = get_carbon_forecast(region, token, hours=int((deadline - datetime.utcnow()).total_seconds() / 3600))
    
    # Calculate average carbon intensity for each possible start window
    # (rolling average over the workload duration)
    window_size = int(duration_hours * 3600 / forecast[0].frequency)
    
    best_start = None
    best_avg_carbon = float('inf')
    
    for i in range(len(forecast) - window_size):
        window = forecast[i:i + window_size]
        avg_carbon = sum(p.value for p in window) / len(window)
        
        # Check if this window fits within the deadline
        window_end = window[-1].point_time
        if window_end > deadline:
            break
        
        if avg_carbon < best_avg_carbon:
            best_avg_carbon = avg_carbon
            best_start = window[0].point_time
    
    return best_start
```

---

## The Green Software Foundation Carbon-Aware SDK

The Green Software Foundation (GSF) provides an open-source SDK that abstracts over multiple carbon intensity data providers (WattTime, ElectricityMaps, etc.) and provides a unified API for carbon-aware workload scheduling:

```python
# carbon_aware_scheduler.py using GSF Carbon-Aware SDK

from carbonawareness import CarbonAwarenessClient

client = CarbonAwarenessClient(api_url="https://carbon-aware-api.example.com")

async def get_best_region_for_training_job(
    candidate_regions: list[str],
    job_duration_minutes: int
) -> str:
    """
    Given candidate regions and job duration, return the region
    with the lowest forecast carbon intensity for that window.
    
    Used to decide where to launch a training job.
    """
    
    # Get current emissions for all candidate regions
    emissions = await client.get_current_emissions_data(candidate_regions)
    
    # Sort by carbon intensity (lowest first)
    sorted_regions = sorted(
        emissions,
        key=lambda e: e.rating  # GSF provides a normalized rating
    )
    
    best = sorted_regions[0]
    print(f"Best region: {best.location} ({best.rating:.1f} gCO₂eq/kWh)")
    
    return best.location


async def schedule_batch_build(
    build_duration_hours: float,
    hard_deadline: datetime,
    preferred_region: str = "us-east-1"
) -> datetime:
    """
    Schedule a batch CI build for the lowest-carbon window before the deadline.
    
    Used for scheduled/nightly builds where timing is flexible.
    Not appropriate for PR CI (which needs fast feedback).
    """
    
    best_window = await client.get_best_execution_time(
        location=preferred_region,
        duration=timedelta(hours=build_duration_hours),
        window_start=datetime.utcnow(),
        window_end=hard_deadline
    )
    
    carbon_savings = calculate_carbon_savings(
        baseline_carbon=get_current_carbon(preferred_region),
        optimized_carbon=best_window.optimal_carbon_intensity,
        duration_hours=build_duration_hours,
        compute_power_watts=2000  # Estimate for the build cluster
    )
    
    print(f"Scheduling build at {best_window.execution_time}")
    print(f"Estimated carbon savings: {carbon_savings:.1f} kg CO₂")
    
    return best_window.execution_time
```

---

## Two Strategies: Temporal vs. Spatial Shifting

**Temporal shifting (time-based)**: Run the workload during the lowest-carbon hours of the day in a fixed region. Best for: nightly builds, scheduled training jobs, batch processing.

**Spatial shifting (geography-based)**: Run the workload in the lowest-carbon region. Best for: deployments where multi-region infrastructure exists, training jobs that can run in any region.

```python
# Integrating carbon-awareness into the CI/CD pipeline

def schedule_ci_job(job_type: str, config: dict) -> CIJobSchedule:
    """
    Determine when and where to run a CI job based on its type
    and carbon constraints.
    """
    
    if job_type == "pr_ci":
        # PR CI: latency matters more than carbon. Run immediately.
        return CIJobSchedule(
            run_immediately=True,
            region=config["preferred_region"],
            carbon_optimized=False
        )
    
    elif job_type == "nightly_build":
        # Nightly builds: flexible timing, run during lowest-carbon window.
        # Constraint: must complete before 7 AM UTC (engineers arrive).
        token = get_watttime_token()
        optimal_start = find_optimal_execution_window(
            region=aws_region_to_grid_region(config["region"]),
            duration_hours=config["estimated_duration_hours"],
            deadline=next_7am_utc(),
            token=token
        )
        return CIJobSchedule(
            scheduled_at=optimal_start,
            region=config["region"],
            carbon_optimized=True
        )
    
    elif job_type == "ml_training":
        # Training jobs: run in lowest-carbon region within compute constraints.
        token = get_watttime_token()
        best_region = get_lowest_carbon_region(
            candidates=["us-east-1", "us-west-2", "eu-west-1"],
            duration_hours=config["estimated_duration_hours"],
            token=token
        )
        return CIJobSchedule(
            run_immediately=True,  # Training can start now, just in best region
            region=best_region,
            carbon_optimized=True
        )
```

---

## When Carbon Awareness Conflicts with SLOs

Carbon-aware scheduling creates potential conflicts with deployment SLOs:

**Conflict 1**: A security patch needs to deploy immediately. The current carbon intensity is high. Delay the patch for carbon reasons?
**Resolution**: Security patches and SLO-breaking incidents always override carbon optimization. Carbon-aware scheduling applies only to workloads with timing flexibility.

**Conflict 2**: A nightly build scheduled for low-carbon 3 AM window, but an engineer needs the build artifacts by 2 AM for a release.
**Resolution**: Carbon optimization applies within defined deadline constraints. The deadline is the hard constraint; carbon is optimized within it.

**Conflict 3**: The lowest-carbon region has higher latency for users.
**Resolution**: For CI/CD workloads (builds, training), region latency doesn't affect users. For production deployments, deploy to the geographically appropriate region for users regardless of carbon.

---

## The ESG Business Case

For engineering organizations subject to ESG (Environmental, Social, Governance) reporting requirements — increasingly common for public companies — the carbon intensity of cloud compute is a Scope 3 emissions category that must be tracked and reduced.

The practical implication: the sustainability team needs the carbon emissions data; engineering can provide it if they've instrumented the pipeline with carbon intensity tracking. Carbon-aware scheduling is both a direct emissions reduction and an emissions tracking improvement.

---

## Anti-Patterns

### ❌ Carbon-Optimizing PR CI

Telling a developer their PR CI is delayed 4 hours to run during a lower-carbon window is a productivity tax that will immediately be overridden. Carbon optimization applies to workloads with timing flexibility, not to the feedback loops that developers depend on for iteration speed.

### ❌ Spatial Shifting Without Data Residency Compliance

The lowest-carbon region may not be an approved region for your data. GDPR, HIPAA, and financial regulations may constrain which regions can process specific data. Carbon optimization is subject to compliance constraints, not an override for them.

---

## Chapter Summary

Carbon-aware deployment is the scheduling dimension that minimizes the environmental cost of compute without reducing its effectiveness. For the class of workloads with timing flexibility — nightly builds, ML training, batch processing — temporal and spatial shifting can reduce carbon emissions by 50–90% at zero impact to delivery quality. The infrastructure (WattTime API, Green Software Foundation SDK) is production-ready today. The primary barrier is the engineering investment to integrate it into scheduling systems and the organizational prioritization to make it a pipeline requirement.

[→ Next: Chapter 60 — The TrueTime & Distributed Clock Rollout Pattern](./chapter-60-truetime-distributed-clock.md)

---
*[← Previous: Chapter 58 — The Formally Verified Release Pattern](./chapter-58-formally-verified-release.md) |
[→ Next: Chapter 60 — The TrueTime & Distributed Clock Rollout Pattern](./chapter-60-truetime-distributed-clock.md)*
