# Chapter 7: Convolutions

## SPARK

### The Cold Open
You have built a perfect Multi-Layer Perceptron (MLP). It solves XOR, it handles tabular data flawlessly. Now you want to classify 4K images ($3840 \times 2160$ pixels). Because it's a color image, it has 3 channels (RGB). That's $3840 \times 2160 \times 3 = 24.8$ million input values. 

If your first hidden layer has just 1,000 neurons, your first weight matrix will contain **24.8 billion parameters**. That single layer requires 100GB of VRAM. It will overfit instantly. It is physically impossible to train. 

### The Uncomfortable Truth
When you use an MLP on an image, the first step is `image.view(-1)`, which flattens the 2D grid into a 1D line. By doing this, **you destroy all spatial information**. The MLP doesn't know that pixel 500 is directly above pixel 4260. It treats the pixels as completely independent features, forcing the network to relearn the concept of "up" and "down" from scratch.

### The Mental Model
Using an MLP on an image is like trying to find a face in a painting by cutting the painting into millions of tiny squares, throwing them in a bag, and examining them one by one.

Using a Convolutional Neural Network (CNN) is like taking a **magnifying glass** and sliding it across the intact painting, looking for edges, corners, and textures, one small patch at a time.

---

## FORGE

### The Dissection: The Convolutional Filter

**The Naive Approach (Dense Connections):**
Connect every input pixel to every hidden neuron. 

**The Correct Approach (Local Connectivity & Weight Sharing):**
Instead of a massive matrix, we define a small **Filter** (or Kernel), usually $3 \times 3$ or $5 \times 5$ pixels. We slide (convolve) this filter across the image. At each step, we do an element-wise multiplication and sum the results.

```mermaid
graph TD
    subgraph "The 3x3 Filter (Edge Detector)"
        F1[-1]  F2[0]  F3[1]
        F4[-2]  F5[0]  F6[2]
        F7[-1]  F8[0]  F9[1]
    end
    Image[Image Patch] --> Multiply
    Filter --> Multiply
    Multiply --> Sum[Sum]
    Sum --> FeatureMap[Feature Map Pixel]
```

**Why this is genius:**
1. **Weight Sharing:** A vertical edge detector is useful in the top-left corner, and equally useful in the bottom-right corner. By sliding the *same* filter across the whole image, we only need 9 parameters to find vertical edges anywhere, instead of millions. Translation invariance is built-in!
2. **Local Connectivity:** A pixel is heavily related to the pixels immediately touching it. It rarely cares about a pixel on the exact opposite side of the image.

### The Mechanics: Padding, Stride, and Pooling

- **Padding (P):** If you slide a $3 \times 3$ filter over a $32 \times 32$ image, the filter hangs off the edge. If you don't pad the edges with zeros, the output feature map shrinks to $30 \times 30$. Padding preserves spatial dimensions.
- **Stride (S):** How many pixels the filter moves at each step. A stride of 2 halves the output resolution.
- **Pooling (Max/Average):** A non-learnable layer that slides a window (e.g., $2 \times 2$) and takes the maximum value. It aggressively downsamples the image, forcing the network to become invariant to small translations and reducing compute for deeper layers.

---

## WIRE

### The War Room: The Tensor Shape Nightmare
**Incident Report:** You are connecting a CNN feature extractor to an MLP classifier to output 10 classes. You write the code, hit run, and get:
`RuntimeError: mat1 and mat2 shapes cannot be multiplied (32x4096 and 1024x10)`
You have no idea what `4096` is or where it came from.

**Root Cause:** As images pass through convolutions and pooling layers, their spatial dimensions ($H, W$) shrink, while the number of channels ($C$) grows. Before feeding this 3D tensor into a `nn.Linear` layer, it must be flattened. The flattened size is exactly $C \times H_{out} \times W_{out}$. If you guess this number, PyTorch will crash.

**The Fix:** 
You must know the formula to calculate output shapes after a convolution:
$$O = \frac{W - F + 2P}{S} + 1$$
Where $W$ is input size, $F$ is filter size, $P$ is padding, $S$ is stride.

```python
import torch
import torch.nn as nn

class SimpleCNN(nn.Module):
    def __init__(self):
        super().__init__()
        # Input: 3 channels, 32x32 image
        self.conv1 = nn.Conv2d(in_channels=3, out_channels=16, kernel_size=3, padding=1)
        # Output: 16 channels, 32x32 (padding=1 preserves size)
        
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        # Output: 16 channels, 16x16 (pooling halves size)
        
        # We must calculate the flattened size: 16 * 16 * 16 = 4096
        self.fc1 = nn.Linear(16 * 16 * 16, 10)
        
    def forward(self, x):
        x = self.pool(torch.relu(self.conv1(x)))
        x = x.view(x.size(0), -1) # Flatten: [Batch, 4096]
        return self.fc1(x)
```

### The Lab: Receptive Fields
The **Receptive Field** is the area of the original input image that a particular neuron "sees".
In layer 1, a neuron looking at a $3 \times 3$ output sees exactly $3 \times 3$ pixels. 
In layer 2, if we apply another $3 \times 3$ filter, that neuron is looking at $3 \times 3$ outputs of layer 1, meaning it actually "sees" a $5 \times 5$ patch of the original image. As you go deeper, neurons represent larger and larger concepts (from edges $\rightarrow$ to eyes $\rightarrow$ to faces).

### The Loose Thread
We know how to build a CNN. So if a 5-layer CNN is good, a 150-layer CNN should be incredible, right? But when engineers first tried stacking 100 convolutional layers, the networks completely refused to learn. The gradients vanished into dust before reaching the input. In the next chapter, we explore how ResNet hacked the gradient flow to build impossibly deep networks.