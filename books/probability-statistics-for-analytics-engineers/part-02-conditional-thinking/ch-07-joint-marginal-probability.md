# CH-07 — Joint & Marginal Probability

## 1. Intuition-First Explanation
When we move from one event to multiple events, we need a way to describe their relationship in a single view. 

*   **Joint Probability:** The probability that $A$ **and** $B$ happen together. It's the "intersection" in action.
*   **Marginal Probability:** The probability of just one event $A$ happening, regardless of what $B$ does. It's called "marginal" because in a table, these probabilities are found in the "margins" (the edges).

Think of a spreadsheet of customers. The **Joint** probability tells you the chance a customer is "from New York AND bought a subscription." The **Marginal** probability tells you simply "What percentage of our customers are from New York?"

## 2. Mathematical Derivations
### Joint Probability ($P(A \cap B)$)
For discrete variables, we often use a **Contingency Table** (or Joint Probability Table).
The sum of all joint probabilities in the table must equal 1.
$$\sum_{i} \sum_{j} P(A_i \cap B_j) = 1$$

### Marginal Probability ($P(A)$)
We find the marginal probability by summing across the other variable(s). This is called **Marginalization**.
$$P(A_i) = \sum_{j} P(A_i \cap B_j)$$

**The Relationship:**
$P(A \cap B) = P(A \mid B) P(B)$
This links Joint, Marginal, and Conditional probability into a single coherent system.

## 3. Visual Mental Models
The best way to visualize these is a **Probability Grid**.

| | $B_1$ | $B_2$ | **Marginal $P(A)$** |
| :--- | :--- | :--- | :--- |
| **$A_1$** | $P(A_1 \cap B_1)$ | $P(A_1 \cap B_2)$ | **$P(A_1)$** |
| **$A_2$** | $P(A_2 \cap B_1)$ | $P(A_2 \cap B_2)$ | **$P(A_2)$** |
| **Marginal $P(B)$**| **$P(B_1)$** | **$P(B_2)$** | **1.0** |

*   **Cells (Joint):** The specific intersections.
*   **Totals (Marginal):** The "summary" of each row/column.

## 4. Coding Implementation
Using `pandas` to create a probability table from raw data.

```python
import pandas as pd

# Raw Data: User Device vs Subscription Status
data = {
    'Device': ['Mobile', 'Desktop', 'Mobile', 'Mobile', 'Desktop'],
    'Subscribed': ['Yes', 'No', 'No', 'Yes', 'No']
}
df = pd.DataFrame(data)

# 1. Create a Cross-tabulation (Counts)
ct = pd.crosstab(df['Device'], df['Subscribed'])

# 2. Convert to Joint Probability Table
joint_prob = ct / len(df)
print("--- Joint Probability Table ---")
print(joint_prob)

# 3. Calculate Marginal Probabilities
marginal_device = joint_prob.sum(axis=1)
marginal_sub = joint_prob.sum(axis=0)

print("\n--- Marginal (Device) ---")
print(marginal_device)
print("\n--- Marginal (Subscribed) ---")
print(marginal_sub)
```

## 5. Solved Examples
**Problem:** Given the following joint probabilities:
$P(\text{Rain} \cap \text{Delayed}) = 0.1$, $P(\text{No Rain} \cap \text{Delayed}) = 0.2$.
What is the Marginal probability of a Delay?
**Solution:**
$P(\text{Delayed}) = P(\text{Rain} \cap \text{Delayed}) + P(\text{No Rain} \cap \text{Delayed})$
$P(\text{Delayed}) = 0.1 + 0.2 = \mathbf{0.3}$.

## 6. Interview Questions
1.  **How do you calculate Marginal Probability from a Joint Distribution?**
    *   *Answer:* You "sum out" (marginalize) the variable(s) you are not interested in.
2.  **What is the "Chain Rule" of probability?**
    *   *Answer:* It's the expansion of joint probability: $P(A, B, C) = P(A) P(B \mid A) P(C \mid A, B)$. This is crucial for understanding how modern AI models generate sequences of text.

## 7. Practice Questions
1.  In a $2\times2$ joint table, if you know 3 of the joint probabilities, can you find the 4th?
2.  $P(A) = 0.5, P(B) = 0.4$. If $A$ and $B$ are independent, what is their joint probability $P(A \cap B)$?

## 8. Challenge Problems
**The Sum-Rule Paradox:** If you marginalize over a "hidden" variable that actually influences the outcome (a confounder), can your marginal probability be misleading? (Look up **Simpson's Paradox**).

## 9. Common Mistakes
*   **Confusing Joint with Conditional:** $P(A \cap B)$ is "Both happen out of everyone." $P(A \mid B)$ is "A happens out of those who did B."
*   **Summation Errors:** Forgetting that marginals must sum to 1 only if they cover the *entire* sample space.

## 10. Revision Notes
*   **Joint:** Both together. $P(A, B)$.
*   **Marginal:** One alone. $P(A)$.
*   **Marginalization:** Summing across rows or columns to simplify a table.

## 11. Analytics Applications
*   **Modern Research — Multi-modal AI:** Models like CLIP (which connects images and text) are trained by maximizing the **Joint Probability** of an image and its correct caption while minimizing it for incorrect ones.
*   **Customer Segmentation:** We use joint probabilities to find "Niche" segments (e.g., $P(\text{Age: 18-24} \cap \text{Interests: Gardening})$).
*   **Matrix Factorization:** Used in Netflix's recommendation engine to decompose a giant joint probability matrix (Users $\times$ Movies) into smaller latent factors.
