// Dollar amounts as the app shows them. LLM calls often cost a fraction of a
// cent, so small amounts keep two significant digits instead of rounding to 0.
export const formatDollars = (amount: number): string => {
  if (amount === 0) return "$0"
  if (amount < 0.01) return `$${Number(amount.toPrecision(2)).toString()}`
  return `$${amount.toFixed(2)}`
}
