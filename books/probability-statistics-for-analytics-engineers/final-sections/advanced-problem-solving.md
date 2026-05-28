# ADVANCED PROBLEM SOLVING

## Overview
This section contains mixed, complex problems that require combining multiple concepts from across the book. These represent the "Hard" difficulty level in technical interviews or real-world analytics edge cases.

## Problem 1: The Flawed A/B Test (Simpson's Paradox)
**Scenario:** You run an A/B test for a new checkout page. 
*   Overall, Variant B has a higher conversion rate than Control A (5.5% vs 5.0%).
*   However, when you segment the data by device (Mobile vs Desktop), Control A has a higher conversion rate on Mobile (4% vs 3%) AND on Desktop (8% vs 7%).
**Question:** How is this mathematically possible, and which variant should you ship?

**Solution & Breakdown:**
This is **Simpson's Paradox**. It happens when a "lurking variable" (Device Type) is unevenly distributed between the groups. 
*   Mathematically, Variant B likely had a much higher proportion of its traffic come from Desktop (the high-converting platform), artificially inflating its overall average.
*   **The Fix:** You must look at the marginal probabilities (CH-07). Because the test was not properly randomized across devices, the overall result is invalid. You should ship **Control A**, because it performs better on *every* individual platform. 

## Problem 2: The E-commerce Funnel (Markov Chains & Geometric)
**Scenario:** A user visits a site. At each step, they have a 50% chance of proceeding to the next step and a 50% chance of dropping off. The steps are: Home $\to$ Product $\to$ Cart $\to$ Checkout $\to$ Success.
**Question:** What is the probability a user who lands on the Home page eventually makes a purchase? If they make it to the Cart, what is the probability they purchase?

**Solution & Breakdown:**
1.  **Home to Success:** This requires 4 successful transitions in a row. Since they are independent (implied by the 50% fixed rate), we multiply: $P(\text{Success}) = 0.5 \times 0.5 \times 0.5 \times 0.5 = 0.5^4 = \mathbf{0.0625}$ (6.25%).
2.  **Cart to Success:** This is Conditional Probability (CH-06). Given they are at the Cart, they only need 2 more successful transitions (Checkout $\to$ Success). $P(\text{Success} \mid \text{Cart}) = 0.5 \times 0.5 = \mathbf{0.25}$ (25%).
*Note: The system is "Memoryless," so the fact that they survived the first two steps doesn't change the 50% probability of the remaining steps.*

## Problem 3: The Rare Bug (Poisson vs Binomial)
**Scenario:** A massive codebase has exactly 10,000 lines of code. The probability of any single line containing a critical bug is $0.0001$. 
**Question:** What is the probability that the codebase contains exactly 2 critical bugs? Calculate it using the exact method and an approximation.

**Solution & Breakdown:**
1.  **Exact Method (Binomial):** Let $X \sim B(n=10000, p=0.0001)$. 
    $$P(X=2) = \binom{10000}{2} (0.0001)^2 (0.9999)^{9998}$$
    This is computationally heavy and difficult to calculate by hand.
2.  **Approximation (Poisson):** Since $n$ is very large and $p$ is very small, we use the Poisson approximation (CH-25).
    $$\lambda = n \times p = 10000 \times 0.0001 = 1.0$$
    $$P(X=2) = \frac{e^{-1} 1^2}{2!} = \frac{0.3678}{2} \approx \mathbf{0.1839}$$
    The approximation is nearly identical to the exact binomial calculation but much faster to compute.

## Problem 4: The Bayes Update (Sequential Evidence)
**Scenario:** An anomaly detection system (Prior $P(\text{Attack}) = 0.01$) receives a red flag from Sensor 1 (True Positive Rate = 0.90, False Positive Rate = 0.05). It updates its belief. One minute later, it receives an independent red flag from Sensor 2 (TPR = 0.80, FPR = 0.10).
**Question:** What is the final probability of an attack?

**Solution & Breakdown (Iterative Bayes):**
*   **Step 1 (Sensor 1):** Calculate the first Posterior (CH-09).
    $P(\text{Attack} \mid \text{S1}) = \frac{0.90 \times 0.01}{(0.90 \times 0.01) + (0.05 \times 0.99)} = \frac{0.009}{0.009 + 0.0495} = \frac{0.009}{0.0585} \approx \mathbf{0.1538}$.
*   **Step 2 (Sensor 2):** Use the Posterior from Step 1 as the **New Prior** ($0.1538$).
    $P(\text{Attack} \mid \text{S1}, \text{S2}) = \frac{0.80 \times 0.1538}{(0.80 \times 0.1538) + (0.10 \times 0.8462)} = \frac{0.1230}{0.1230 + 0.0846} = \frac{0.1230}{0.2076} \approx \mathbf{0.5925}$.
*   **Takeaway:** A single "90% accurate" sensor only raised the probability to 15%. But a second, weaker sensor raised it to nearly 60%. This sequential updating is how modern AI systems build confidence over time.
