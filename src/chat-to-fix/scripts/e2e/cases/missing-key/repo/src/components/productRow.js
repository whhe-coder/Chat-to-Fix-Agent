import { t } from '../i18n.js'

/** One row of the product list. product = { title, price } (price 0 means free) */
export function renderProductRow(product) {
  const price = product.price === 0 ? t('store.free') : `$${product.price.toFixed(2)}`
  return `<li class="product-row"><span>${product.title}</span><span>${price}</span><button class="btn btn-secondary">${t('store.add_to_cart')}</button></li>`
}
