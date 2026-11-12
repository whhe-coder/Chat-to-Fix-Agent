/** One product card of the store front page (styled by src/styles/card.css and button.css). */
export function renderProductCard(product) {
  return [
    '<article class="product-card">',
    `<h3 class="product-card__title">${product.title}</h3>`,
    `<p class="product-card__price">$${product.price.toFixed(2)}</p>`,
    '<button class="btn btn-primary product-card__buy">Buy</button>',
    '</article>',
  ].join('')
}
