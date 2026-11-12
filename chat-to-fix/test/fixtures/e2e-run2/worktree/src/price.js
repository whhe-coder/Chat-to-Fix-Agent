// Price helpers of the sample shop.

/** The price after a percentage discount: 100 with 10% off is 90. */
export function applyDiscount(price, percent) {
  return price - (price * percent) / 100
}

export function formatPrice(value) {
  return `$${value.toFixed(2)}`
}
