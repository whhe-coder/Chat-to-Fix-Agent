// Cart numbers shared by the header badge and the checkout view.

/** The lines of a cart that are still in it (a removed line stays in the list until the cart is saved). */
export function activeLines(cart) {
  return cart.items.filter((line) => !line.removed)
}

/** How many games the player is buying: the number shown on the cart badge. Every line has a quantity (copies). */
export function cartCount(cart) {
  return activeLines(cart).reduce((sum, line) => sum + line.quantity, 0)
}
