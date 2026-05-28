# INTERVIEW PREPARATION

## Overview
Technical interviews for Data Science, Analytics Engineering, and Machine Learning roles almost always include a dedicated Probability and Statistics round. This section compiles the highest-yield topics, common traps, and behavioral frameworks needed to pass these interviews at top-tier tech companies.

## 1. The "Big Three" Probability Paradigms
Interviewers test your ability to translate a word problem into the correct mathematical framework. You must be able to instantly recognize which of the "Big Three" applies:

### A. Combinatorics (Counting)
*   **The Clue:** Problems involving cards, dice, drawing balls from urns, or arranging items.
*   **The Framework:** $P(E) = \frac{\text{Favorable Outcomes}}{\text{Total Outcomes}}$.
*   **Key Skills:** Combinations ($nCr$), Permutations ($nPr$), and the Rule of Product.
*   **Classic Trap:** Forgetting whether the draw is *with* or *without* replacement.

### B. Conditional Probability & Bayes
*   **The Clue:** The problem gives you "base rates" and then introduces "new information" or a "test result."
*   **The Framework:** Bayes Theorem: $P(A|B) = \frac{P(B|A)P(A)}{P(B)}$.
*   **Key Skills:** Law of Total Probability (to find the denominator).
*   **Classic Trap:** The Base Rate Fallacy. If a disease is 1-in-a-million, a 99% accurate test still means a positive result is likely a false alarm.

### C. Expectation & Distributions
*   **The Clue:** "How long will it take...", "How many...", "What is the expected payout..."
*   **The Framework:** Linearity of Expectation ($E[A+B] = E[A] + E[B]$), and recognizing distributions (Poisson for rates, Geometric for waiting).
*   **Key Skills:** Knowing the Means and Variances of the core distributions by heart.
*   **Classic Trap:** Thinking that $E[X \cdot Y] = E[X] \cdot E[Y]$. This is *only* true if X and Y are independent!

## 2. Top Statistics Interview Questions & Answers

### Q1: Explain the Central Limit Theorem to a non-technical manager.
**Bad Answer:** "It says that the sum of i.i.d. random variables converges to a Gaussian distribution as n goes to infinity." (Too much jargon).
**Good Answer:** "Imagine you track the amount of time users spend on our app. Some spend 1 second, some spend 3 hours. The data is a messy, skewed shape. The Central Limit Theorem says that if we take random *samples* of 100 users every day and plot the *average* of each sample, those daily averages will form a perfect Bell Curve. It's the magic trick that lets us use simple, predictable math on unpredictable, messy data."

### Q2: We ran an A/B test and the p-value is 0.04. The Product Manager says "Great, there's only a 4% chance this variant is worse!" Are they right?
**Answer:** "No, they are misinterpreting the p-value. A p-value of 0.04 means that *if the variant was actually exactly the same as the control*, there is only a 4% chance we would see a difference this large by pure random luck. It measures the surprise of the data under the Null Hypothesis, not the probability that the alternative hypothesis is true."

### Q3: Why use the Median instead of the Mean?
**Answer:** "The mean is sensitive to outliers. If Bill Gates walks into a bar, the average income in the bar jumps to a billion dollars, but the median barely changes. We use the median for heavily skewed data, like user session lengths or latency, to get a true sense of the 'typical' user experience."

### Q4: Explain the tradeoff between Type 1 and Type 2 errors in a fraud detection model.
**Answer:** "A Type 1 error (False Positive) is flagging a legitimate transaction as fraud. This annoys the customer and might cause them to churn. A Type 2 error (False Negative) is missing a real fraudulent transaction, which costs the company money directly. You can't reduce both without getting a better model; you have to choose a threshold (Alpha) that balances the business cost of annoying users versus losing money."

## 3. The "Machine Learning / Stats" Crossover
If you are interviewing for ML roles, you will be asked how statistics underpin algorithms:
*   **Logistic Regression:** Understand that it outputs a probability bounded between 0 and 1, essentially acting as a conditional probability model $P(Y=1 | X)$.
*   **Naive Bayes:** Be prepared to explain why it is called "Naive" (it assumes all features are conditionally independent, which is almost never true in reality, yet it still works surprisingly well).
*   **L1/L2 Regularization:** L1 (Lasso) corresponds to a Laplace prior (creates sparsity), while L2 (Ridge) corresponds to a Gaussian prior.

## 4. Behavioral Framework: The "Messy Data" Question
Interviewers will always ask: *"Tell me about a time you dealt with messy data or a failing metric."*
Use the **STAR-S** framework:
1.  **Situation:** We launched a feature and the metric dropped.
2.  **Task:** I needed to find out if it was a real drop or a statistical anomaly.
3.  **Action:** I didn't just look at the mean. I looked at the distribution (histograms). I realized there was a massive outlier skewing the mean. I switched the metric to the median (or removed the top 1% of outliers).
4.  **Result:** We found the feature actually *increased* engagement for 99% of users, but broke for a few power users.
5.  **Statistics Tie-in:** Emphasize that your knowledge of robust statistics (Median, IQR, Rank correlation) saved the company from making a bad decision based on a flawed Mean.
