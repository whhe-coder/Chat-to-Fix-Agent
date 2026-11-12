import { t } from '../i18n.js'

/** One product card of the store front page. product = { title, price, owned } */
export function renderProductCard(product) {
  const action = product.owned
    ? `<span class="badge-owned">${t('card.owned')}</span>`
    : `<button class="btn btn-primary product-card__buy">${t('card.purchase')}</button>`
  return [
    '<article class="product-card">',
    `<h3 class="product-card__title">${product.title}</h3>`,
    `<p class="product-card__price">$${product.price.toFixed(2)}</p>`,
    action,
    '</article>',
  ].join('')
}
