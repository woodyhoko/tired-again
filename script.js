/* =========================================================================
   Re-Tired — Retirement & Stock-Market Simulator
   -------------------------------------------------------------------------
   Two layers:
     1. A deterministic year-by-year projection (taxes, mortgage, inflation,
        income growth) — the original calculator's behaviour, refactored into
        a single reusable scenario engine.
     2. A Monte-Carlo layer that re-runs that same engine thousands of times
        while drawing each year's market return from a normal distribution,
        then plots the percentile spread of outcomes.
   ========================================================================= */

const MC_PASSES = 2000;
const SAMPLE_PATHS = 60;
const END_AGE = 100;
const NOW_YEAR = new Date().getFullYear();

/* ---------- Tax models (unchanged brackets) ---------------------------- */

function calculateTax(annualIncome, location) {
  if (annualIncome <= 0) return 0; // no tax (or credits) on non-positive income
  let tax = 0;
  let remainingIncome;
  let brackets;

  switch (location) {
    case "US, CA":
      // U.S. federal (2023, single) + California (2024) stacked.
      const federal = [
        { limit: 0, rate: 0 },
        { limit: 10275, rate: 0.1 },
        { limit: 44725, rate: 0.12 },
        { limit: 95375, rate: 0.22 },
        { limit: 182100, rate: 0.24 },
        { limit: 231250, rate: 0.32 },
        { limit: 578125, rate: 0.35 },
        { limit: Infinity, rate: 0.37 },
      ];
      const california = [
        { limit: 0, rate: 0 },
        { limit: 9325, rate: 0.01 },
        { limit: 22107, rate: 0.02 },
        { limit: 34892, rate: 0.04 },
        { limit: 48012, rate: 0.06 },
        { limit: 63803, rate: 0.08 },
        { limit: 87589, rate: 0.093 },
        { limit: 125778, rate: 0.103 },
        { limit: 251555, rate: 0.113 },
        { limit: 639875, rate: 0.123 },
        { limit: Infinity, rate: 0.133 },
      ];
      tax += applyBrackets(annualIncome, federal);
      tax += applyBrackets(annualIncome, california);
      return tax;
    case "Taiwan":
      brackets = [
        { limit: 0, rate: 0 },
        { limit: 560000, rate: 0.05 },
        { limit: 1260000, rate: 0.12 },
        { limit: 2520000, rate: 0.2 },
        { limit: 4720000, rate: 0.3 },
        { limit: Infinity, rate: 0.4 },
      ];
      return applyBrackets(annualIncome, brackets);
    case "China":
      brackets = [
        { limit: 0, rate: 0 },
        { limit: 36000, rate: 0.03 },
        { limit: 144000, rate: 0.1 },
        { limit: 300000, rate: 0.2 },
        { limit: 420000, rate: 0.25 },
        { limit: 660000, rate: 0.3 },
        { limit: 960000, rate: 0.35 },
        { limit: Infinity, rate: 0.45 },
      ];
      return applyBrackets(annualIncome, brackets);
    default:
      return 0;
  }
}

function applyBrackets(income, brackets) {
  let tax = 0;
  let remaining = income;
  for (let i = 1; i < brackets.length; i++) {
    const width = brackets[i].limit - brackets[i - 1].limit;
    const inBracket = Math.min(remaining, width);
    tax += inBracket * brackets[i].rate;
    remaining -= inBracket;
    if (remaining <= 0) break;
  }
  return tax;
}

function standardDeduction(location) {
  switch (location) {
    case "US, CA": return 14600;
    case "Taiwan": return 207000 + 92000 + 124000;
    case "China": return 60000;
    default: return 0;
  }
}

/* ---------- Mortgage amortization (preserved from original) ------------ */

function calculateMonthlyPayment(principal, annualInterestRate, loanYears) {
  const monthlyInterestRate = annualInterestRate / 12 / 100;
  const totalPayments = loanYears * 12;
  return (
    (principal * monthlyInterestRate) /
    (1 - Math.pow(1 + monthlyInterestRate, -totalPayments))
  );
}

function calculateYearlyAmortization(principal, annualInterestRate, loanYears, lastPrincipal) {
  const monthlyPayment = calculateMonthlyPayment(principal, annualInterestRate, loanYears);
  let totalInterest = 0;
  let totalPrincipal = 0;
  let currentBalance = lastPrincipal;
  for (let month = 1; month <= 12; month++) {
    const monthlyInterest = currentBalance * (annualInterestRate / 12 / 100);
    const principalPaid = monthlyPayment - monthlyInterest;
    totalInterest += monthlyInterest;
    totalPrincipal += principalPaid;
    currentBalance -= principalPaid;
  }
  return { totalInterest, totalPrincipal };
}

/* ---------- Randomness ------------------------------------------------- */

// Box-Muller transform → a draw from N(mean, stdDev)
function randomNormal(mean, stdDev) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * stdDev + mean;
}

function getPercentile(sortedArr, percentile) {
  const index = (percentile / 100) * (sortedArr.length - 1);
  const i = Math.floor(index);
  if (i === index) return sortedArr[i];
  return sortedArr[i] + (sortedArr[i + 1] - sortedArr[i]) * (index - i);
}

/* ---------- The scenario engine ---------------------------------------
   One financial life, simulated year by year from `currentAge` to 100.

   opts:
     canBuyHome      – may the person ever purchase the house?
     forceRetireAge  – retire exactly at this age (NaN = retire organically
                       once passive income covers spending)
     drawReturn()    – returns this year's portfolio return (a constant in
                       deterministic mode, a random draw in Monte-Carlo mode)
     decisionReturn  – the expected return used for the "can I afford to
                       retire?" test (kept stable so a single lucky/unlucky
                       year doesn't flip the irreversible retirement latch)
   --------------------------------------------------------------------- */
function runScenario(P, opts) {
  const canBuyHome = opts.canBuyHome;
  const forced = !Number.isNaN(opts.forceRetireAge);

  let latestInterest = 0;
  let latestPrincipal = P.loanAmount;
  let savings = [P.currentSavings]; // liquid net worth (cash + investments)
  let equity = [0];                 // home equity (house value − mortgage debt)
  let houseOwned = false;
  let houseOwnedAge = NaN;
  let retire = false;
  let retireAge = NaN;
  let currentAnnualIncome = P.annualIncome;

  for (let age = P.currentAge; age++ < END_AGE; ) {
    const t = savings.length - 1; // whole years elapsed since start
    let currentMoney = savings[savings.length - 1];
    let spendingMonthly = P.monthlyExpenses * Math.pow(1 + P.inflationRate, t);
    let deduct = standardDeduction(P.location);

    const ret = opts.drawReturn();
    const investIncome = currentMoney * ret;

    // Working-year take-home (salary + investment income, taxed together)
    let monthlyEarn =
      (currentAnnualIncome + investIncome -
        calculateTax(currentAnnualIncome + investIncome - deduct, P.location)) / 12;

    // --- Housing -------------------------------------------------------
    if (canBuyHome && !houseOwned) {
      if (currentMoney >= P.downPaymentAmount &&
          monthlyEarn * 0.93 > spendingMonthly + P.monthlyMortgagePayment) {
        houseOwned = true;
        currentMoney -= P.downPaymentAmount;
        houseOwnedAge = t + P.currentAge;
      } else {
        spendingMonthly += P.monthlyRent * Math.pow(1 + P.inflationRate, t);
      }
    } else if (!canBuyHome) {
      spendingMonthly += P.monthlyRent * Math.pow(1 + P.inflationRate, t);
    }

    if (houseOwned) {
      if (t - (houseOwnedAge - P.currentAge) < P.mortgageTerm) {
        spendingMonthly += P.monthlyMortgagePayment;
      }
      const propertyTaxPerMonth = P.location === "US, CA" ? (P.housePrice * 0.01) / 12 : 0;
      spendingMonthly += propertyTaxPerMonth;

      const result = calculateYearlyAmortization(
        P.loanAmount, P.mortgageInterestRate, P.mortgageTerm, latestPrincipal
      );
      if (P.location === "US, CA") {
        // Mortgage-interest deduction (capped at $750k of debt) + property-tax (SALT)
        deduct += Math.max(0, Math.min(latestInterest + result.totalInterest, 750000) - latestInterest);
        deduct += Math.min(propertyTaxPerMonth * 12, 10000);
      }
      latestPrincipal -= result.totalPrincipal;
      latestInterest += result.totalInterest;
    }

    // --- Retirement decision ------------------------------------------
    if (!retire) {
      if (forced) {
        if (opts.forceRetireAge - P.currentAge < savings.length) {
          retire = true;
          retireAge = t + P.currentAge;
        }
      } else {
        const ownsIfNeeded = canBuyHome ? houseOwned : true;
        const passive =
          (currentMoney * opts.decisionReturn -
            calculateTax(currentMoney * opts.decisionReturn, P.location)) * 0.85;
        if (ownsIfNeeded && passive > spendingMonthly * 12) {
          retire = true;
          retireAge = t + P.currentAge;
        }
      }
    }

    // --- Advance one year ---------------------------------------------
    if (retire) {
      // Living off the portfolio only — no salary.
      const passiveIncome = currentMoney * ret;
      monthlyEarn =
        (passiveIncome - calculateTax(passiveIncome - deduct, P.location)) / 12;
    }
    savings.push(currentMoney + (monthlyEarn - spendingMonthly) * 12);
    // Home equity = house value minus the debt still outstanding on it.
    const debtRemaining = houseOwned ? Math.max(0, latestPrincipal) : 0;
    equity.push(houseOwned ? P.housePrice - debtRemaining : 0);

    currentAnnualIncome *= 1 + P.yearlyIncomeIncrease;
  }

  // Total net worth folds home equity in on top of liquid assets.
  const networth = savings.map((v, i) => v + equity[i]);
  return { savings: networth, liquid: savings, retireAge, houseOwnedAge };
}

/* ---------- Parameter gathering ---------------------------------------- */

function gatherParams() {
  const num = (id) => parseFloat(document.getElementById(id).value);
  const location = document.getElementById("location").value;
  const housePrice = num("housePrice");
  const downPaymentAmount = housePrice * (num("downPaymentPercentage") / 100);
  const loanAmount = housePrice - downPaymentAmount;
  const mortgageInterestRate = num("mortgageInterestRate") / 100;
  const mortgageTerm = parseInt(document.getElementById("mortgageTerm").value);
  const monthlyMortgagePayment =
    ((mortgageInterestRate / 12) * loanAmount) /
    (1 - Math.pow(1 + mortgageInterestRate / 12, -mortgageTerm * 12));

  return {
    location,
    currentAge: parseInt(document.getElementById("currentAge").value),
    currentSavings: num("currentSavings"),
    annualIncome: num("annualIncome"),
    monthlyExpenses: num("monthlyExpenses"),
    monthlyRent: num("monthlyRent"),
    housePrice,
    downPaymentAmount,
    loanAmount,
    mortgageInterestRate,
    mortgageTerm,
    monthlyMortgagePayment,
    investmentReturnRate: num("investmentReturnRate") / 100,
    inflationRate: num("inflationRate") / 100,
    yearlyIncomeIncrease: num("yearlyIncomeIncrease") / 100,
    volatility: num("volatility") / 100,
    forceRetireAge: parseInt(document.getElementById("forceRetireAge").value), // NaN if blank
    evalAge: parseInt(document.getElementById("evalAge").value), // age at which solvency & median net worth are measured
  };
}

/* The savings[] index corresponding to the net-worth checkpoint age, clamped
   to the simulated range. Blank/invalid falls back to the final year. */
function evalIndex(P) {
  const lastIdx = END_AGE - P.currentAge;
  const idx = (Number.isNaN(P.evalAge) ? END_AGE : P.evalAge) - P.currentAge;
  return Math.min(Math.max(idx, 0), lastIdx);
}

// First age (after the start year, up to the checkpoint) at which the
// portfolio is depleted, else NaN. Skips index 0 so a $0 starting balance
// isn't mistaken for insolvency.
function firstInsolventAge(savings, currentAge, evalIdx) {
  for (let i = 1; i <= evalIdx; i++) if (savings[i] <= 0) return currentAge + i;
  return NaN;
}

// Age at which a homeowner's liquid net worth turns negative — once spending
// has eaten through the portfolio, total wealth has fallen to (or below) just
// the house's value, so the home must be sold. NaN if it never happens or no
// house was ever bought.
function loseHouseAge(savings, currentAge, houseOwnedAge, evalIdx) {
  if (Number.isNaN(houseOwnedAge)) return NaN;
  const start = Math.max(1, houseOwnedAge - currentAge);
  for (let i = start; i <= evalIdx; i++) if (savings[i] < 0) return currentAge + i;
  return NaN;
}

/* ---------- Monte-Carlo over the scenario engine ----------------------- */
// Runs `MC_PASSES` lifetimes, drawing each year's return from N(exp, vol).
// Returns per-year percentile bands + summary stats + a few sample paths.
function monteCarlo(P, canBuyHome) {
  const years = END_AGE - P.currentAge + 1; // points per path (incl. year 0)
  const evalIdx = evalIndex(P); // checkpoint age where solvency is judged
  const byYear = Array.from({ length: years }, () => new Float64Array(MC_PASSES));
  const retireAges = [];
  let solventCount = 0;
  let loseHouseCount = 0;
  const samples = [];

  for (let pass = 0; pass < MC_PASSES; pass++) {
    const draw = () => randomNormal(P.investmentReturnRate, P.volatility);
    const res = runScenario(P, {
      canBuyHome,
      forceRetireAge: Number.isNaN(P.forceRetireAge) ? NaN : P.forceRetireAge,
      drawReturn: draw,
      decisionReturn: P.investmentReturnRate,
    });
    for (let y = 0; y < years; y++) byYear[y][pass] = res.savings[y] || 0;
    if (!Number.isNaN(res.retireAge)) retireAges.push(res.retireAge);
    if (res.savings[evalIdx] > 0) solventCount++;
    if (!Number.isNaN(loseHouseAge(res.liquid, P.currentAge, res.houseOwnedAge, evalIdx))) loseHouseCount++;
    if (pass < SAMPLE_PATHS) samples.push(res.savings);
  }

  const pcts = [5, 25, 50, 75, 95];
  const bands = {};
  pcts.forEach((p) => (bands[p] = []));
  const finalAll = Array.from(byYear[years - 1]).sort((a, b) => a - b);

  for (let y = 0; y < years; y++) {
    const sorted = Array.from(byYear[y]).sort((a, b) => a - b);
    pcts.forEach((p) => bands[p].push(getPercentile(sorted, p)));
  }

  retireAges.sort((a, b) => a - b);
  const medianRetire = retireAges.length
    ? getPercentile(retireAges, 50)
    : NaN;

  return {
    bands,
    byYear,
    finalAll,
    medianRetire,
    retireProbability: retireAges.length / MC_PASSES,
    survival: solventCount / MC_PASSES,
    loseHouseProbability: loseHouseCount / MC_PASSES,
    samples,
  };
}

/* ---------- Formatting & chart helpers --------------------------------- */

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 2,
});

function ageLabels(P) {
  const labels = [];
  for (let a = P.currentAge; a <= END_AGE; a++) labels.push(a);
  return labels;
}

let projectionChart = null;
let distributionChart = null;
let mcState = null; // holds last Monte-Carlo result for hover-driven distribution

const A_RGB = "16, 185, 129";
const B_RGB = "56, 189, 248";
const C_RGB = "245, 158, 11";

const baseScales = (P, maxY) => ({
  x: {
    grid: { color: "rgba(255,255,255,0.05)" },
    ticks: { color: "rgba(255,255,255,0.45)", font: { family: "Inter" }, maxTicksLimit: 12 },
    title: { display: true, text: "Age", color: "rgba(255,255,255,0.4)", font: { family: "Inter" } },
  },
  y: {
    max: maxY,
    grid: { color: "rgba(255,255,255,0.05)" },
    border: { display: false },
    ticks: {
      color: "rgba(255,255,255,0.45)",
      font: { family: "Inter" },
      callback: (v) => compact.format(v),
    },
  },
});

/* ---------- Deterministic rendering ------------------------------------ */

function renderDeterministic(P) {
  const labels = ageLabels(P);
  const det = () => P.investmentReturnRate;
  const dr = P.investmentReturnRate;

  const home = runScenario(P, { canBuyHome: true, forceRetireAge: NaN, drawReturn: det, decisionReturn: dr });
  const noHome = runScenario(P, { canBuyHome: false, forceRetireAge: NaN, drawReturn: det, decisionReturn: dr });

  const hasForce = !Number.isNaN(P.forceRetireAge);
  let homeF, noHomeF;
  if (hasForce) {
    homeF = runScenario(P, { canBuyHome: true, forceRetireAge: P.forceRetireAge, drawReturn: det, decisionReturn: dr });
    noHomeF = runScenario(P, { canBuyHome: false, forceRetireAge: P.forceRetireAge, drawReturn: det, decisionReturn: dr });
  }

  const datasets = [
    line("Buy a Home", home.savings, A_RGB, 3),
    line("Rent Forever", noHome.savings, B_RGB, 3),
  ];
  if (hasForce) {
    datasets.push(line("Buy a Home · Adjusted", homeF.savings, C_RGB, 2, true));
    datasets.push(line("Rent Forever · Adjusted", noHomeF.savings, C_RGB, 2, true, 0.55));
  }

  const maxY = Math.max(
    arrMax(home.savings), arrMax(noHome.savings),
    hasForce ? arrMax(homeF.savings) : 0, hasForce ? arrMax(noHomeF.savings) : 0
  ) * 1.05;

  drawProjection(P, labels, datasets, maxY, true);

  const evalIdx = evalIndex(P);
  const evalAge = P.currentAge + evalIdx;
  if (hasForce) {
    // Stat cards reflect the actual outcome of retiring at the adjusted age.
    updateStats(P, {
      evalAge, forced: true,
      homeRetire: homeF.retireAge, homeHouseAge: homeF.houseOwnedAge, homeEnd: homeF.savings[evalIdx],
      homeLoseAge: loseHouseAge(homeF.liquid, P.currentAge, homeF.houseOwnedAge, evalIdx),
      noHomeRetire: noHomeF.retireAge, noHomeEnd: noHomeF.savings[evalIdx],
      noHomeInsolventAge: firstInsolventAge(noHomeF.savings, P.currentAge, evalIdx),
    });
  } else {
    updateStats(P, {
      evalAge,
      homeRetire: home.retireAge, homeHouseAge: home.houseOwnedAge, homeEnd: home.savings[evalIdx],
      homeLoseAge: loseHouseAge(home.liquid, P.currentAge, home.houseOwnedAge, evalIdx),
      noHomeRetire: noHome.retireAge, noHomeEnd: noHome.savings[evalIdx],
    });
  }

  document.getElementById("forceLeg").style.display = hasForce ? "" : "none";
  document.getElementById("distributionSection").style.display = "none";
  document.getElementById("projSub").textContent =
    "Deterministic projection at a fixed " + (dr * 100).toFixed(1) + "% return" +
    (hasForce ? `, retiring at age ${P.forceRetireAge}` : "") +
    ` · net worth (incl. home equity) measured at age ${evalAge}.`;
}

function line(label, data, rgb, width, dashed = false, alpha = 1) {
  return {
    label,
    data,
    borderColor: `rgba(${rgb}, ${alpha})`,
    backgroundColor: "transparent",
    borderWidth: width,
    borderDash: dashed ? [6, 5] : [],
    pointRadius: 0,
    tension: 0.15,
    fill: false,
  };
}

/* ---------- Monte-Carlo rendering -------------------------------------- */

async function renderMonteCarlo(P) {
  const labels = ageLabels(P);

  const home = monteCarlo(P, true);
  const noHome = monteCarlo(P, false);
  mcState = { home, noHome, labels, P };

  const datasets = [];
  datasets.push(...bandDatasets(home.bands, A_RGB, "Buy a Home"));
  datasets.push(...bandDatasets(noHome.bands, B_RGB, "Rent Forever"));

  if (document.getElementById("showPaths").checked) {
    addSamplePaths(datasets, home.samples, A_RGB);
    addSamplePaths(datasets, noHome.samples, B_RGB);
  }

  const maxY = Math.max(arrMax(home.bands[95]), arrMax(noHome.bands[95])) * 1.05;
  drawProjection(P, labels, datasets, maxY, false);

  const evalIdx = evalIndex(P);
  const evalAge = P.currentAge + evalIdx;
  updateStats(P, {
    evalAge,
    homeRetire: home.medianRetire, homeHouseAge: NaN, homeEnd: home.bands[50][evalIdx],
    homeLoseProb: home.loseHouseProbability,
    noHomeRetire: noHome.medianRetire, noHomeEnd: noHome.bands[50][evalIdx],
    homeSurvival: home.survival, noHomeSurvival: noHome.survival,
    homeRetireProb: home.retireProbability, noHomeRetireProb: noHome.retireProbability,
    mc: true,
  });

  document.getElementById("forceLeg").style.display = "none";
  document.getElementById("distributionSection").style.display = "";
  renderDistribution(evalIdx); // checkpoint age
  document.getElementById("distTitle").textContent = "Outcome Spread at Age " + evalAge;
  const forceNote = Number.isNaN(P.forceRetireAge) ? "" : ` · retiring at age ${P.forceRetireAge}`;
  document.getElementById("projSub").textContent =
    `${MC_PASSES.toLocaleString()} simulated market histories · ${(P.investmentReturnRate * 100).toFixed(1)}% mean, ${(P.volatility * 100).toFixed(1)}% volatility${forceNote}. Net worth incl. home equity; solvency & median measured at age ${evalAge}. Shaded band = 5th–95th percentile.`;
}

// Build the shaded percentile band (5–95, 25–75) plus the median line.
function bandDatasets(bands, rgb, name) {
  const ds = [];
  // 95th (invisible upper edge) then 5th fills down to it
  ds.push(edge(bands[95]));
  ds.push(fillTo(bands[5], rgb, 0.07));
  // 75th edge then 25th fills the inter-quartile core
  ds.push(edge(bands[75]));
  ds.push(fillTo(bands[25], rgb, 0.12));
  // Median line (the visible one)
  ds.push({
    label: name,
    data: bands[50],
    borderColor: `rgba(${rgb}, 1)`,
    backgroundColor: "transparent",
    borderWidth: 3,
    pointRadius: 0,
    tension: 0.2,
    fill: false,
  });
  return ds;
}

function edge(data) {
  return { data, borderColor: "transparent", backgroundColor: "transparent", borderWidth: 0, pointRadius: 0, fill: false, _band: true };
}
function fillTo(data, rgb, alpha) {
  return { data, borderColor: "transparent", backgroundColor: `rgba(${rgb}, ${alpha})`, borderWidth: 0, pointRadius: 0, fill: "-1", _band: true };
}

function addSamplePaths(datasets, samples, rgb) {
  samples.forEach((s) =>
    datasets.push({
      data: s, borderColor: `rgba(${rgb}, 0.12)`, borderWidth: 1,
      pointRadius: 0, fill: false, tension: 0.1, hoverRadius: 0, _band: true,
    })
  );
}

/* ---------- Shared projection chart ------------------------------------ */

function drawProjection(P, labels, datasets, maxY, deterministic) {
  const ctx = document.getElementById("projectionChart").getContext("2d");
  if (projectionChart) { projectionChart.destroy(); projectionChart = null; }

  projectionChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: datasets.length > 50 ? false : { duration: 600 },
      interaction: { mode: "index", intersect: false },
      onHover: deterministic ? undefined : (e, active) => {
        if (!mcState) return;
        if (active.length > 0) {
          const idx = active[0].index;
          if (projectionChart.$hoverIdx !== idx) {
            projectionChart.$hoverIdx = idx;
            renderDistribution(idx);
            document.getElementById("distTitle").textContent =
              "Outcome Spread at Age " + mcState.labels[idx];
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(20, 26, 24, 0.96)",
          titleFont: { family: "Inter", size: 13 },
          bodyFont: { family: "Inter", size: 13 },
          padding: 12,
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          filter: (item) => !item.dataset._band,
          callbacks: {
            title: (items) => "Age " + items[0].label,
            label: (c) => " " + c.dataset.label + ": " + compact.format(c.parsed.y),
          },
        },
      },
      scales: baseScales(P, maxY),
    },
  });
  projectionChart.$hoverIdx = -1;
}

/* ---------- Distribution histogram (Monte-Carlo only) ------------------ */

function renderDistribution(yearIdx) {
  if (!mcState) return;
  const finalA = mcState.home.byYear[yearIdx];
  const finalB = mcState.noHome.byYear[yearIdx];

  const sortedA = Array.from(finalA).sort((a, b) => a - b);
  const sortedB = Array.from(finalB).sort((a, b) => a - b);

  let minVal = Math.min(getPercentile(sortedA, 1), getPercentile(sortedB, 1));
  let maxVal = Math.max(getPercentile(sortedA, 98), getPercentile(sortedB, 98));
  if (minVal === maxVal) { maxVal = minVal + 10000; minVal -= 10000; }

  const numBins = 40;
  let step = (maxVal - minVal) / numBins || 1000;
  const binsA = new Array(numBins).fill(0);
  const binsB = new Array(numBins).fill(0);
  const binLabels = [];
  for (let i = 0; i < numBins; i++) {
    const start = minVal + i * step;
    binLabels.push(compact.format(start) + (i === numBins - 1 ? "+" : ""));
  }

  const bin = (arr, bins) => {
    for (let i = 0; i < arr.length; i++) {
      let v = Math.max(minVal, Math.min(maxVal, arr[i]));
      let idx = Math.floor((v - minVal) / step);
      if (idx >= numBins) idx = numBins - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    }
  };
  bin(finalA, binsA);
  bin(finalB, binsB);

  if (distributionChart) {
    distributionChart.data.labels = binLabels;
    distributionChart.data.datasets[0].data = binsA;
    distributionChart.data.datasets[1].data = binsB;
    distributionChart.update("none");
    return;
  }

  const ctx = document.getElementById("distributionChart").getContext("2d");
  distributionChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: binLabels,
      datasets: [
        { label: "Buy a Home", data: binsA, backgroundColor: `rgba(${A_RGB}, 0.45)`, borderColor: `rgba(${A_RGB}, 1)`, borderWidth: 1, barPercentage: 1, categoryPercentage: 0.55 },
        { label: "Rent Forever", data: binsB, backgroundColor: `rgba(${B_RGB}, 0.45)`, borderColor: `rgba(${B_RGB}, 1)`, borderWidth: 1, barPercentage: 1, categoryPercentage: 0.55 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(20, 26, 24, 0.96)",
          padding: 12, borderColor: "rgba(255,255,255,0.1)", borderWidth: 1,
          callbacks: { label: (c) => " " + c.dataset.label + ": " + c.parsed.y + " of " + MC_PASSES.toLocaleString() },
        },
      },
      scales: {
        x: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "rgba(255,255,255,0.4)", font: { family: "Inter" }, maxTicksLimit: 8 } },
        y: { grid: { color: "rgba(255,255,255,0.05)" }, border: { display: false }, ticks: { color: "rgba(255,255,255,0.4)", font: { family: "Inter" } } },
      },
    },
  });
}

/* ---------- Stat cards ------------------------------------------------- */

function updateStats(P, s) {
  // Big number = retirement age; the "yrs" unit hides when it reads "Never".
  const setAge = (valId, unitId, a) => {
    const isNum = !Number.isNaN(a);
    document.getElementById(valId).textContent = isNum ? Math.round(a) : "Never";
    document.getElementById(unitId).style.display = isNum ? "" : "none";
  };
  setAge("retireAgeA", "unitA", s.homeRetire);
  setAge("retireAgeB", "unitB", s.noHomeRetire);

  // Net-worth metric: a label carrying the checkpoint age + a value (red if < 0).
  const nwTag = (s.mc ? "Median net worth @" : "Net worth @") + s.evalAge;
  document.getElementById("nwLabelA").textContent = nwTag;
  document.getElementById("nwLabelB").textContent = nwTag;
  const setMoney = (id, v) => {
    const el = document.getElementById(id);
    el.textContent = v == null || Number.isNaN(v) ? "—" : compact.format(v);
    el.classList.toggle("neg", typeof v === "number" && v < 0);
  };
  setMoney("endBalA", s.homeEnd);
  setMoney("endBalB", s.noHomeEnd);

  const houseBadge = document.getElementById("houseAgeBadge");
  const loseBadge = document.getElementById("loseHouseBadge");
  const survB = document.getElementById("survivalB");
  // "house at 29 · 2029" — age plus the calendar year of purchase.
  const houseText = () => {
    if (Number.isNaN(s.homeHouseAge)) return "no house bought";
    const age = Math.round(s.homeHouseAge);
    return "house at " + age + " · " + (NOW_YEAR + age - P.currentAge);
  };
  const solvency = (insolventAge) =>
    Number.isNaN(insolventAge) ? "solvent @" + s.evalAge : "broke at " + insolventAge;

  if (s.mc) {
    houseBadge.textContent = pct(s.homeRetireProb) + " retire · " + pct(s.homeSurvival) + " solvent @" + s.evalAge;
    survB.style.display = "";
    survB.textContent = pct(s.noHomeRetireProb) + " retire · " + pct(s.noHomeSurvival) + " solvent @" + s.evalAge;
    survB.className = "badge";
  } else if (s.forced) {
    // Deterministic projection of retiring exactly at the adjusted age.
    houseBadge.textContent = houseText();
    survB.style.display = "";
    survB.textContent = solvency(s.noHomeInsolventAge);
    survB.className = "badge";
  } else {
    houseBadge.textContent = houseText();
    survB.style.display = "none";
  }

  // House is lost once liquid assets run dry and the home must be sold.
  if (s.mc) {
    const lose = s.homeLoseProb || 0;
    loseBadge.style.display = lose >= 0.005 ? "" : "none"; // hide when it rounds to 0%
    loseBadge.textContent = pct(lose) + " lose house";
  } else if (s.homeLoseAge != null && !Number.isNaN(s.homeLoseAge)) {
    loseBadge.style.display = "";
    loseBadge.textContent = "lose house at " + Math.round(s.homeLoseAge);
  } else {
    loseBadge.style.display = "none";
  }
}

const pct = (x) => (x * 100).toFixed(0) + "%";

/* ---------- Small utilities -------------------------------------------- */

function arrMax(a) {
  let m = -Infinity;
  for (const v of a) if (v > m && Number.isFinite(v)) m = v;
  return m === -Infinity ? 0 : m;
}

/* ---------- Orchestration / events ------------------------------------- */

let recalcTimer = null;
function scheduleRecalc() {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalc, 120);
}

async function recalc() {
  const P = gatherParams();
  const useMC = document.getElementById("enableMC").checked && P.volatility > 0;
  const status = document.getElementById("statusMessage");

  if (useMC) {
    status.textContent = `Simulating ${MC_PASSES.toLocaleString()} market paths…`;
    await new Promise((r) => setTimeout(r, 10)); // let the UI paint
    renderMonteCarlo(P);
    status.textContent = "Simulation complete";
    setTimeout(() => { if (status.textContent === "Simulation complete") status.textContent = "Ready"; }, 1800);
  } else {
    renderDeterministic(P);
    status.textContent = "Ready";
  }
}

function syncMCInputs() {
  const on = document.getElementById("enableMC").checked;
  ["volGroup", "pathsGroup"].forEach((id) =>
    document.getElementById(id).classList.toggle("disabled", !on)
  );
}

document.querySelectorAll('input[type="number"], select').forEach((el) =>
  el.addEventListener("input", scheduleRecalc)
);

document.getElementById("volatility").addEventListener("input", (e) => {
  document.getElementById("volatilityVal").textContent = Number(e.target.value).toFixed(1);
  scheduleRecalc();
});

document.getElementById("enableMC").addEventListener("change", () => { syncMCInputs(); recalc(); });
document.getElementById("showPaths").addEventListener("change", recalc);

// Initial paint
syncMCInputs();
recalc();
