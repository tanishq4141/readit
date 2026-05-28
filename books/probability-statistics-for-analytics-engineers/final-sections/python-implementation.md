# PYTHON IMPLEMENTATION

## Overview
While the theory of statistics is beautiful, modern Analytics Engineering is done in Python. This section acts as a quick-reference cheat sheet for the most important statistical libraries: `numpy`, `pandas`, and `scipy.stats`.

## 1. Descriptive Statistics with Pandas & NumPy
When you first receive a dataset, your goal is "data compression" (CH-10).

```python
import pandas as pd
import numpy as np

# Load data
df = pd.read_csv('user_data.csv')

# 1. The "Magic" Summary Command
# Gives Count, Mean, Std, Min, 25%, 50%, 75%, Max for all numeric columns
summary = df.describe()

# 2. Robust Central Tendency
median_income = df['income'].median()
mode_city = df['city'].mode()[0]

# 3. Measures of Spread
variance = df['session_time'].var(ddof=1) # ddof=1 uses Bessel's Correction (n-1)
std_dev = df['session_time'].std(ddof=1)

# 4. Percentiles / Quantiles (CH-13)
# Get the 90th and 99th percentiles (e.g., for latency SLAs)
p90, p99 = np.percentile(df['latency_ms'], [90, 99])
# Or in Pandas:
p99_pd = df['latency_ms'].quantile(0.99)
```

## 2. Working with Distributions (`scipy.stats`)
`scipy.stats` is the ultimate tool for theoretical probability. Every distribution in the library has the same core methods:
*   `.rvs()`: Random Variate Sample (Generate random data).
*   `.pdf()` / `.pmf()`: Probability Density/Mass Function (The height of the curve).
*   `.cdf()`: Cumulative Distribution Function (Area to the left).
*   `.ppf()`: Percent Point Function (Inverse CDF: give it an area, get the value).

```python
from scipy import stats

# A. Normal Distribution (CH-18)
mu, sigma = 100, 15
# What is the probability of a value < 120?
p_less_120 = stats.norm.cdf(120, loc=mu, scale=sigma)
# What is the top 5% cutoff?
top_5_cutoff = stats.norm.ppf(0.95, loc=mu, scale=sigma)

# B. Poisson Distribution (CH-25)
lam = 3.5 # average events per hour
# What is the probability of exactly 5 events?
p_exact_5 = stats.poisson.pmf(5, mu=lam)

# C. Geometric Distribution (CH-26)
p_success = 0.1
# What is the probability it takes MORE than 3 tries?
p_more_than_3 = 1 - stats.geom.cdf(3, p=p_success)
```

## 3. Hypothesis Testing (`scipy.stats`)
Never write hypothesis testing math from scratch in production. Use the robust implementations in SciPy.

```python
# A. One-Sample T-Test (CH-32)
# Is the average age significantly different from 30?
t_stat, p_val = stats.ttest_1samp(df['age'], popmean=30)

# B. Independent Two-Sample T-Test (CH-33)
# Compare conversion rates between Group A and Group B
group_a = df[df['variant'] == 'A']['conversion']
group_b = df[df['variant'] == 'B']['conversion']
# ALWAYS default to equal_var=False (Welch's T-Test) unless you are absolutely sure!
t_stat, p_val = stats.ttest_ind(group_a, group_b, equal_var=False)

# C. Paired T-Test (CH-33)
# Compare before and after scores for the SAME users
t_stat, p_val = stats.ttest_rel(df['score_before'], df['score_after'])

# D. Chi-Squared Test for Independence (CH-34)
# Is 'Device Type' independent of 'Subscription Tier'?
# First, create a contingency table
contingency_table = pd.crosstab(df['device_type'], df['subscription_tier'])
chi2, p_val, dof, expected = stats.chi2_contingency(contingency_table)
```

## 4. Correlation (`pandas` & `scipy`)
Understanding relationships between variables (CH-36 to CH-38).

```python
# A. Pearson Correlation Matrix (Linear)
# Returns an NxN matrix of correlations for all numeric columns
pearson_matrix = df.corr(method='pearson')

# B. Spearman Correlation Matrix (Rank-based, Robust)
spearman_matrix = df.corr(method='spearman')

# C. Getting P-Values for Correlation
# Pandas .corr() doesn't give p-values. Use SciPy if you need to know 
# if the correlation is statistically significant.
corr_coef, p_val = stats.pearsonr(df['marketing_spend'], df['sales'])
if p_val < 0.05:
    print(f"Significant correlation: {corr_coef:.2f}")
```

## Best Practices for Analytics Engineering
1.  **Don't reinvent the wheel:** If a statistical test exists, SciPy or StatsModels has it.
2.  **Vectorize:** Avoid `for` loops when calculating statistics. Let NumPy's C-backend do the heavy lifting.
3.  **Handle NaNs:** Always check how a function handles missing data (`NaN`). Pandas methods usually drop them by default; NumPy methods often return `NaN` unless you use `np.nanmean()` or `np.nanstd()`.
