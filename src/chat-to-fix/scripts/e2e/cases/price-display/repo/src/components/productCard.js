import { formatDiscount, formatPrice } from '../format.js'

/** One product card of the store front page. product = { title, price, discount? } */
export function renderProductCard(product) {
  const badge = product.discount ? `<span class="product-card__discount">${formatDiscount(product.discount)}</span>` : ''
  return [
    '<article class="product-card">',
    `<h3 class="product-card__title">${product.title}</h3>`,
    badge,
    `<p class="product-card__price">${formatPrice(product.price)}</p>`,
    '</article>',
  ].join('')
}
