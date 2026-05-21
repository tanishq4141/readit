# Chapter 9: Transfer Learning & CNN Applications

## SPARK

### The Cold Open
A startup hires you to build an app that classifies 50 different species of rare birds. They hand you the dataset: 500 images total (10 per species). 
You remember the lessons of the past. You build a ResNet-50. You train it on the 500 images. It severely overfits. You add massive dropout, weight decay, and data augmentation. It still fails to learn anything meaningful because 10 images are simply not enough to teach a network what a "beak" or a "feather" looks like.

### The Uncomfortable Truth
In modern AI engineering, **you almost never train an architecture from scratch.** Training a ResNet-50 on ImageNet (1.2 million images) takes immense compute. 
The uncomfortable truth is that you don't build brains anymore; you perform brain surgery. You download a brain that has already spent thousands of GPU hours learning what the visual world looks like, and you just retrain its vocal cords to speak your specific vocabulary.

### The Mental Model
Imagine you need to hire someone to inspect rare bird photos. 
Option A: You adopt a newborn baby, lock them in a room, and only ever show them 500 photos of rare birds. They will have no concept of lighting, 3D space, or biology.
Option B: You hire an adult who has lived in the world for 30 years and has seen millions of animals, objects, and textures. You show them the 500 bird photos. They learn instantly.

Transfer learning is Option B.

---

## FORGE

### The Dissection: Feature Extractors vs. Classifiers

A CNN is logically split into two parts:
1. **The Feature Extractor:** The convolutional layers (the backbone). It takes pixels and turns them into a high-density vector of concepts (e.g., `[has_feathers, has_yellow_beak, ...]`).
2. **The Classifier:** The final Multi-Layer Perceptron (the head). It takes the concept vector and outputs the class probabilities.

If a model is trained on ImageNet, its feature extractor knows how to find edges, textures, eyes, and fur. These features are universally applicable to almost any image. Only the *classifier* is specific to ImageNet's 1,000 classes.

**The Strategy (Fine-Tuning):**
1. Download a pre-trained ResNet.
2. Chop off the final `Linear` layer (which outputs 1,000 classes).
3. Attach a new `Linear` layer that outputs 50 classes.
4. **Freeze** the feature extractor (set `requires_grad = False`). 
5. Train *only* the new classifier on your small dataset.

Once the classifier is decent, you can optionally **unfreeze** the top few convolutional layers and train the whole system with a tiny learning rate to fine-tune the features to your specific domain.

---

## WIRE

### The War Room: "Why is the pre-trained model performing so badly?"
**Incident Report:** You download a PyTorch pre-trained ResNet. You pass your images into it. The predictions are complete garbage, worse than random.

**Root Cause:** You forgot the normalization constants. When Google trained ResNet on ImageNet, they normalized every image using a specific Mean and Standard Deviation (`mean=[0.485, 0.456, 0.406]`, `std=[0.229, 0.224, 0.225]`). The network physically expects inputs in this distribution. If you pass your images scaled from 0-1 without this exact normalization, the activations will blow up.

**The Fix:** Always use the exact preprocessing pipeline that the original model authors used.

### The Lab: Brain Surgery in PyTorch

```python
import torch
import torch.nn as nn
import torchvision.models as models

# 1. Download the pre-trained brain
# weights=models.ResNet18_Weights.DEFAULT pulls the ImageNet weights
model = models.resnet18(weights=models.ResNet18_Weights.DEFAULT)

# 2. Freeze the feature extractor (Freeze the brain)
for param in model.parameters():
    param.requires_grad = False

# 3. Replace the head
# model.fc is the final fully connected layer in ResNet
num_features = model.fc.in_features 

# By default, new layers have requires_grad=True
model.fc = nn.Linear(num_features, 50) 

# 4. Pass ONLY the classifier parameters to the optimizer!
# If you pass model.parameters(), it will complain about frozen gradients.
optimizer = torch.optim.Adam(model.fc.parameters(), lr=0.001)

# Now train as normal...
```

### The Loose Thread
CNNs are incredible at processing a fixed 2D grid. But what if your input doesn't have a fixed size? What if your input is a sentence containing 5 words, and the next input is a paragraph containing 500 words? You can't use a fixed `nn.Linear` or `nn.Conv2d` on variable-length text. We need a network that can loop over time. We are entering the domain of Sequence Modeling and the Recurrent Neural Network.