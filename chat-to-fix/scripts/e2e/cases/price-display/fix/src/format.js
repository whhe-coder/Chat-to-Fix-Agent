// Display formatting helpers of the store client.

/** A price in dollars for display, for example "$1,000.00". 0 is "Free"; a missing price is a dash. */
export function formatPrice(value) {
  if (value === null || value === undefined) return '—'
  if (value === 0) return 'Free'
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A discount percentage for display: 25 -> "-25%". */
export function formatDiscount(percent) {
  return `-${Math.round(percent)}%`
}
