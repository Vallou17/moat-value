// DCF intrinsic value calculations — pure functions, run client-side.

export interface DCFInputs {
  startingFcf: number;
  growthRate1to5: number; // decimal
  growthRate6to10: number;
  growthRate11to20: number;
  discountRate: number; // decimal
  sharesOutstanding: number;
  totalDebt: number;
  cash: number;
}

export interface DCFResult {
  intrinsicValuePerShare: number;
  totalPv: number;
  projection: { year: number; fcf: number; pv: number }[];
}

export function computeDcf(i: DCFInputs): DCFResult {
  const projection: { year: number; fcf: number; pv: number }[] = [];
  let fcf = i.startingFcf;
  let totalPv = 0;
  for (let n = 1; n <= 20; n++) {
    const g =
      n <= 5 ? i.growthRate1to5 : n <= 10 ? i.growthRate6to10 : i.growthRate11to20;
    fcf = fcf * (1 + g);
    const pv = fcf / Math.pow(1 + i.discountRate, n);
    totalPv += pv;
    projection.push({ year: n, fcf, pv });
  }
  const ivBefore = totalPv / i.sharesOutstanding;
  const intrinsicValuePerShare =
    ivBefore - i.totalDebt / i.sharesOutstanding + i.cash / i.sharesOutstanding;
  return { intrinsicValuePerShare, totalPv, projection };
}

// Negative = trading at discount (below IV). Positive = premium.
export function discountPremiumPct(price: number, iv: number): number {
  if (!iv || iv <= 0) return 0;
  return ((price - iv) / iv) * 100;
}
