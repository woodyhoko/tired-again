# Re-Tired &nbsp;·&nbsp; aka *Tired-again*

A browser-based **retirement simulator**. It projects your net worth year by year — modelling income tax, a mortgage, inflation and pay raises — and lets you decide between **buying a home** or **renting forever**. On top of the deterministic projection it can run a **Monte-Carlo stock-market simulation** that draws each year's investment return from a random distribution and plots the full **probability spread** of outcomes.

**[▶ Live Demo](https://woodyhoko.github.io/tired-again)**

![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-f7df1e) ![Chart.js](https://img.shields.io/badge/Chart.js-line%20%2B%20bar-ff6384) ![No build step](https://img.shields.io/badge/build-none-success)

---

## Features

- **Two life strategies, side by side**
  - 🏠 **Buy a Home** — save a down payment, take on a mortgage, then retire.
  - 🌎 **Rent Forever** — stay liquid and keep everything invested.
- **Adjusted Retire Age** — pin a target retirement age and watch the trajectory change.
- **Income-tax modelling** for three locales (US + California, Taiwan, China) with progressive brackets and standard deductions.
- **Mortgage engine** — down payment, monthly payment, yearly amortization, plus the US mortgage-interest and property-tax (SALT) deductions.
- **Inflation & pay-raise** compounding on expenses, rent and salary.
- **📈 Monte-Carlo market simulation** — 2,000 random market histories, percentile spread bands (5th–95th & inter-quartile), survival/retirement probabilities, an outcome-distribution histogram, and an optional sample-path overlay.
- **Instant, debounced recalculation** as you type.

---

## How the simulation works

### 1. The scenario engine (`runScenario`)

Every projection — deterministic or Monte-Carlo — runs through one function that simulates a single financial life from your current age to **100**, one year at a time. Each year it:

1. **Inflates spending**: `monthlyExpenses × (1 + inflation)^t` (and rent, while you don't own).
2. **Earns income**: salary + investment income (`portfolio × return`), taxed together after the locale's standard deduction.
3. **Decides on the house** (Buy-a-Home strategy): once savings cover the down payment *and* take-home comfortably exceeds spending + mortgage, it buys — subtracting the down payment and starting the amortization clock.
4. **Pays housing costs** while owning: mortgage payment (until the term ends), US property tax, and it accrues the US mortgage-interest / property-tax deductions.
5. **Checks for retirement**:
   - *Organic* — retire once **passive income covers spending** with margin: `(portfolio × return − tax) × 0.85 > yearlySpending` (the `0.85` is a safety haircut; home-buyers must own first).
   - *Adjusted* — retire exactly at the age you pin.
   - Retirement is a latch: once retired, salary stops and you live off the portfolio.
6. **Advances the balance**: `newBalance = balance + (monthlyTakeHome − monthlySpending) × 12`, then applies the annual pay raise.

The four chart lines (Buy/Rent × organic/adjusted) are just this engine called with different `canBuyHome` and `forceRetireAge` arguments.

### 2. Taxes

`calculateTax(income, location)` walks progressive brackets:

| Locale | Model |
|--------|-------|
| **US, CA** | US federal (2023, single filer) **stacked with** California state (2024) brackets. |
| **Taiwan** | National income-tax brackets (5% → 40%). |
| **China** | Comprehensive-income brackets (3% → 45%). |

Standard deductions applied before tax: **US $14,600**, **Taiwan NT$423,000** (standard + special + exemption), **China ¥60,000**. Non-positive income is taxed at zero.

### 3. Mortgage

Standard amortization: a fixed monthly payment is derived from principal, rate and term, then split into interest/principal each month so the US deductions can track cumulative interest (capped at $750k of debt) and property tax (capped at $10k SALT).

### 4. Monte-Carlo market layer (`monteCarlo`)

When **Simulate market volatility** is enabled, the engine is re-run **2,000 times**. Instead of a fixed return, each year draws from a normal distribution:

```
yearReturn ~ N(expectedReturn, volatility)
```

generated with a **Box–Muller transform**. The *growth* of the portfolio uses these random draws, while the *retirement decision* uses the stable expected return — so one lucky or unlucky year never flips the irreversible "I'm retired" latch.

#### Why the volatility default is 9.0%

The **Annual Volatility (σ)** slider defaults to **9.0%**, the same balanced-portfolio figure used in the companion [L-vs-Y pension simulator](https://github.com/woodyhoko/L-vs-Y). It models a classic **60% diversified stocks / 40% bonds (60/40)** allocation rather than a pure equity portfolio:

- A pure S&P 500 history has a much higher standard deviation (~15.5%), which over-punishes the early-sequence-of-returns risk for a balanced saver.
- Because ~40% of the portfolio sits in low-yield but stable assets (bonds, treasuries), the blended standard deviation is anchored down to roughly **9.0%** historically.

This makes the spread bands reflect a realistic balanced retirement portfolio, while you can still drag σ up toward ~15% to stress-test an all-equity profile.

For every age the 2,000 outcomes are sorted into percentiles:

- The **median (50th)** is drawn as the solid line.
- The **5th–95th** and **25th–75th** percentiles are drawn as nested shaded bands — the *spread*.
- **Survival %** = share of paths still solvent at 100; **Retire %** = share that ever reached retirement.
- The **distribution histogram** bins the final-year (or hovered-year) balances across all 2,000 paths. Hover any age on the main chart to re-bin the histogram at that age.
- An optional overlay draws 60 individual sample paths.

> **Note** — figures are illustrative. Tax brackets, deductions and the market model are simplifications and not financial advice.

---

## Stack

- **Vanilla HTML + CSS + JavaScript** — no framework, no build step.
- [**Chart.js**](https://www.chartjs.org/) for the line spread and distribution histogram.
- Google Fonts (*Outfit* + *Inter*) and a glassmorphic dark dashboard theme.

| File | Role |
|------|------|
| `index.html` | Layout: sidebar inputs + dashboard. |
| `style.css` | Dark-glass theme, responsive grid, controls. |
| `script.js` | Tax/mortgage math, the scenario engine, Monte-Carlo, and Chart.js rendering. |

---

## Run Locally

```bash
# any static server works — there is no build step
python -m http.server 8000
# then open http://localhost:8000

# or just open the file directly
open index.html
```

---

## License

See [LICENSE](LICENSE).
