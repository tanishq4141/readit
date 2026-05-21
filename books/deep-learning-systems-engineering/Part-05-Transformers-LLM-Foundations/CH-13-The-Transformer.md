# Chapter 13: The Transformer

## SPARK

### The Cold Open
It’s 2017. You are trying to train an AI to translate a dataset of 30 million sentences. Using LSTMs on an 8-GPU cluster, it will take 2 months because the words must be processed one at a time. The sequential nature of recurrence is the ultimate hardware bottleneck. You cannot utilize the 5,000 parallel cores on your GPU.

### The Uncomfortable Truth
We used RNNs/LSTMs because we thought time and sequence required a sequential loop. But a sequence is just a set of objects with an index attached to them. If you tell a network "This word is at position 1" and "This word is at position 2", you don't need to process them in order. You can process them all at the exact same time.

### The Mental Model
**RNNs** are like a **bucket brigade** passing water (information) down a line. Person 5 cannot act until Person 4 hands them the bucket.
**Transformers** are like a **conference room** where everyone is shouting at once. To make sense of it, everyone has a perfectly tuned ear (Self-Attention) that mathematically filters out the noise and only listens to the specific people whose information is relevant to them.

---

## FORGE

### The Dissection: Self-Attention and Q/K/V

In 2017, Google published "Attention Is All You Need." They threw away the LSTM and built a network entirely out of dense layers and Attention. 

**Self-Attention:**
Instead of a Decoder looking at an Encoder, Self-Attention is a sentence looking at *itself*. 
Sentence: "The bank of the river."
When processing the word "bank", the network looks at all other words to figure out if it means "financial institution" or "edge of a river". It will pay high attention to "river", altering the mathematical representation of "bank" to mean the geographical feature.

**The Q/K/V Engine:**
For every word, the network creates three vectors using three different `nn.Linear` layers:
1. **Query (Q):** What I am looking for. (e.g., "I am an adjective looking for my noun.")
2. **Key (K):** What I am. (e.g., "I am a noun representing geography.")
3. **Value (V):** What I actually mean.

The magic formula:
$$ \text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V $$

**Multi-Head Attention:**
Instead of one Attention mechanism, Transformers use 8, 12, or 96 parallel "Heads". One head might look for grammar. Another head might look for rhyming words. Another head tracks character names. They all run simultaneously.

### Positional Encoding
If we process all words simultaneously, the sentence "Dog bites man" is mathematically identical to "Man bites dog". To fix this, we inject a positional signal. We take the word embedding, and we literally add a high-frequency sine/cosine wave to it based on its position in the sentence. The network learns to read these frequencies like a barcode to know the word's location.

---

## WIRE

### The War Room: The $O(N^2)$ Memory Explosion
**Incident Report:** You train a Transformer on paragraphs of 512 words. It fits perfectly in your 24GB GPU. You decide to train it on whole documents of 4,096 words. You increase the sequence length by 8x. You expect memory to increase by 8x. Instead, your GPU instantly OOMs, requiring 64x more memory.

**Root Cause:** Look at the formula: $Q \times K^T$.
If you have $N$ words, $Q$ is $[N, d]$ and $K^T$ is $[d, N]$.
The resulting Attention Matrix is $[N, N]$. 
Every word must compute a score with every other word. 
If $N=512$, the matrix has 262,144 elements.
If $N=4096$, the matrix has 16.7 million elements. 
The memory and compute complexity of Attention scales **quadratically** ($O(N^2)$) with sequence length. 

**The Fix:** 
This quadratic bottleneck is the single biggest engineering problem in modern AI. Solutions include:
1. **FlashAttention:** A hardware-aware algorithm that tiles the computation in SRAM to avoid reading/writing the massive $N \times N$ matrix to the slow HBM (High Bandwidth Memory) on the GPU.
2. **Sliding Window / Sparse Attention:** Only allowing words to look at their 100 closest neighbors, rather than the whole document.

### The Lab: The Transformer Block

```python
import torch
import torch.nn as nn

class TransformerBlock(nn.Module):
    def __init__(self, d_model, num_heads):
        super().__init__()
        # The Self-Attention Engine
        self.attention = nn.MultiheadAttention(embed_dim=d_model, num_heads=num_heads)
        
        # The Feed-Forward Engine (Process the new contextualized representations)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_model * 4),
            nn.ReLU(),
            nn.Linear(d_model * 4, d_model)
        )
        
        # Layer Normalization (Crucial for deep Transformers)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        
    def forward(self, x):
        # 1. Self Attention with a ResNet-style Skip Connection
        # Note: PyTorch's MultiheadAttention expects Q, K, V
        attn_out, _ = self.attention(query=x, key=x, value=x)
        x = self.norm1(x + attn_out)
        
        # 2. Feed Forward with another Skip Connection
        ffn_out = self.ffn(x)
        x = self.norm2(x + ffn_out)
        
        return x

# Sequence of 10 words, batch size 1, 512 dimensions
words = torch.randn(10, 1, 512) 
block = TransformerBlock(d_model=512, num_heads=8)
print("Output shape:", block(words).shape) # [10, 1, 512]
```

### The Loose Thread
The architecture is solved. We can process sequences in parallel. We can scale to billions of parameters. But an architecture is an empty brain. How do we actually train it to understand human language? How did we get from the Transformer paper in 2017 to ChatGPT? In the final chapter, we look at the engineering of foundational LLMs, Tokenization, and Inference at hyperscale.