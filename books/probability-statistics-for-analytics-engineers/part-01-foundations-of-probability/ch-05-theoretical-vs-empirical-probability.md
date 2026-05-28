# CH-05 — Theoretical vs Empirical Probability

## 1. Intuition-First Explanation
How do we know the probability of a coin flip is 0.5?
*   **Theoretical Approach:** "A coin has two sides. They are identical. Therefore, each must have a 50% chance." We use logic and symmetry.
*   **Empirical Approach:** "I flipped this coin 1,000 times and it came up heads 503 times. Therefore, the probability is roughly 0.503." We use data and observation.

Theoretical probability is what **should** happen in a perfect world. Empirical probability (also called Experimental probability) is what **actually** happens. In Analytics Engineering, we almost always deal with Empirical probability because real-world systems (like user behavior) don't have "neat" theoretical formulas.

## 2. Mathematical Derivations
### Theoretical Probability
Based on the assumption of equally likely outcomes in a sample space.
$$P(E)_{theory} = \frac{n(E)}{n(S)}$$

### Empirical Probability
Based on the relative frequency of an event after many trials ($n$).
$$P(E)_{empirical} = \lim_{n \to \infty} \frac{\text{Number of times } E \text{ occurred}}{n}$$

**The Law of Large Numbers (LLN):**
As the number of trials ($n$) increases, the empirical probability converges to the theoretical probability. 
$$P(E)_{empirical} \to P(E)_{theory} \text{ as } n \to \infty$$

## 3. Visual Mental Models
Imagine a line graph where the x-axis is "Number of Flips" and the y-axis is "Percentage of Heads."

```mermaid
graph LR
    Start[0 trials] --> Fluctuating[1-100 trials: Chaotic fluctuations]
    Fluctuating --> Stabilizing[100-1000 trials: Smoothing out]
    Stabilizing --> Final[10,000+ trials: Approaches 0.5]
```

Early on, the "luck of the draw" causes huge swings. Over time, the randomness cancels itself out, and the true underlying probability reveals itself.

## 4. Coding Implementation
Let's use a **Monte Carlo Simulation** to see the Law of Large Numbers in action.

```python
import numpy as np
import matplotlib.pyplot as plt

def run_experiment(trials):
    # Theoretical probability is 0.5 (fair coin)
    flips = np.random.randint(0, 2, size=trials)
    empirical_p = np.mean(flips)
    return empirical_p

# Running experiments with increasing trial counts
trial_counts = np.logspace(1, 5, num=50, dtype=int)
results = [run_experiment(n) for n in trial_counts]

plt.figure(figsize=(10, 6))
plt.semilogx(trial_counts, results, marker='o', linestyle='', alpha=0.6)
plt.axhline(y=0.5, color='r', linestyle='--', label='Theoretical P=0.5')
plt.title("Empirical Probability Converging to Theoretical")
plt.xlabel("Number of Trials (Log Scale)")
plt.ylabel("Empirical Probability")
plt.legend()
plt.grid(True, which="both", ls="-")
plt.show()
```

## 5. Solved Examples
**Problem:** You roll a die 60 times. You get the number '6' twelve times.
1. What is the theoretical probability of rolling a '6'?
2. What is the empirical probability based on your experiment?
**Solution:**
1. Theoretical: $1/6 \approx \mathbf{0.1667}$.
2. Empirical: $12/60 = 0.2 = \mathbf{0.2000}$.
The difference ($0.0333$) is due to sampling noise.

## 6. Interview Questions
1.  **What is the Law of Large Numbers?**
    *   *Answer:* It states that as you repeat an experiment more times, the average of the results (empirical probability) will get closer to the expected value (theoretical probability).
2.  **When would you use Empirical probability instead of Theoretical?**
    *   *Answer:* Whenever the system is too complex to model with simple logic (e.g., stock market prices, user click-through rates, or weather).

## 7. Practice Questions
1.  If you flip a coin 10 times and get 8 heads, does this disprove that the theoretical probability is 0.5?
2.  Calculate the empirical probability of a "Success" if you observe 450 successes in 1,000 trials.

## 8. Challenge Problems
**The Gambler's Fallacy:** If a coin has come up Heads 10 times in a row, is it "due" to come up Tails next to satisfy the Law of Large Numbers? Why or why not? (Hint: Think about Independence from CH-04).

## 9. Common Mistakes
*   **Small Sample Sizes:** Drawing strong conclusions from a small amount of data (e.g., "This ad has a 100% click rate" after only 1 person saw it).
*   **Mistaking LLN for "Evening Out":** Thinking that the universe "forces" a specific outcome to happen to balance things out. The LLN works because of **dilution**, not correction.

## 10. Revision Notes
*   **Theoretical:** Derived from logic/math.
*   **Empirical:** Derived from data/observation.
*   **LLN:** More data = More accuracy.
*   **Sampling Error:** The difference between empirical and theoretical.

## 11. Analytics Applications
*   **Conversion Rate Estimation:** We don't have a formula for "Why a user buys." We observe 10,000 users, see 300 buy, and estimate the probability as 3%.
*   **Monte Carlo Simulations:** Used in finance and engineering to estimate the probability of complex events (like a bridge collapsing or a portfolio losing money) by simulating millions of "random" scenarios.
*   **Quality Control:** Testing a small batch of products to estimate the "Defect Rate" of the entire factory.
