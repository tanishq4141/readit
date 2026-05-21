# Chapter 14: Transformers in Practice

## SPARK

### The Cold Open
You are tasked with building a chatbot for your company. You read the Transformer paper. You write the code perfectly. You download a dataset of 100,000 customer support transcripts. You train the model for a week. 

When you test it, the model is grammatically confused, lacks common sense, and hallucinates facts. It cannot hold a basic conversation. 
You realize that 100,000 transcripts is not enough to teach a machine English from scratch. To teach it English, you need to read the entire internet. And training a model on the internet costs $10,000,000 in GPU compute. 

### The Uncomfortable Truth
**You will never train a foundational model from scratch.** 
The era of training architectures on local datasets is over. The entire industry relies on massive pre-trained checkpoints (Llama, Mistral, GPT, BERT) created by hyperscalers. Your job as an AI engineer is not architecture design; your job is orchestration, fine-tuning, tokenization, and scaling inference.

### The Mental Model
Training an LLM is like **raising a scholar**.
1. **Pre-training:** You lock them in a library for 20 years to read every book ever written. They learn grammar, facts, reasoning, and logic. (Done by OpenAI/Meta).
2. **Fine-Tuning:** You send them to medical school for 6 months so they can learn to speak like a doctor. (Done by you).

---

## FORGE

### The Dissection: The LLM Ecosystem

Transformers split into two dominant families based on the original architecture:

**1. The Encoder-Only Family (BERT):**
BERT uses only the left half of the Transformer. Because it uses Self-Attention across the *entire* sentence at once, it can look forward and backward in time. 
*Task:* Fill in the blank ("The cat sat on the [MASK]").
*Use Case:* Text classification, search, sentiment analysis. Excellent at understanding text, terrible at generating it.

**2. The Decoder-Only Family (GPT, Llama):**
GPT uses only the right half. Crucially, it uses **Causal Masking**. When processing word 3, the Attention matrix physically blocks it from looking at word 4. It can only look backward. 
*Task:* Predict the next word. 
*Use Case:* Text generation, chatbots, reasoning. 

### Tokenization: The Hidden Systems Bottleneck
Neural networks do not read strings like "Hello". They read numbers. 
*The Naive Approach:* Map every word to a number (Word-level). Problem: "Cat" and "Cats" are completely different numbers. The dictionary becomes infinitely large.
*The Sub-word Approach (BPE / Byte-Pair Encoding):* 
We break words into chunks. "Unbelievable" becomes `["Un", "believ", "able"]`. 
This creates a fixed dictionary (e.g., 32,000 tokens) that can represent literally any string of text, including code and typos, without Out-Of-Vocabulary (OOV) errors.

*Systems note:* Tokenization is executed on the CPU, in Python or Rust, before tensors hit the GPU. If your tokenizer is slow, your GPU starves.

---

## WIRE

### The War Room: The Inference Latency Nightmare (KV Cache)
**Incident Report:** You deploy an open-source 7B parameter LLM (like Llama-2). When a user sends a prompt, the model generates the first word instantly. But as the response gets longer, the generation slows down exponentially. By word 100, the server is crawling. 

**Root Cause:** To generate word 101, the Decoder needs to attend to all 100 previous words. 
In a naive implementation, you pass all 100 words through the massive $Q, K, V$ linear layers, compute attention, and get word 101. 
To generate word 102, you pass 101 words through the massive layers again. You are redundantly recalculating the Keys and Values for the first 100 words *every single time*.

**The Fix (KV Caching):** 
In production, we use a **KV Cache**. We store the Keys ($K$) and Values ($V$) of previously generated tokens in the GPU's memory. 
When generating word 102, we *only* pass word 101 through the network to generate its $Q, K, V$. We query this single $Q$ against the cached $K$'s from the past. 
*The Tradeoff:* This makes generation fast, but the KV Cache eats massive amounts of VRAM. A large context window can require more VRAM for the KV cache than for the model weights themselves! This is why production systems use optimizations like PagedAttention (vLLM).

### The Final Lab: The Generative Loop
How text is actually born in production.

```python
import torch
import torch.nn.functional as F

# Pseudocode for a production generation loop
def generate(model, tokenizer, prompt, max_tokens=50, temperature=0.7):
    # 1. CPU: Tokenize the text into integers
    input_ids = tokenizer.encode(prompt).to('cuda') # [1, Seq_Len]
    
    # We will build up the sequence here
    generated = input_ids
    
    with torch.no_grad(): # NEVER forget this during inference
        for _ in range(max_tokens):
            # 2. Forward pass (In reality, we use KV caching here)
            logits = model(generated) 
            
            # 3. Get the predictions for the NEXT token
            next_token_logits = logits[0, -1, :] 
            
            # 4. Apply Temperature (higher = more random, lower = more strict)
            scaled_logits = next_token_logits / temperature
            probs = F.softmax(scaled_logits, dim=-1)
            
            # 5. Sample from the probability distribution
            next_token = torch.multinomial(probs, num_samples=1)
            
            # 6. Append to our sequence and repeat
            generated = torch.cat((generated, next_token.unsqueeze(0)), dim=1)
            
            # 7. Stop if the model generated an End-Of-Sequence (EOS) token
            if next_token.item() == tokenizer.eos_token_id:
                break
                
    # 8. CPU: Decode integers back to text
    return tokenizer.decode(generated[0])
```

### The End of the Beginning
You now understand the systems that power modern AI. You know why models memorize data, why deep networks suffer from vanishing gradients, why RNNs forget, and why Attention requires quadratic memory. 

You are no longer treating deep learning as an academic abstraction or a black box API. You are looking at the tensors, the memory buffers, and the computational graphs. 

You are ready to build.