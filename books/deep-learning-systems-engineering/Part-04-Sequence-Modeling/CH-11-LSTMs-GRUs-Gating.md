# Chapter 11: LSTMs, GRUs & Gating

## SPARK

### The Cold Open
You are using a Vanilla RNN to analyze movie reviews. 
Review: *"The cinematography was breathtaking, the actors were incredible, the score was moving, but ultimately, the plot was terrible."* 
The true sentiment is Negative. But your RNN predicts Positive. 
Why? Because the RNN's memory is a leaky bucket. By the time it processes the word "terrible" at step 20, the hidden state has been overwhelmingly diluted by the positive words from steps 1 through 10. It cannot bridge long-term dependencies.

### The Uncomfortable Truth
You cannot force a neural network to remember something by multiplying it over and over again. Matrix multiplication alters the vector. To actually "remember" data for 100 steps, you need a mechanism that allows information to flow through the network *unaltered*, just like a ResNet skip connection. 

### The Mental Model
Imagine a conveyor belt running through a factory. 
A Vanilla RNN dumps all its new material directly onto the belt, crushing whatever was already there.
Long Short-Term Memory (LSTM) uses **Gates**. It is a conveyor belt equipped with selective robotic arms:
- The **Forget Arm** looks at the belt and removes garbage.
- The **Input Arm** decides if the new material is worth placing on the belt.
- The **Output Arm** reads what's on the belt to make a final decision.

---

## FORGE

### The Dissection: The LSTM Cell

The core innovation of the LSTM is the separation of state. Instead of just one hidden state ($h_t$), it has two:
1. **Hidden State ($h_t$):** The short-term memory (what the network outputs at this exact step).
2. **Cell State ($C_t$):** The long-term memory (the conveyor belt).

**The Gates (The Controllers):**
All gates use a Sigmoid activation, outputting a value between $0.0$ (completely blocked) and $1.0$ (completely open).

1. **Forget Gate ($f_t$):** Decides what to delete from the old cell state $C_{t-1}$. 
   $f_t = \sigma(W_f \cdot [h_{t-1}, x_t] + b_f)$
2. **Input Gate ($i_t$):** Decides which new information to add.
   $i_t = \sigma(W_i \cdot [h_{t-1}, x_t] + b_i)$
3. **Candidate Update ($\tilde{C}_t$):** Creates the new information using `tanh`.
4. **Output Gate ($o_t$):** Decides what part of the Cell State should be exposed as the new Hidden State $h_t$.

**The Highway (The Cell State Update):**
$$C_t = f_t \times C_{t-1} + i_t \times \tilde{C}_t$$
*Look at that equation.* If the Forget Gate $f_t$ is 1, and the Input Gate $i_t$ is 0, then $C_t = C_{t-1}$. The information is passed forward perfectly, with zero alteration, preventing the vanishing gradient!

### The GRU: The Systems Optimization
LSTMs are powerful but computationally heavy (they require 4 separate matrix multiplications per time step). 
The **Gated Recurrent Unit (GRU)** is an engineering compromise. It merges the Cell State and Hidden State into one, and combines the Forget and Input gates into a single "Update" gate. It is 25% faster to train, uses less VRAM, and achieves 99% of the performance of an LSTM on most tasks.

---

## WIRE

### The War Room: "Why is it so slow?"
**Incident Report:** You switch from a CNN to an LSTM. Your training time jumps from 2 hours to 4 days. You check GPU utilization: it's sitting at 15%. 

**Root Cause:** LSTMs are inherently sequential. You cannot compute step $t=5$ until you have finished computing $t=4$. While CNNs process an entire image in parallel using thousands of CUDA cores simultaneously, the LSTM forces the GPU to wait for the `for` loop to execute. The massive parallel power of your A100 is completely bottlenecked by sequential data dependencies.

**The Fix:** 
You cannot parallelize the time dimension in an LSTM. The only way to increase GPU utilization is to increase the **Batch Size** (processing many independent sequences in parallel) or use highly optimized C++ kernels (like `torch.nn.LSTM` which calls Nvidia's cuDNN backend, rather than writing the loop yourself in Python).

### The Lab: Dropping into PyTorch

```python
import torch
import torch.nn as nn

# Never write the LSTM loop manually in production.
# Use PyTorch's highly optimized C++ implementation.
lstm = nn.LSTM(input_size=10, hidden_size=20, num_layers=2, batch_first=True)

# sequence shape: [Batch, Seq_Len, Features]
sequence = torch.randn(32, 50, 10) 

# Pass the sequence in. 
# out: the hidden states for every time step
# (h_n, c_n): the final hidden and cell states
out, (h_n, c_n) = lstm(sequence)

print("Output shape:", out.shape) # [32, 50, 20]
print("Final Cell State shape:", c_n.shape) # [2 (layers), 32, 20]
```

### The Loose Thread
LSTMs solved the memory problem. We can now read a sequence and compress its meaning into a single, dense vector ($h_n$). We can use this vector to translate languages (Seq2Seq). But compressing a 100-word sentence into a single 512-dimensional vector is like trying to summarize "War and Peace" on a post-it note. The information bottleneck is fatal. We need a way for the network to look back at the *entire* input sequence while generating the output. We need Attention.