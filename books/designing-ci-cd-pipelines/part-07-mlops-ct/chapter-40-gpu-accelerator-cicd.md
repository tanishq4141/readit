# Chapter 40: The GPU/Accelerator-Aware CI/CD Pattern
*Part VII: MLOps, AI & Continuous Training (CT)*

> *"Our CI ran on CPU. We deployed to GPU inference.
> A CUDA operation that correctly handled NaN on GPU
> returned incorrect values when simulated on CPU.
> The bug only existed on the actual hardware.
> Three days of production serving wrong predictions
> before we figured out the CPU/GPU discrepancy."*
> — ML engineer at a computer vision company

---

## The War Story

The vision team at Apex Diagnostics builds a medical image classification model. They have a full CI pipeline: unit tests, integration tests, model evaluation against a holdout set. Everything runs on standard CPU GitHub Actions runners. The model deploys to NVIDIA A100 GPU inference servers.

In August, they deploy a new version of the preprocessing pipeline. It includes a normalization step that clips pixel values at the 99th percentile and then scales to [0, 1]. The clipping logic:

```python
upper_bound = np.percentile(image_array, 99)
clipped = np.clip(image_array, 0, upper_bound)
normalized = clipped / upper_bound
```

On CPU, this works correctly. On GPU (via CuPy), `np.clip` behavior differs for NaN values in edge cases where `upper_bound` is computed from a partially corrupt DICOM header. The GPU produces NaN outputs in those cases where CPU produces 0.0.

The CI runs on CPU: all tests pass. Production runs on GPU: for approximately 0.3% of images (those with specific DICOM header values), the model receives NaN inputs, and outputs the wrong classification with high confidence. In a medical imaging context, this is not a reporting accuracy problem — it's a patient safety issue.

The fix: run CI tests on GPU hardware, or at minimum run validation tests that execute on the same CUDA toolkit version as production. The CI pipeline needs to be accelerator-aware.

---

## What You'll Learn

- CUDA environment management in CI: matching CI and production CUDA/cuDNN versions
- GPU runners for CI: self-hosted GPU runners, cloud GPU instances, spot instance strategies
- Model compilation pipelines: TensorRT, ONNX Runtime, and TorchScript as CI steps
- Testing strategies for GPU code: unit tests on CPU, integration tests on real GPU
- Cost management: minimizing GPU CI costs while maintaining meaningful validation

---

## CUDA Environment Parity

The fundamental rule: CI must use the same CUDA toolkit version, cuDNN version, and PyTorch/TensorFlow version as production inference. Even minor version differences in CUDA can produce different numerical results for certain operations.

```dockerfile
# gpu-ci.Dockerfile — matches the production inference environment exactly

# Pin to the exact CUDA version used in production
# nvidia/cuda images: cuda-version-cudnn-version-type-os
FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

# System-level packages
RUN apt-get update && apt-get install -y \
    python3.11 python3.11-pip git wget \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA 12.1 support
# The CUDA version in the pip package must match the system CUDA version
RUN pip3 install torch==2.1.0 torchvision==0.16.0 \
    --index-url https://download.pytorch.org/whl/cu121

# Verify GPU is accessible and version matches expectations
RUN python3 -c "
import torch
assert torch.cuda.is_available(), 'CUDA not available'
assert torch.version.cuda == '12.1', f'Expected CUDA 12.1, got {torch.version.cuda}'
print(f'CUDA: {torch.version.cuda}, cuDNN: {torch.backends.cudnn.version()}')
"

WORKDIR /app
COPY requirements.txt .
RUN pip3 install -r requirements.txt
```

```yaml
# .github/workflows/gpu-ci.yml
name: GPU Integration Tests

on:
  push:
    branches: [main]
    paths:
      - 'model/**'
      - 'preprocessing/**'

jobs:
  gpu-tests:
    # Self-hosted runner with GPU attached
    # Or: use GitHub-hosted larger runners when GPU runners become available
    runs-on: [self-hosted, gpu, ubuntu-22.04]
    
    container:
      image: myregistry.io/gpu-ci:cuda12.1-pytorch2.1
      options: >-
        --gpus all
        --runtime nvidia
    
    steps:
      - uses: actions/checkout@v4

      - name: Verify GPU environment
        run: |
          nvidia-smi  # Verify GPU is accessible
          python3 -c "
          import torch
          print(f'GPU: {torch.cuda.get_device_name(0)}')
          print(f'CUDA: {torch.version.cuda}')
          print(f'cuDNN: {torch.backends.cudnn.version()}')
          "

      - name: Run GPU-specific unit tests
        run: |
          pytest tests/gpu/ \
            --device cuda \
            -v \
            # Mark tests that require GPU explicitly
            --only-gpu-tests

      - name: Validate numerical consistency (CPU vs GPU)
        run: |
          # This test catches the Apex Diagnostics bug:
          # run the same operation on both CPU and GPU,
          # verify results are within tolerance
          python3 tests/validate_cpu_gpu_consistency.py \
            --input-samples 1000 \
            --tolerance 1e-5
```

---

## Cost Management for GPU CI

GPU instances are expensive. A single A100 CI job costs $2–3 per hour. Strategies for keeping costs manageable:

```yaml
# Cost-optimized GPU CI strategy:
# 1. CPU tests on every PR (fast, cheap)
# 2. GPU tests only on main branch merges or explicit label
# 3. Spot instances for training jobs

jobs:
  # Step 1: CPU tests — runs on every PR, fast and cheap
  cpu-tests:
    runs-on: ubuntu-22.04
    steps:
      - run: pytest tests/unit/ tests/integration/ -v

  # Step 2: GPU validation — only on main branch
  gpu-validation:
    if: github.ref == 'refs/heads/main'
    runs-on: [self-hosted, gpu]
    needs: cpu-tests
    steps:
      - run: pytest tests/gpu/ --device cuda -v

  # Step 3: Training jobs — spot instances (80% cost reduction)
  training:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-22.04
    steps:
      - name: Launch spot training job on EC2
        run: |
          aws ec2 run-instances \
            --instance-type p3.2xlarge \
            --instance-market-options '{"MarketType":"spot","SpotOptions":{"MaxPrice":"0.50"}}' \
            --image-id ami-0gpu-training \
            --user-data file://training-startup.sh
```

---

## Model Compilation Pipelines: TensorRT and ONNX

For production GPU inference, models are often compiled to optimized formats (TensorRT, ONNX) that are not interchangeable across CUDA versions. The compilation must run on the same CUDA version as production:

```python
# compile_for_production.py — part of the model deployment pipeline

import tensorrt as trt
import torch

def compile_model_for_inference(
    pytorch_model_path: str,
    output_trt_path: str,
    cuda_version: str,  # Must match production
    optimization_profile: dict = None
) -> str:
    """
    Compile PyTorch model to TensorRT engine for production inference.
    
    This step must run on the same CUDA version as production.
    The compiled engine is NOT portable across CUDA versions.
    
    Returns the path to the compiled TensorRT engine.
    """
    
    # Load PyTorch model
    model = torch.load(pytorch_model_path)
    model.eval()
    
    # Export to ONNX first (intermediate representation)
    dummy_input = torch.randn(1, 3, 224, 224).cuda()
    torch.onnx.export(
        model,
        dummy_input,
        "model.onnx",
        opset_version=17,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch_size"}}  # Support variable batch sizes
    )
    
    # Compile ONNX to TensorRT engine
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)
    
    with open("model.onnx", "rb") as f:
        parser.parse(f.read())
    
    config = builder.create_builder_config()
    config.max_workspace_size = 4 * (1 << 30)  # 4GB workspace
    config.set_flag(trt.BuilderFlag.FP16)       # Enable FP16 for 2x speed on A100
    
    engine = builder.build_serialized_network(network, config)
    
    with open(output_trt_path, "wb") as f:
        f.write(engine)
    
    return output_trt_path

# CI gate: verify the TensorRT engine produces the same results as PyTorch
def validate_trt_engine(pytorch_model, trt_engine_path, test_inputs, tolerance=1e-3):
    """Verify TensorRT engine is numerically consistent with PyTorch model."""
    
    pytorch_outputs = run_pytorch(pytorch_model, test_inputs)
    trt_outputs = run_tensorrt(trt_engine_path, test_inputs)
    
    max_diff = abs(pytorch_outputs - trt_outputs).max()
    
    if max_diff > tolerance:
        raise ValueError(
            f"TensorRT engine outputs differ from PyTorch by {max_diff:.6f} "
            f"(tolerance: {tolerance}). Compilation may have introduced numerical errors."
        )
    
    print(f"TensorRT validation passed. Max diff: {max_diff:.6f}")
```

---

## Anti-Patterns

### ❌ Anti-Pattern: CPU-Only CI for GPU-Deployed Models

**What it looks like:** All CI runs on CPU. Production runs on GPU. Numerical differences between CPU and GPU implementations are never caught in CI.

**The fix:** Run integration tests and numerical consistency tests on actual GPU hardware as a CI gate. Use the same CUDA/cuDNN version as production.

---

### ❌ Anti-Pattern: Compiling TensorRT on a Different CUDA Version

**What it looks like:** The CI pipeline compiles the TensorRT engine on CUDA 11.8. Production inference servers run CUDA 12.1. The TensorRT engine is not portable across CUDA versions.

**The fix:** Compile production TensorRT engines in an environment that exactly matches the production CUDA version. This environment must be the production inference Docker image.

---

### ❌ Anti-Pattern: GPU Runners Without CUDA Version Pinning

**What it looks like:** Self-hosted GPU runner with `apt upgrade` running nightly. CUDA version may change between CI runs. A test that passed last week fails today because CUDA updated.

**The fix:** Pin the CUDA version at the container level, not the host OS level. Use Docker containers with explicit `nvidia/cuda:12.1.1-cudnn8-devel` base images for all GPU CI jobs.

---

## Chapter Summary

GPU-aware CI is the recognition that CPU simulation of GPU operations is insufficient for validating models that will serve on GPU hardware. Numerical differences in edge cases (NaN handling, FP16 rounding, CUDA operation semantics) only surface when running on the target hardware. The GPU CI pipeline must use the same CUDA version, the same cuDNN version, and the same compilation toolchain as production. Cost management (spot instances, CPU-first testing, GPU tests only on main) keeps the economics viable.
