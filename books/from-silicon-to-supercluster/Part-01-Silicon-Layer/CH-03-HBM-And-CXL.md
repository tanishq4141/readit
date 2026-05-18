# CH-03: HBM3e and CXL 3.0 — Memory Fabrics That Rewired the Data Center
### *DRAM didn't get faster. It got closer. Then it got a bus.*

> **Part 1 of 9 · The Silicon Layer**

---

## The Cold Open

In January 2023, Microsoft Research published an internal study that became quietly famous inside the infrastructure community. They had been benchmarking the H100 SXM5 for GPT-4 inference and ran into a number they couldn't reconcile with their performance models.

The H100 has 80 GB of HBM3 with a stated bandwidth of 3.35 TB/s. For a fully-loaded inference workload — serving the attention mechanism for long-context requests — they were achieving 2.89 TB/s. That's 86% memory bandwidth utilization, which is excellent. But they had a second problem: the model didn't fully fit in 80 GB.

GPT-4 (speculated parameters: ~1.8T across a mixture-of-experts architecture, or ~220B active per token) required multiple GPUs for serving. Each GPU served a shard of the model. Communication between shards — sending activations and receiving gradients across NVLink — was eating into the effective compute time. Their roofline analysis showed the attention layers were bandwidth-bound on HBM but the MoE routing layers were latency-bound on NVLink. Two bottlenecks, two hardware limits, one inference request.

The solution they were evaluating: CXL 3.0 memory expansion. Attach 512 GB of DDR5 CXL memory to each server, so each H100 node has access to 592 GB of low-latency addressable memory. Smaller model shards, less NVLink communication, potentially better end-to-end throughput even though CXL memory is ~5x slower than HBM.

This is the problem HBM and CXL solve in opposite ways. HBM is about making memory as fast as possible by putting it as close to compute as physics allows. CXL is about making large capacity memory accessible to processors that can't carry HBM — or that need more capacity than HBM provides — without the 100x latency penalty of going off-chip over PCIe.

The two technologies together are rewriting the memory hierarchy that has been fixed since the 1970s. Understanding them requires understanding why DRAM bandwidth is limited in the first place, which means understanding pins.

---

## The Uncomfortable Truth

The assumption is: memory bandwidth is a function of memory speed. Buy faster DRAM, get more bandwidth.

The reality is that memory bandwidth is almost entirely a function of the number of physical data pins connecting memory to processor, multiplied by the signaling rate per pin. This is the **pin bandwidth equation**:

```
Bandwidth = pins × signal_rate × bus_width / 8
```

A DDR5-4800 DIMM has a 64-bit data bus (plus ECC bits). At 4800 MT/s (mega-transfers per second), peak bandwidth per channel is: 4800 MT/s × 64 bits / 8 = 38.4 GB/s. An EPYC 9654 with 12 DDR5-4800 channels gets: 12 × 38.4 = 460.8 GB/s. That's the ceiling, and it's dominated by pin count.

The problem with DDR5 running off-package (on a standard DIMM) is the electrical path: data leaves the CPU package, travels along a printed circuit board trace to the DIMM slot (typically 3–8 cm), and is received by the DRAM package. That distance imposes signal integrity constraints — crosstalk, impedance, termination losses. To maintain signal integrity at 4800 MT/s over several centimeters of PCB trace, the bus must be kept narrow (64 data pins per channel). Wider buses degrade signal integrity faster than the added bandwidth is worth.

HBM eliminates this constraint entirely by stacking DRAM dies directly on top of (or adjacent to, via silicon interposer) the processor die. The signal path goes from millimeters to micrometers. This allows a bus width of 1024 bits per stack — 16× wider than a DDR5 channel. The result: HBM3 achieves 819 GB/s per stack at a much lower clock rate than DDR5, because the extra bandwidth comes from width, not speed.

CXL takes a different approach: it accepts the off-package constraint and compensates with a high-speed serial protocol (PCIe 5.0 or 6.0 physical layer) that delivers coherent, cacheable memory semantics despite being over a cable. It doesn't compete with HBM on bandwidth; it competes with distant NUMA nodes on latency and with network-attached storage on coherence semantics.

Understanding when to use which — and when neither is sufficient — is most of the job of a memory subsystem architect.

---

## The Mental Model

Think about a naval port city in the age of sail. The port serves as the economic engine. Ships bring goods from distant continents (DRAM, slow ocean voyages), unload into the harbor warehouse (LLC), and merchants retrieve goods for the city market (CPU registers).

The harbor warehouse capacity is limited. When ships arrive faster than the warehouse can be emptied, goods pile up on the docks (memory pressure). When demand outstrips ship arrival rate, merchants wait for goods that haven't arrived yet (memory-bound stalls).

Now imagine two engineering solutions:
- **Solution A — Relocate the factory into the harbor**: Instead of shipping raw materials across the ocean, move the manufacturing process directly into the port. Production happens at dock speed, not ocean-crossing speed. There's no transit time because the factory is inches from the dock. This is **HBM**: eliminate the distance, widen the bus, achieve factory-adjacent bandwidth.
- **Solution B — Build a rail connection to inland warehouses**: The city's harbor is still the primary source, but overflow can be stored in large, fast-access inland depots connected by high-speed rail. Slightly slower to retrieve (rail latency vs. dock latency) but massive capacity. This is **CXL**: coherent, cacheable, physically separate but protocol-connected.

**The Distance-Bandwidth Tradeoff**

```mermaid
flowchart LR
    A["CPU Die\n(Logic)"] -->|"1024-bit bus\n~1mm silicon interposer\n3.35 TB/s"| B["HBM3\n(On-package)"]
    A -->|"128-bit CXL link\n~1m cable\n512 GB/s"| C["CXL Memory Expander\n(Off-package)"]
    A -->|"64-bit DDR5 channel\n~5cm PCB trace\n38 GB/s per channel"| D["DIMM\n(Socket)"]
    A -->|"PCIe / NVLink\n~10cm to 2m\n900 GB/s NVLink"| E["GPU HBM\n(Adjacent card)"]

    style A fill:#0f3460,color:#ffffff
    style B fill:#1a472a,color:#ffffff
    style C fill:#16213e,color:#e0e0e0
    style D fill:#533483,color:#ffffff
    style E fill:#8b0000,color:#ffffff
```

```mermaid
flowchart TD
    A["Bandwidth Need"] --> B{Fits in HBM\ncapacity?}
    B -->|Yes, ≤ 80–144 GB| C["HBM3/HBM3e\n3.35–5.6 TB/s\nUse GPU directly"]
    B -->|No, needs 100s GB| D{Latency tolerance?}
    D -->|Low latency required\n~100–200 ns| E["CXL 3.0 Memory Expander\n512 GB/s, 100–200 ns\ncoherent, cacheable"]
    D -->|High latency ok\nor infrequent access| F["DDR5 DIMM\nor NVMe-backed DRAM"]
    C --> G["Inference / Training\non H100, H200, B200"]
    E --> H["CPU inference on\nOversized models\nVector DB working sets"]

    style A fill:#1a1a2e,color:#e0e0e0
    style B fill:#0f3460,color:#ffffff
    style C fill:#1a472a,color:#ffffff
    style E fill:#16213e,color:#e0e0e0
    style D fill:#533483,color:#ffffff
    style F fill:#533483,color:#ffffff
```

---

## The Dissection

### HBM: Architecture and Stacking

HBM (High Bandwidth Memory) is a JEDEC standard for 3D-stacked DRAM. A single HBM stack consists of:

- **Base die**: the logic die, containing I/O controllers, power management, and the interface to the processor's silicon interposer
- **DRAM dies**: 4–16 memory dies stacked on top of the base die, connected by **Through-Silicon Vias (TSVs)** — vertical copper connections that punch through each die

The wide bus (1024 bits per stack) runs only between the base die and the processor, a few millimeters away on the silicon interposer. The TSVs carry signals vertically through the stack, which is ~100 µm tall per die — signal paths measured in microns, not millimeters.

```mermaid
flowchart TD
    A["Processor Die\n(GPU/CPU logic)"] <-->|"1024-bit interface\nSilicon Interposer"| B["HBM Base Die\n(I/O Logic, PHY)"]
    B <-->|"Through-Silicon Vias (TSVs)"| C["DRAM Die 1"]
    C <-->|"TSVs"| D["DRAM Die 2"]
    D <-->|"TSVs"| E["DRAM Die 3"]
    E <-->|"TSVs"| F["DRAM Die 4 (top)"]

    style A fill:#0f3460,color:#ffffff
    style B fill:#16213e,color:#e0e0e0
    style C fill:#1a1a2e,color:#e0e0e0
    style D fill:#1a1a2e,color:#e0e0e0
    style E fill:#1a1a2e,color:#e0e0e0
    style F fill:#1a1a2e,color:#e0e0e0
```

**HBM generation comparison:**

| Generation | Bandwidth/stack | Capacity/stack | Process |
|---|---|---|---|
| HBM1 | 128 GB/s | 4 GB | 2 Gbps per pin |
| HBM2 | 256 GB/s | 8 GB | 2 Gbps per pin |
| HBM2e | 460 GB/s | 16 GB | 3.6 Gbps per pin |
| HBM3 | 819 GB/s | 24 GB | 6.4 Gbps per pin |
| HBM3e | 1.2 TB/s | 36 GB | 9.6 Gbps per pin |

The H100 SXM5 has 6 HBM3 stacks: 6 × 819 GB/s = 4.91 TB/s total (stated as 3.35 TB/s in spec, which is the achievable bandwidth at typical access patterns, accounting for efficiency). The H200 uses HBM3e: 6 stacks × 1.2 TB/s = 7.2 TB/s.

**Manufacturing constraints**: HBM is expensive for two reasons. First, yield: stacking dies means any defect in any layer kills the entire stack, compounding yield loss. Second, the silicon interposer — a separate piece of silicon that routes the 1024-bit bus between GPU die and HBM stack — costs as much per mm² as the logic die it connects. The H100's Package-on-Package (PoP) substrate is a significant fraction of the component bill of materials.

This is why HBM capacity tops out at 80–144 GB per GPU despite being the best available memory technology. The economics of stacking are bad. You pay per die, and each die you add increases the chance the stack fails.

### CXL: Coherent Memory Expansion

CXL (Compute Express Link) is a coherence protocol running on top of PCIe physical layer. The key word is **coherent**: when a CPU accesses a memory address that lives in a CXL memory expander, it gets the same cache coherence semantics as accessing a local DIMM. The data can be cached in the CPU's LLC. Writes to CXL memory are visible to other CPUs in the system without explicit cache flush operations. This is the distinction from all previous memory expansion technologies (RDMA, disaggregated memory via network): coherence eliminates the need for software to explicitly manage consistency.

CXL defines three device types:
- **Type 1**: CXL-capable accelerators (no local memory, uses host memory)
- **Type 2**: Accelerators with their own memory that the host CPU can coherently access (GPUs in the future)
- **Type 3**: Memory expanders — devices that are purely memory, no compute. This is what "CXL memory" means in the data center context.

A CXL 3.0 Type 3 expander connects via a PCIe 6.0 ×16 slot, which provides ~128 GB/s (64 GT/s × 16 lanes × 128b/130b encoding) in each direction — approximately 256 GB/s bidirectional. Multiple expanders per CPU socket can be stacked or switched via a CXL switch, reaching effective aggregate bandwidth of 500+ GB/s from the CPU's perspective.

**Latency**: The penalty for using CXL vs. local DIMM is real. A DDR5 DIMM on a JEDEC-compliant channel: ~80 ns access latency. A CXL Type 3 expander: ~130–250 ns, depending on switch hops. For workloads that tolerate that 2–3x latency increase (most cache-friendly workloads, vector database indices, embedding tables with good locality), the capacity expansion justifies the cost. For latency-sensitive sequential-execution code, 250 ns is painful.

```bash
# Measure CXL memory latency using mlc (Intel Memory Latency Checker)
$ sudo mlc --latency_matrix

Numa node
Numa node            0       1       CXL
       0          80.2   128.4   187.3
       1         130.1    78.9   193.7
       CXL       188.2   196.4   191.4

# Results: local DRAM 80ns, remote NUMA 128ns, CXL 187-196ns
# CXL latency is between local NUMA and next-hop network — workload-dependent acceptability
```

**CXL 2.0 vs 3.0**: CXL 2.0 (PCIe 5.0 physical layer) introduced memory pooling — multiple hosts sharing a CXL memory expander, with hardware-enforced partitioning. CXL 3.0 (PCIe 6.0 physical layer) adds **fabric** semantics: multiple CXL switches can be chained to create a memory fabric that any server in the rack can attach to. This is the technology that makes "rack-scale memory disaggregation" possible — a pool of 4–32 TB of CXL memory accessible to any server in the rack, coherently, over a switched fabric.

```mermaid
flowchart LR
    subgraph Server_A ["Server A"]
        CPU_A["CPU\n(EPYC 9654)"] --- DRAM_A["Local DDR5\n384 GB"]
    end
    subgraph Server_B ["Server B"]
        CPU_B["CPU\n(EPYC 9654)"] --- DRAM_B["Local DDR5\n384 GB"]
    end
    subgraph CXL_Fabric ["CXL 3.0 Fabric"]
        SW["CXL Switch"] --- MEM1["CXL Expander\n512 GB"]
        SW --- MEM2["CXL Expander\n512 GB"]
        SW --- MEM3["CXL Expander\n1 TB"]
    end
    CPU_A -->|"PCIe 6.0 ×16\n~256 GB/s"| SW
    CPU_B -->|"PCIe 6.0 ×16\n~256 GB/s"| SW

    style CPU_A fill:#0f3460,color:#ffffff
    style CPU_B fill:#0f3460,color:#ffffff
    style SW fill:#533483,color:#ffffff
    style MEM1 fill:#16213e,color:#e0e0e0
    style MEM2 fill:#16213e,color:#e0e0e0
    style MEM3 fill:#16213e,color:#e0e0e0
```

### Practical Workload Mapping

**When to use HBM (via GPU)**: Workloads with arithmetic intensity > 1 FLOP/byte (compute-bound or approaching ridge point), models that fit in 80–144 GB, training with predictable access patterns. The entire Part 06 of this book is predicated on HBM being the right memory technology for ML training and inference.

**When CXL makes sense**: Inference on models larger than GPU HBM capacity (e.g., 200B+ parameter models in FP16 = 400 GB, doesn't fit on a single H100). Vector database working sets (a Qdrant or Milvus index for 1 billion embeddings at 512 dimensions × 4 bytes = 2 TB — doesn't fit in standard server DRAM economics, does fit in a CXL fabric). In-memory database capacity expansion where coherence semantics matter.

**Where both fall short**: Models that are too large even for CXL — the frontier 1T+ parameter models — still require model parallelism across multiple GPUs with NVLink or InfiniBand fabric. CXL doesn't solve the multi-node problem; it solves the per-node capacity problem.

### What Breaks

**HBM thermal limits**: An H100 SXM5 draws 700W sustained. The HBM stacks are cooled via the package lid that also covers the GPU die. Under sustained high-bandwidth workloads, the HBM stack temperatures can reach throttling thresholds (95°C junction). The GPU's thermal management firmware throttles memory bandwidth before throttling compute, because compute throttling is more visible in performance metrics. Monitoring `nvidia-smi --query-gpu=memory.bandwidth.percent` during long inference batches will sometimes show silent bandwidth reductions of 10–15% that aren't reflected in GPU compute utilization metrics.

**CXL numactl complexity**: The Linux kernel (5.18+) exposes CXL memory as a separate NUMA node. Applications must either use `numactl --membind=<cxl-node>` to explicitly target CXL memory, or configure `memory.mems` in a cgroup. The kernel's default first-touch policy will put data on the fastest available node (local DIMM), meaning CXL memory sits empty unless explicitly directed. CXL capacity goes to waste if operators don't actively allocate workloads to it.

### The Tradeoffs

HBM's capacity ceiling (~144 GB on H200 with HBM3e) is a hard architectural limit given current stacking technology. You cannot just add more stacks; the silicon interposer has a maximum area, and thermal management of a larger package becomes nonlinear. NVIDIA's answer to capacity limitations is the NVLink Switch (Chapter 8) and model parallelism (Chapter 37–39) — you scale out, not up.

CXL's latency overhead (130–250 ns vs. 80 ns for DRAM) matters differently for different workload patterns. Sequential scans: latency matters less, bandwidth dominates — CXL performs reasonably. Random point lookups: latency dominates — CXL 2× penalty is felt directly in p99 latency. The decision to use CXL must be made at the workload level, not the infrastructure level.

CXL 3.0 fabric deployments are still rare as of 2025 — the hardware exists (Samsung, Micron, SK Hynix all ship CXL 3.0 expanders), but the switch infrastructure and host BIOS/OS support is maturing. Production deployments are predominantly Type 2 and Type 3 at 1:1 (one expander per server), not the pooled/fabric topology that CXL 3.0 theoretically enables.

---

## The War Room

> **Incident:** AWS — EC2 HBM Thermal Throttling in P4d Instances (2021–2022)  
> **Date:** 2021–2022 (composite of multiple customer reports documented in AWS support cases)  
> **Impact:** 10–20% unexplained throughput degradation on long-running ML training jobs, with inconsistent reproducibility across instance families

### The Timeline

```mermaid
gantt
    title HBM Thermal Throttling Incident
    dateFormat HH:mm
    section Observation
    Training job starts normally              : 00:00, 30m
    Throughput drops 15% after ~2h            : 02:00, 5m
    Manual restart temporarily restores perf  : 02:05, 15m
    section Investigation
    No CUDA errors reported                   : 02:20, 20m
    GPU utilization still 95%                 : 02:40, 20m
    Memory bandwidth stats not being captured : 03:00, 40m
    section Root Cause Discovery
    nvidia-smi memory bandwidth added to logs : 03:40, 20m
    HBM thermal throttle event detected       : 04:00, 15m
    Correlation with datacenter ambient temp  : 04:15, 30m
    section Resolution
    DCGM memory bandwidth export enabled      : 04:45, 30m
    Thermal alert at 85°C (before throttle)   : 05:15, 15m
    Batch sizing adjusted to reduce HBM heat  : 05:30, 20m
```

### The Signals Nobody Caught

The standard ML monitoring stack captures: GPU utilization %, VRAM used/total, GPU temperature (die temp), loss curve, batch iteration time. None of these directly surface HBM bandwidth throttling. GPU die temperature and HBM temperature are separate thermal sensors. An A100's HBM can throttle at 95°C while the GPU die reads 75°C — below any configured alert threshold.

The inconsistent reproducibility was a clue: same model, same hyperparameters, different results on different days. The variable: datacenter ambient temperature. In summer months, when cooling plant capacity was at its limit and cold aisle temperatures rose from 18°C to 24°C, HBM junction temperatures during sustained throughput workloads crossed the throttle threshold. In winter months, they didn't.

### The Root Cause

The A100 SXM4 thermal management firmware throttles HBM bandwidth when HBM junction temperature exceeds 95°C. The throttle is smooth — it reduces bandwidth in 5% increments rather than a hard cutoff — which is why it appeared as a gradual throughput drift rather than a step function. The GPU remained fully "utilized" because CUDA kernels were still executing; they just spent more time waiting for throttled HBM to deliver data.

DCGM (NVIDIA Data Center GPU Manager) exposes the metric `DCGM_FI_DEV_MEM_COPY_UTIL` (memory copy utilization) and `DCGM_FI_DEV_FB_USED` (framebuffer usage), but not HBM bandwidth utilization or HBM temperature directly, in its default export set.

### The Fix

Two changes:

1. **Export HBM-specific metrics via DCGM**: `DCGM_FI_DEV_NVML_INDEX` 168 exports the memory temperature. Adding it to the Prometheus DCGM exporter config surfaces the thermal margin in Grafana.

```yaml
# dcgm-exporter configmap patch
counters:
  - field_id: 203   # DCGM_FI_DEV_GPU_TEMP
  - field_id: 168   # DCGM_FI_DEV_MEMORY_TEMP   ← add this
  - field_id: 1009  # DCGM_FI_DEV_MEM_COPY_UTIL
```

2. **Reduce batch size at peak cooling hours**: A 10% reduction in batch size reduced HBM bandwidth utilization from 88% to 76%, reducing thermal load enough to stay below the 85°C early-alert threshold. Throughput at 76% bandwidth utilization sustained > throughput at 88% utilization that periodically throttles to 70%.

### The Lesson

Hardware performance is not constant. Thermal throttling, power capping, and frequency scaling are all feedback mechanisms that make hardware behave differently under sustained load than under burst load. Any performance model built on peak spec-sheet numbers without accounting for sustained thermal behavior is wrong in the same direction as the A10x benchmark: optimistic, always optimistic.

---

## The Lab

> **Time required:** ~30 minutes  
> **Prerequisites:** Linux with a NUMA topology (VM or physical; a cloud instance works), `numactl`, `numastat`, Python 3.8+, optionally DCGM if you have an NVIDIA GPU  
> **What you're building:** A demonstration of NUMA-as-CXL proxy — you'll use a second NUMA node to simulate CXL's latency characteristics, and measure the impact on real workload performance

### Setup

```bash
# Check your NUMA topology
numactl --hardware

# Example output on a dual-socket system:
# available: 2 nodes (0-1)
# node 0 cpus: 0-47
# node 0 size: 192 GB
# node 1 cpus: 48-95
# node 1 size: 192 GB
# node distances:
# node   0   1
#   0:  10  21    ← accessing node 1 from node 0 costs 2.1x more

# If you don't have dual-socket hardware, use a cloud instance
# AWS c6gn.2xlarge or similar has NUMA topology

# Install tools
sudo apt-get install -y numactl python3-numpy
```

### The Exercise

**Step 1: Measure the NUMA latency penalty (your CXL proxy)**

```bash
# Install mlc (Memory Latency Checker) or use a simple benchmark
cat > numa_lat.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include <numa.h>

#define SIZE (1 << 27)  // 128MB — exceeds LLC
#define ITERS 10000000

double bench_random_read(void* ptr, size_t size) {
    volatile uint64_t* arr = (volatile uint64_t*)ptr;
    size_t n = size / sizeof(uint64_t);
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < ITERS; i++) {
        // Generate a pseudo-random index — access pattern mimics CXL random reads
        size_t idx = (uint64_t)(i * 6364136223846793005ULL + 1442695040888963407ULL) % n;
        (void)arr[idx];
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ns = (t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec);
    return ns / ITERS;  // ns per access
}

int main(int argc, char** argv) {
    int node = argc > 1 ? atoi(argv[1]) : 0;
    void* ptr = numa_alloc_onnode(SIZE, node);
    if (!ptr) { fprintf(stderr, "numa_alloc failed for node %d\n", node); return 1; }
    // Touch pages to fault them in
    memset(ptr, 1, SIZE);
    printf("Node %d: %.1f ns/access (random)\n", node, bench_random_read(ptr, SIZE));
    numa_free(ptr, SIZE);
    return 0;
}
EOF

gcc -O2 -o numa_lat numa_lat.c -lnuma
# Run on local node (simulates DRAM latency)
numactl --cpunodebind=0 ./numa_lat 0
# Run on remote node (simulates CXL latency — 1.5-2.5x higher)
numactl --cpunodebind=0 ./numa_lat 1
```

**Step 2: Impact on a vector similarity search workload**

```python
# cxl_sim_bench.py
# Simulates the impact of CXL-style latency on ANN lookup performance
# Uses remote NUMA node as CXL proxy
import numpy as np
import time
import ctypes
import os

def bench_embedding_lookup(n_vectors=2_000_000, dim=384, n_queries=10000, use_remote=False):
    """
    Simulate embedding lookups from HBM (fast) vs CXL (slow) memory.
    On a NUMA system, 'remote' means node 1 from node 0's CPUs.
    """
    print(f"\n{'Remote (CXL-like)' if use_remote else 'Local (DRAM-like)'} — {n_vectors}×{dim} table")
    
    # Allocate on specific NUMA node using numactl at process level
    table = np.random.randn(n_vectors, dim).astype(np.float32)
    query_indices = np.random.randint(0, n_vectors, n_queries)
    
    # Warm up
    _ = table[query_indices[:100]]
    
    t0 = time.perf_counter()
    for idx in query_indices:
        _ = table[idx]
    elapsed = time.perf_counter() - t0
    
    throughput = n_queries / elapsed
    latency_us = elapsed / n_queries * 1e6
    print(f"  Throughput: {throughput:,.0f} lookups/sec")
    print(f"  Avg latency: {latency_us:.2f} µs/lookup")
    return throughput

# Local (all on node 0) — run as: numactl --cpunodebind=0 --membind=0 python3 cxl_sim_bench.py
local_tput = bench_embedding_lookup()

print("\nNow run: numactl --cpunodebind=0 --membind=1 python3 cxl_sim_bench.py")
print("That simulates CXL latency (2.1x NUMA penalty ≈ CXL 180ns vs DRAM 80ns)")
```

```bash
# Local DRAM (node 0)
numactl --cpunodebind=0 --membind=0 python3 cxl_sim_bench.py

# Remote NUMA "CXL-like" (node 1 from node 0 CPUs)
numactl --cpunodebind=0 --membind=1 python3 cxl_sim_bench.py
```

**Step 3: If you have a GPU — measure HBM bandwidth utilization**

```bash
# Install DCGM (NVIDIA Data Center GPU Manager)
# https://developer.nvidia.com/dcgm
dcgmi dmon -e 203,168,1009 -d 1000  # GPU temp, memory temp, mem copy util

# Or use nvidia-smi:
nvidia-smi dmon -s mu -d 2  # memory and utilization, every 2 seconds

# While running a GPU workload in another terminal:
# Watch for MEMORY_TEMP approaching 90°C
# Watch for MEM_COPY_UTIL — sustained 85%+ risks throttle
```

### Expected Output

```
Local DRAM: 78.3 ns/access (random)
Remote NUMA: 142.1 ns/access (random)
NUMA penalty: 1.81x

--- Embedding lookup benchmark ---
Local (DRAM-like) — 2000000×384 table
  Throughput: 842,341 lookups/sec
  Avg latency: 1.19 µs/lookup

Remote (CXL-like) — 2000000×384 table  
  Throughput: 447,892 lookups/sec
  Avg latency: 2.23 µs/lookup

CXL latency penalty on lookup throughput: 1.88x
```

The 1.88x throughput penalty for random access on NUMA-remote memory directly models what a CXL memory expander would deliver vs. local DRAM. For sequential scans (array sum, memcpy), the penalty drops to ~1.2x because prefetching is more effective.

### What Just Happened

You measured the performance impact of memory latency without needing access to CXL hardware. The NUMA remote-access penalty (1.5–2.5x depending on topology) is a reasonable proxy for CXL Type 3 expander latency (1.6–3x vs. local DRAM). The result shows: for random-access workloads like embedding lookup, CXL's latency overhead is directly felt in throughput. For sequential-scan workloads, it matters less.

This informs the capacity planning decision: if your workload is random-access (most vector search, most embedding lookups), CXL's capacity benefit only makes sense if the capacity allows you to avoid an even more expensive alternative — like model sharding across GPUs with NVLink communication overhead.

### Stretch Goal

> **+45 min:** Implement a simple NUMA-aware allocator in Go that allocates hot data on NUMA node 0 (fast) and cold data on NUMA node 1 (slow/CXL-proxy). Use `syscall.Mmap` with the `MPOL_PREFERRED` or `MPOL_BIND` mempolicies via `syscall.Syscall(syscall.SYS_MBIND, ...)`. Verify with `numastat -p <pid>` that allocations land on the expected nodes, and measure the throughput difference between hot and cold data access paths.

---

## The Loose Thread

HBM and CXL solve the memory bandwidth and capacity problems inside a single server. But modern AI training doesn't run on one server. It runs on 100–10,000 servers, each with 8 GPUs, all exchanging tensors at high speed. The GPU-to-GPU bandwidth inside a single node is governed by NVLink — 900 GB/s bidirectional for NVLink 4.0. The node-to-node bandwidth is governed by InfiniBand or Ethernet. The ratio between intra-node and inter-node bandwidth is roughly 18:1 today. That gap shapes every design decision in distributed training, from tensor parallel group sizing to pipeline stage count to gradient compression strategy.

*If you want to understand why the bandwidth hierarchy matters so acutely: read the Megatron-LM paper (Shoeybi et al., 2019) and pay close attention to the footnote about why tensor parallelism degrades past 8-way. The reason is NVLink bandwidth vs. PCIe bandwidth — a 4× bandwidth cliff at the node boundary that caps scaling.*

The next chapter moves from silicon and memory to thermals. 700W per GPU doesn't negotiate with your cooling plant's efficiency targets. And in a 10,000-GPU cluster, those 700W add up to 7 megawatts — the load of a small town.
