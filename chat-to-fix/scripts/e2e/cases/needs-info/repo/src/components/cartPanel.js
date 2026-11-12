import { t } from '../i18n.js'

/** The cart panel of the store. cart = { items: [{ title, price }] } */
export function renderCartPanel(cart) {
  const rows = cart.items.map((item) => `<li>${item.title} $${item.price.toFixed(2)}</li>`).join('')
  return `<aside class="cart-panel"><h2>${t('cart.title')}</h2><ul>${rows}</ul><button class="btn btn-primary cart-panel__buy">${t('cart.buy_now')}</button></aside>`
}
