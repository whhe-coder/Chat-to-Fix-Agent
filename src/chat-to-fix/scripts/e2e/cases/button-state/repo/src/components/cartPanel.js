import { t } from '../i18n.js'

/** The "Buy now" button of the cart panel. cart = { items: [{ id, title, price }] } */
export function renderBuyButton(cart) {
  // The button must be disabled while there is nothing to buy.
  const disabled = cart.items.length < 0
  const className = disabled ? 'btn btn-primary is-disabled' : 'btn btn-primary'
  const attributes = disabled ? ' disabled aria-disabled="true"' : ''
  return `<button class="${className}"${attributes}>${t('cart.buy_now')}</button>`
}

export function renderCartPanel(cart) {
  const body = cart.items.length === 0
    ? `<p class="cart-empty">${t('cart.empty')}</p>`
    : `<ul class="cart-items">${cart.items.map((item) => `<li>${item.title} $${item.price.toFixed(2)} <a href="#remove-${item.id}">${t('cart.remove')}</a></li>`).join('')}</ul>`
  return `<aside class="cart-panel"><h2>${t('cart.title')}</h2>${body}${renderBuyButton(cart)}</aside>`
}
