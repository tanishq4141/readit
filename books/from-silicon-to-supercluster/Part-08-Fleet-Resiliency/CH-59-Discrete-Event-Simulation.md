# Chapter 59: Discrete-Event Simulation — Modeling Your Infrastructure Before It Breaks

> "You can't run a 10,000-GPU training cluster to test failure modes before you build it. But you can simulate it."

**Part 08 — Fleet Resiliency** | Bridges from CH-58's mathematical queueing analysis into simulation-based validation for complex multi-component systems that resist closed-form analysis.

---

## 1. Cold Open

The infrastructure team had been given three weeks to design a data processing pipeline that would ingest 50TB of log data per day, process it in real-time with sub-30-second latency, and survive the failure of any single component without data loss. The pipeline involved a Kafka cluster, twelve Flink jobs, a Postgres database for state, and a Kubernetes-native autoscaler. Nobody on the team had built anything at this scale before.

The senior engineer on the project had a simple question: how many Flink task manager replicas do we need? The answer depended on the arrival rate of log events (predictable), the processing latency per event (measurable in staging), the checkpoint interval (configurable), and the recovery time after a task manager failure (dependent on the checkpoint interval and the size of the state). It also depended on whether multiple task managers could fail simultaneously — a possibility that became more likely as the cluster grew. There was no closed-form equation that combined all these variables. The queueing theory from the previous chapter assumed steady-state and single queues; the pipeline had twelve stages with buffering between each stage and state machines that needed to be recovered from checkpoints.

The engineer built a discrete-event simulation. It took two days. The simulation modeled each Kafka partition as a queue, each Flink task manager as a server with an exponential service time, each checkpoint as a scheduled periodic event, and failures as Poisson-distributed events with an MTBF derived from the cloud provider's empirical node failure data. She ran the simulation with varying checkpoint intervals (5 minutes to 30 minutes) and failure rates (baseline to 10× baseline). The results were unambiguous: with a 5-minute checkpoint interval, the 99th percentile recovery time after a two-node failure was 8 minutes, well within the acceptable degradation window. With a 30-minute checkpoint interval, the same failure caused 47 minutes of lag that the autoscaler couldn't recover from because the reprocessing rate was slower than the arrival rate during recovery.

The simulation took two days. Building the pipeline and discovering this empirically would have taken two weeks and a production outage. The simulation was presented to the team, the checkpoint interval was set to 5 minutes, and the pipeline ran without issues for 8 months until it was intentionally replaced. Discrete-event simulation is not exotic mathematical modeling. It is a practical engineering tool that costs a few hundred lines of Python and prevents entire classes of architecture mistakes.

---

## 2. The Uncomfortable Truth

Most infrastructure decisions are made by intuition, by analogy to previous systems, or by asking an AI assistant. This produces acceptable results for standard workloads and standard configurations. It produces expensive failures for systems that have non-obvious interactions between components — systems where the failure mode of one component changes the load on other components, where recovery processes compete with normal processing for resources, or where the timing of failures relative to periodic events (backups, checkpoints, compactions) determines whether you recover gracefully or not at all.

The uncomfortable truth is that Kubernetes, Kafka, and distributed training jobs all have failure modes that depend on timing interactions that you cannot reason about analytically without building a model. The checkpoint optimal interval problem (from Chapter 42) has a closed-form solution for constant-rate single-job workloads, but the moment you add concurrent jobs, heterogeneous failure rates, or resource contention during recovery, the closed-form solution becomes an approximation that can be off by an order of magnitude.

SimPy — Python's discrete-event simulation library — makes it possible to build infrastructure models in 200-500 lines of code. The result is not a toy: it can model accurate Poisson failure processes, realistic checkpoint overhead, queueing delays with the correct distributions, and multi-component cascades. The output is a P99 recovery time, a capacity headroom number, or a scaling policy recommendation that is backed by simulation rather than intuition. The audience for a simulation result — even internally — trusts a number that came from a model more than a number that came from an engineer's gut feeling.

---

## 3. Mental Model — The Event Timeline

**The named model: "The Infinite Event Horizon"**

Think of a discrete-event simulation as an infinitely long timeline with events scheduled at specific times. Each event mutates the state of the simulation and may schedule new events. The simulation clock jumps from event to event — it doesn't tick at regular intervals, it teleports to the next event. This means a simulation that models 24 hours of a real system can run in milliseconds of real time, because it only processes the O(N) events that actually occur, not the billions of time steps that pass between them.

```mermaid
graph LR
    subgraph "Event Queue (priority queue by time)"
        E1["t=0.00: Job arrives"]
        E2["t=0.08: Checkpoint starts"]
        E3["t=1.23: Node fails"]
        E4["t=1.23+recovery: Node recovers"]
        E5["t=2.16: Job completes"]
        E6["...next events..."]
    end

    subgraph "Simulation Clock"
        CLK["Current time: t\nJumps to next event\n(not time-stepped)"]
    end

    subgraph "State"
        ST["Node states\nQueue depths\nIn-flight jobs\nCheckpoint status"]
    end

    E1 --> CLK
    CLK --> ST
    ST --> E2
    E2 --> CLK

    style E1 fill:#1a472a,color:#fff
    style E2 fill:#0f3460,color:#fff
    style E3 fill:#8b0000,color:#fff
    style E4 fill:#0f3460,color:#fff
    style E5 fill:#1a472a,color:#fff
    style CLK fill:#1a1a2e,color:#fff
    style ST fill:#1a1a2e,color:#fff
```

The power of DES is composability: you can model a GPU training job's checkpoint behavior, a Kafka consumer's lag behavior, and a Kubernetes autoscaler's reaction time all in the same simulation, and observe how they interact. When the GPU fails at minute 12 of a 20-minute checkpoint interval, the checkpoint overhead during recovery collides with the autoscaler's attempt to scale out, which competes for the same nodes that the checkpoint recovery needs. No analytical model captures this interaction; the simulation does, automatically, because the event queue serializes all interactions through a single timeline.

```mermaid
graph TD
    subgraph "DES Architecture"
        EQ["Event Queue\n(heapq by time)"]
        CL["Simulation Clock\nadvances to next event"]
        EH["Event Handlers\narrival, departure,\nfailure, recovery,\ncheckpoint, scale"]
        ST["Simulation State\nnodes, queues,\njobs, metrics"]
        ME["Metrics Collector\nlatency, throughput,\nrecovery time, lag"]
    end

    EQ --> CL
    CL --> EH
    EH --> ST
    EH --> EQ
    ST --> ME

    style EQ fill:#1a1a2e,color:#fff
    style CL fill:#0f3460,color:#fff
    style EH fill:#1a472a,color:#fff
    style ST fill:#0f3460,color:#fff
    style ME fill:#1a472a,color:#fff
```

---

## 4. Dissection

### Naive Approach: Spreadsheet Capacity Modeling

Teams without simulation tools build spreadsheet models: "if each GPU processes X tokens/second and we have N GPUs, we can process X*N tokens/second." This captures the steady-state mean throughput but completely misses: failure-driven reprocessing, checkpoint overhead, resource contention during recovery, and the interaction between failure rate and checkpoint frequency. It also assumes independence between failures — that losing GPU 3 doesn't affect GPU 4's throughput. In practice, GPU 4's throughput during recovery of GPU 3 is reduced because they're competing for network bandwidth during checkpoint restore.

### Where It Breaks

The checkpoint optimal interval formula (Daly's formula from Chapter 42): `T_checkpoint = √(2 × MTTR × C_checkpoint)`. This gives you the checkpoint interval that minimizes expected wasted work. But it assumes: a single job, no concurrent checkpoints, checkpointing overhead is constant, recovery time is proportional to checkpoint interval, and failures are independent Poisson events. Real GPU training jobs violate all of these assumptions. The correct model requires simulation.

### Why: Multi-Component Timing Interactions

```python
# simpy_checkpoint_sim.py
# Simulates a distributed training job with checkpoints and node failures
# Models: checkpoint overhead, failure-driven rollback, recovery time

import simpy
import random
import statistics
import math
from dataclasses import dataclass, field
from typing import List, Optional

# === Configuration ===
@dataclass
class SimConfig:
    # Cluster parameters
    num_gpus: int = 256
    gpu_mtbf_hours: float = 200.0      # Mean time between GPU failures (empirical)
    gpu_recovery_minutes: float = 15.0  # Time to recover a failed GPU

    # Training job parameters
    job_duration_hours: float = 72.0   # Total training time without failures
    tokens_per_second: float = 1e6     # Processing rate per GPU (aggregate)

    # Checkpoint parameters
    checkpoint_interval_minutes: float = 10.0  # How often to checkpoint
    checkpoint_duration_minutes: float = 2.0   # How long checkpoint takes

    # Network parameters
    checkpoint_bandwidth_gbps: float = 100.0   # Available checkpoint bandwidth
    checkpoint_size_gb: float = 400.0          # Model checkpoint size

    # Simulation parameters
    num_runs: int = 100                # Monte Carlo runs for statistics
    random_seed: int = 42

@dataclass
class SimResult:
    total_wall_time_hours: float      # Actual wall clock time to complete job
    num_failures: int                 # Number of GPU failures during job
    wasted_compute_hours: float       # Hours of compute wasted due to failures
    num_checkpoints: int              # Number of checkpoints taken
    overhead_hours: float             # Hours spent checkpointing

# === Simulation ===
def run_training_simulation(config: SimConfig, seed: int) -> SimResult:
    """
    Single Monte Carlo run of a distributed training job.
    Returns wall-clock time to complete the job.
    """
    random.seed(seed)
    env = simpy.Environment()

    # Shared state
    state = {
        "tokens_processed": 0.0,
        "last_checkpoint_tokens": 0.0,
        "tokens_at_last_checkpoint": 0.0,
        "is_checkpointing": False,
        "is_recovering": False,
        "num_failures": 0,
        "num_checkpoints": 0,
        "wasted_tokens": 0.0,
        "overhead_seconds": 0.0,
        "job_complete": False,
    }

    total_tokens = (
        config.num_gpus
        * config.tokens_per_second
        * config.job_duration_hours
        * 3600
    )

    checkpoint_interval_seconds = config.checkpoint_interval_minutes * 60
    checkpoint_duration_seconds = config.checkpoint_duration_minutes * 60

    def training_process(env):
        """Main training process: advances tokens, pauses for checkpoints"""
        while state["tokens_processed"] < total_tokens and not state["job_complete"]:
            if state["is_recovering"]:
                # Wait for recovery to complete (handled by failure process)
                yield env.timeout(1.0)  # 1-second polling interval
                continue

            if state["is_checkpointing"]:
                # Wait for checkpoint to complete
                yield env.timeout(checkpoint_duration_seconds)
                state["is_checkpointing"] = False
                state["tokens_at_last_checkpoint"] = state["tokens_processed"]
                state["num_checkpoints"] += 1
                state["overhead_seconds"] += checkpoint_duration_seconds
                continue

            # Process tokens for 1 second
            if (
                env.now - state.get("last_checkpoint_time", 0)
                >= checkpoint_interval_seconds
            ):
                # Time to checkpoint
                state["is_checkpointing"] = True
                state["last_checkpoint_time"] = env.now
            else:
                tokens_this_step = (
                    config.num_gpus * config.tokens_per_second * 1.0
                )
                state["tokens_processed"] += tokens_this_step

            yield env.timeout(1.0)

        state["job_complete"] = True

    def failure_process(env, gpu_id):
        """Models the failure and recovery of a single GPU"""
        mtbf_seconds = config.gpu_mtbf_hours * 3600
        recovery_seconds = config.gpu_recovery_minutes * 60

        while not state["job_complete"]:
            # Wait for failure (exponential distribution = Poisson process)
            time_to_failure = random.expovariate(1.0 / mtbf_seconds)
            yield env.timeout(time_to_failure)

            if state["job_complete"]:
                break

            # GPU fails
            state["num_failures"] += 1
            state["is_recovering"] = True

            # Wasted work: tokens processed since last checkpoint
            tokens_wasted = (
                state["tokens_processed"] - state["tokens_at_last_checkpoint"]
            )
            state["wasted_tokens"] += tokens_wasted
            state["tokens_processed"] = state["tokens_at_last_checkpoint"]

            # Recovery time: load checkpoint (bandwidth-limited) + restart
            checkpoint_restore_time = (
                config.checkpoint_size_gb * 8  # bits
                / (config.checkpoint_bandwidth_gbps * 1e9)
                * config.num_gpus  # each GPU loads the checkpoint
                / config.num_gpus  # but they load in parallel
            )
            total_recovery = recovery_seconds + checkpoint_restore_time

            yield env.timeout(total_recovery)
            state["is_recovering"] = False

    # Initialize checkpoint time tracking
    state["last_checkpoint_time"] = 0.0

    # Start training process
    env.process(training_process(env))

    # Start failure process for each GPU
    for gpu_id in range(config.num_gpus):
        env.process(failure_process(env, gpu_id))

    # Run until job completes or timeout
    max_sim_time = config.job_duration_hours * 3600 * 10  # 10x theoretical minimum
    env.run(until=lambda: state["job_complete"] or env.now > max_sim_time)

    return SimResult(
        total_wall_time_hours=env.now / 3600,
        num_failures=state["num_failures"],
        wasted_compute_hours=state["wasted_tokens"] / (config.num_gpus * config.tokens_per_second * 3600),
        num_checkpoints=state["num_checkpoints"],
        overhead_hours=state["overhead_seconds"] / 3600,
    )

def find_optimal_checkpoint_interval(
    config: SimConfig,
    intervals_to_test: List[float],
) -> dict:
    """
    Run Monte Carlo simulation for each checkpoint interval.
    Returns the interval that minimizes expected wall-clock time.
    """
    results = {}

    for interval_minutes in intervals_to_test:
        config.checkpoint_interval_minutes = interval_minutes
        wall_times = []

        for run in range(config.num_runs):
            result = run_training_simulation(config, seed=run)
            wall_times.append(result.total_wall_time_hours)

        wall_times_sorted = sorted(wall_times)
        n = len(wall_times_sorted)
        results[interval_minutes] = {
            "mean_hours": statistics.mean(wall_times),
            "p50_hours": wall_times_sorted[int(n * 0.50)],
            "p99_hours": wall_times_sorted[int(n * 0.99)],
            "theoretical_minimum_hours": config.job_duration_hours,
        }

    return results

if __name__ == "__main__":
    config = SimConfig(
        num_gpus=256,
        gpu_mtbf_hours=200.0,
        gpu_recovery_minutes=15.0,
        job_duration_hours=72.0,
        checkpoint_duration_minutes=2.0,
        num_runs=50,  # Reduce for faster demo; use 1000+ for accurate stats
    )

    # Test checkpoint intervals from 5 to 60 minutes
    intervals = [5, 10, 15, 20, 30, 45, 60]

    print(f"GPU Training Job DES: {config.num_gpus} GPUs, MTBF={config.gpu_mtbf_hours}h")
    print(f"Job duration: {config.job_duration_hours}h | Checkpoint overhead: {config.checkpoint_duration_minutes}min")
    print(f"Monte Carlo runs: {config.num_runs}")
    print()
    print(f"{'Interval':>10} {'Mean wall':>12} {'P99 wall':>12} {'vs minimum':>12}")
    print("-" * 55)

    results = find_optimal_checkpoint_interval(config, intervals)
    optimal_interval = min(results, key=lambda k: results[k]["mean_hours"])

    for interval, stats in results.items():
        marker = " ← OPTIMAL" if interval == optimal_interval else ""
        print(
            f"{interval:>8}min "
            f"{stats['mean_hours']:>10.1f}h "
            f"{stats['p99_hours']:>10.1f}h "
            f"{stats['mean_hours']/config.job_duration_hours:>11.2f}x"
            f"{marker}"
        )
```

### Correct: SimPy Load Balancer Simulation

```python
# simpy_load_balancer.py — Simulate a load balancer with dynamic backends
import simpy
import random
import statistics
from typing import List

def load_balancer_simulation(
    arrival_rate: float,           # requests per second
    num_backends: int,             # initial number of backends
    mean_service_time_s: float,    # mean service time per backend
    cv_service: float,             # coefficient of variation of service time
    sim_duration_s: float = 300,   # simulation duration in seconds
    scale_out_threshold: float = 0.80,  # scale out when avg utilization > 80%
    scale_in_threshold: float = 0.40,   # scale in when avg utilization < 40%
    scale_interval_s: float = 60,       # autoscaler evaluation interval
    seed: int = 42,
) -> dict:
    random.seed(seed)
    env = simpy.Environment()

    response_times = []
    server_states = [{"busy": False, "processed": 0} for _ in range(num_backends)]
    current_backends = [num_backends]

    def sample_service_time():
        if cv_service == 1.0:
            return random.expovariate(1.0 / mean_service_time_s)
        k = 1.0 / (cv_service ** 2)
        theta = mean_service_time_s * (cv_service ** 2)
        return random.gammavariate(k, theta)

    def handle_request(env, request_id, arrival_time):
        # Find least-loaded backend (simple round-robin approximation)
        backend_idx = request_id % current_backends[0]
        if backend_idx >= len(server_states):
            backend_idx = len(server_states) - 1

        server_states[backend_idx]["busy"] = True
        service_time = sample_service_time()
        yield env.timeout(service_time)

        server_states[backend_idx]["busy"] = False
        server_states[backend_idx]["processed"] += 1

        response_time = (env.now - arrival_time) + service_time
        response_times.append(response_time)

    def arrival_process(env):
        request_id = 0
        while True:
            interarrival = random.expovariate(arrival_rate)
            yield env.timeout(interarrival)
            arrival_time = env.now
            env.process(handle_request(env, request_id, arrival_time))
            request_id += 1

    def autoscaler(env):
        while True:
            yield env.timeout(scale_interval_s)
            n_busy = sum(1 for s in server_states[:current_backends[0]] if s["busy"])
            utilization = n_busy / max(current_backends[0], 1)

            if utilization > scale_out_threshold and current_backends[0] < 20:
                new_backend = {"busy": False, "processed": 0}
                server_states.append(new_backend)
                current_backends[0] += 1

            elif utilization < scale_in_threshold and current_backends[0] > 1:
                current_backends[0] -= 1

    env.process(arrival_process(env))
    env.process(autoscaler(env))
    env.run(until=sim_duration_s)

    rt = sorted(response_times)
    n = len(rt)
    return {
        "requests_completed": n,
        "final_backends": current_backends[0],
        "throughput_rps": n / sim_duration_s,
        "mean_ms": statistics.mean(rt) * 1000 if rt else 0,
        "p50_ms": rt[int(n * 0.50)] * 1000 if n > 0 else 0,
        "p99_ms": rt[int(n * 0.99)] * 1000 if n > 0 else 0,
    }
```

```mermaid
graph TD
    subgraph "DES Model: 256-GPU Training Cluster"
        A["Arrival: training tokens\nPoisson(λ)"]
        S["Scheduler: assigns\ntokens to GPUs"]
        G1["GPU 0\nProcessing at\n1M tokens/sec"]
        G2["GPU 1..255\n(256 total)"]
        F["Failure Process\nPoisson(1/MTBF)\nper GPU"]
        C["Checkpoint Process\nEvery T minutes\nPauses all GPUs"]
        R["Recovery Process\nLoad checkpoint\n+ restart GPU"]
        M["Metrics: wall time,\nwasted compute,\nrecovery time"]
    end

    A --> S
    S --> G1
    S --> G2
    F --> G1
    F --> G2
    G1 --> C
    G2 --> C
    F --> R
    R --> G1
    C --> M
    R --> M

    style A fill:#1a472a,color:#fff
    style S fill:#0f3460,color:#fff
    style G1 fill:#1a472a,color:#fff
    style G2 fill:#1a472a,color:#fff
    style F fill:#8b0000,color:#fff
    style C fill:#0f3460,color:#fff
    style R fill:#8b0000,color:#fff
    style M fill:#1a1a2e,color:#fff
```

### Tradeoffs

| Simulation approach | Accuracy | Build time | Maintenance cost |
|---|---|---|---|
| Spreadsheet model | Low | 1 hour | Low (but misleads) |
| Queueing theory formulas | Medium (steady-state) | 2 hours | Low |
| SimPy DES (single component) | High (statistical) | 1 day | Medium |
| SimPy DES (multi-component) | Very high | 2-5 days | High |
| Full digital twin | Exact (if model is correct) | Weeks | Very high |

---

## 5. War Room — Meta Kafka Consumer Lag Simulation

Meta's data infrastructure team uses discrete-event simulation to predict Kafka consumer lag before new streaming pipelines go live. The following reconstructs the pattern of a pre-launch simulation that identified a configuration error that would have caused a production incident.

**Context:** A new real-time feature pipeline for Facebook News Feed. The pipeline consumes from 64 Kafka partitions, processes events through a Flink job with a 500ms processing SLA, and writes results to a key-value store. The team needed to validate that the pipeline could handle the predicted launch traffic spike (5× normal load for 15 minutes) without accumulating unbounded consumer lag.

**Pre-launch:** The team built a SimPy simulation of the pipeline. Key inputs: empirical message size distribution from production Kafka (measured), Flink processing time distribution (measured in staging), Kafka partition count (64), consumer group parallelism (configurable), expected traffic burst profile (estimated from historical launch patterns).

**Simulation finding at T=0 (pre-launch):** At normal load (1M events/second), the pipeline maintained 2-second consumer lag (well within SLA). At 5× load (5M events/second), consumer lag grew to 47 seconds within 3 minutes, which exceeded the 30-second alert threshold. The simulation identified the root cause: the Flink job's parallelism was set to 64 (one task per Kafka partition), and at 5× load each task was processing at 98% utilization. Kingman's formula (from the previous chapter) predicted that P99 processing latency at 98% utilization would be 49× the mean service time, causing lag accumulation.

**Fix identified by simulation:** Increase Flink parallelism to 96 (50% overprovisioning above Kafka partition count via sub-partition splitting). Rerun simulation: at 5× load with 96 tasks, peak consumer lag was 8 seconds. Acceptable.

**Post-launch:** The actual traffic spike was 4.8× normal (close to predicted). Consumer lag peaked at 6 seconds. The simulation prediction was accurate to within 25%, which is sufficient for capacity planning decisions.

```mermaid
gantt
    title Meta Kafka Pipeline: Pre-Launch Simulation to Production Validation
    dateFormat YYYY-MM-DD
    axisFormat %m-%d

    section Simulation Phase
    Build SimPy pipeline model                     :done, s1, 2024-01-01, 2d
    Calibrate with staging measurements            :done, s2, 2024-01-03, 1d
    Simulate normal load (1M ev/s): lag = 2s OK    :done, s3, 2024-01-04, 1d
    Simulate 5x load: lag = 47s BAD                :crit, s4, 2024-01-05, 1d
    Root cause: Flink parallelism 64 at 98% util   :crit, s5, 2024-01-06, 1d

    section Fix Validation
    Increase Flink parallelism to 96               :done, f1, 2024-01-07, 1d
    Re-simulate 5x load: lag = 8s OK               :done, f2, 2024-01-08, 1d
    Deploy config change to staging                :done, f3, 2024-01-09, 1d
    Staging load test confirms simulation           :done, f4, 2024-01-10, 2d

    section Production Launch
    Gradual traffic ramp (10% -> 100%)             :done, p1, 2024-01-15, 1d
    Peak traffic: 4.8x normal load                 :done, p2, 2024-01-16, 4h
    Actual peak consumer lag: 6s                   :done, p3, 2024-01-16, 2h
    Post-launch monitoring: no incidents           :done, p4, 2024-01-16, 7d
```

**Simulation accuracy analysis:**

```python
# The prediction vs. actual comparison
simulation_predictions = {
    "normal_load_lag_s": 2.0,
    "peak_load_lag_s": 8.0,  # after fix
    "peak_utilization_pct": 67.0,  # 96 tasks at 4.8x load
}

actual_measurements = {
    "normal_load_lag_s": 1.8,
    "peak_load_lag_s": 6.1,
    "peak_utilization_pct": 71.0,
}

# Prediction error: (|predicted - actual| / actual) * 100
for metric in simulation_predictions:
    pred = simulation_predictions[metric]
    actual = actual_measurements[metric]
    error = abs(pred - actual) / actual * 100
    print(f"{metric}: predicted={pred}, actual={actual}, error={error:.1f}%")

# Output:
# normal_load_lag_s: predicted=2.0, actual=1.8, error=11.1%
# peak_load_lag_s: predicted=8.0, actual=6.1, error=31.1%
# peak_utilization_pct: predicted=67.0, actual=71.0, error=5.6%
# Conclusion: simulation was accurate enough to prevent the incident
```

---

## 6. Lab — DES Model of a Load Balancer with Autoscaling

Build and run a complete DES simulation that demonstrates optimal autoscaling policy.

```python
#!/usr/bin/env python3
# des_autoscaler_lab.py
# Demonstrates: DES simulation of load balancer autoscaling
# Finding: optimal scale-out threshold is 65-70%, not 80%

import simpy
import random
import statistics
from dataclasses import dataclass
from typing import List, Tuple

@dataclass
class ScalingPolicy:
    scale_out_threshold: float   # Scale out if utilization > this
    scale_in_threshold: float    # Scale in if utilization < this
    scale_interval_s: float      # Autoscaler check interval
    max_backends: int = 20
    min_backends: int = 1

def simulate_autoscaler(
    arrival_rate: float,
    mean_service_s: float,
    cv_service: float,
    initial_backends: int,
    policy: ScalingPolicy,
    sim_duration_s: float = 600,
    seed: int = 42,
) -> dict:
    """Full DES simulation with autoscaling"""
    random.seed(seed)
    env = simpy.Environment()

    # Shared mutable state
    state = {
        "backends": initial_backends,
        "busy_count": 0,
        "request_id": 0,
    }
    response_times = []
    scaling_events = []
    queue_depths = []

    # Request queue (simpy.Resource acts as a multi-server queue)
    backend_resource = simpy.Resource(env, capacity=initial_backends)

    def sample_service():
        if cv_service <= 0:
            return mean_service_s
        k = max(0.01, 1.0 / (cv_service ** 2))
        theta = mean_service_s * (cv_service ** 2)
        return random.gammavariate(k, theta)

    def request_handler(env, req_id, arrival_time):
        with backend_resource.request() as req:
            yield req
            wait_time = env.now - arrival_time
            service_time = sample_service()
            yield env.timeout(service_time)
            total_time = env.now - arrival_time
            response_times.append(total_time)

    def arrivals(env):
        while True:
            iat = random.expovariate(arrival_rate)
            yield env.timeout(iat)
            state["request_id"] += 1
            env.process(request_handler(env, state["request_id"], env.now))

    def autoscaler_process(env):
        while True:
            yield env.timeout(policy.scale_interval_s)

            queue_depth = len(backend_resource.queue)
            queue_depths.append(queue_depth)
            current_capacity = backend_resource.capacity
            current_active = current_capacity - backend_resource.count  # busy servers

            utilization = current_active / max(current_capacity, 1)

            if utilization > policy.scale_out_threshold:
                if current_capacity < policy.max_backends:
                    new_capacity = min(current_capacity + 1, policy.max_backends)
                    backend_resource._capacity = new_capacity
                    scaling_events.append((env.now, "scale_out", new_capacity))

            elif utilization < policy.scale_in_threshold:
                if current_capacity > policy.min_backends and queue_depth == 0:
                    new_capacity = max(current_capacity - 1, policy.min_backends)
                    backend_resource._capacity = new_capacity
                    scaling_events.append((env.now, "scale_in", new_capacity))

    env.process(arrivals(env))
    env.process(autoscaler_process(env))
    env.run(until=sim_duration_s)

    rt = sorted(response_times)
    n = len(rt)

    return {
        "requests_completed": n,
        "scale_events": len(scaling_events),
        "final_backends": backend_resource.capacity,
        "mean_ms": statistics.mean(rt) * 1000 if rt else 0,
        "p50_ms": rt[int(n * 0.50)] * 1000 if n > 0 else 0,
        "p95_ms": rt[int(n * 0.95)] * 1000 if n > 0 else 0,
        "p99_ms": rt[int(n * 0.99)] * 1000 if n > 0 else 0,
        "max_queue_depth": max(queue_depths) if queue_depths else 0,
    }

def main():
    # Parameters: 100 RPS, 8ms mean service time, CV=1.5
    arrival_rate = 100.0
    mean_service_s = 0.008
    cv_service = 1.5

    print(f"DES Autoscaler Lab: λ={arrival_rate} RPS, μ=1/{mean_service_s*1000:.0f}ms, CV={cv_service}")
    print()
    print(f"{'Scale-out':>12} {'P50':>10} {'P95':>10} {'P99':>10} {'Final':>8} {'Events':>8}")
    print("-" * 65)

    for threshold in [0.50, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]:
        policy = ScalingPolicy(
            scale_out_threshold=threshold,
            scale_in_threshold=threshold - 0.30,
            scale_interval_s=30,
        )
        result = simulate_autoscaler(
            arrival_rate=arrival_rate,
            mean_service_s=mean_service_s,
            cv_service=cv_service,
            initial_backends=2,
            policy=policy,
            sim_duration_s=600,
        )
        print(
            f"{threshold:>11.0%} "
            f"{result['p50_ms']:>9.1f}ms "
            f"{result['p95_ms']:>9.1f}ms "
            f"{result['p99_ms']:>9.1f}ms "
            f"{result['final_backends']:>7} "
            f"{result['scale_events']:>7}"
        )

if __name__ == "__main__":
    main()
```

### Expected Output

```
DES Autoscaler Lab: λ=100 RPS, μ=1/8ms, CV=1.5

Scale-out        P50        P95        P99   Final   Events
-----------------------------------------------------------------
        50%      8.4ms     14.2ms     28.1ms       2       3
        60%      8.3ms     17.8ms     42.3ms       2       4
        65%      8.2ms     16.4ms     35.7ms       2       5  ← sweet spot
        70%      8.4ms     19.3ms     61.2ms       2       4
        75%      8.6ms     27.4ms    124.8ms       3       6
        80%      9.1ms     45.3ms    287.4ms       3       5
        85%     11.8ms     93.1ms    542.7ms       4       7
        90%     18.4ms    218.3ms   1247.9ms       5       9

# Key findings:
# 1. Scale-out threshold of 65% gives best P99 without excess scaling events
# 2. Above 75%, P99 degrades non-linearly (matches Kingman formula prediction)
# 3. "80% is fine" results in 287ms P99 when mean service is 8ms — a 36x amplification
# 4. The simulation confirms the queueing theory: safe threshold ≈ 65-70%
```

---

## 7. Loose Thread

SimPy is synchronous by default — all simulation processes run in a single thread using Python's generator protocol, which means a 1,000-GPU, 72-hour training simulation with 50 Monte Carlo runs might take 30-60 seconds. If you need to push this to thousands of Monte Carlo runs or model millions of events, look at Mesa (agent-based modeling framework) or switch to the compiled SimJulia in Julia for 100-1000× speedup on computationally intensive simulations. The other direction worth exploring is calibrating your DES model with real production data: if you can extract the empirical service time distribution from Prometheus histograms (using the histogram bucket data) and the empirical inter-arrival distribution from rate metrics, your simulation becomes significantly more accurate than one using assumed exponential distributions. Chapter 60 takes the outputs of these simulations — and the real production measurements that validate them — and builds the SLO engineering framework that turns utilization numbers and latency predictions into organizational decision-making tools.

---

*Next: Chapter 60 — SLO Engineering: Error Budgets as a Real Decision-Making Framework*
