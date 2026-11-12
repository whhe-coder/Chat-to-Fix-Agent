/** The buy button of a product page (styled by src/styles/button.css). */
export function renderBuyButton(label = 'Buy now') {
  return `<button class="btn btn-primary">${label}</button>`
}

export function renderWishlistButton(label = 'Add to wishlist') {
  return `<button class="btn btn-secondary">${label}</button>`
}
