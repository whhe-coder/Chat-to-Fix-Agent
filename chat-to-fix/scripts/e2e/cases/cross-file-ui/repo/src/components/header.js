import { t } from '../i18n.js'
import { cartCount } from '../cart/count.js'

/** The number on the cart icon; nothing is shown for an empty cart, "99+" above 99. */
export function renderCartBadge(cart) {
  const count = cartCount(cart)
  if (count === 0) return ''
  return `<span class="cart-badge">${count > 99 ? '99+' : count}</span>`
}

export function renderHeader(cart) {
  return `<header class="site-header"><nav><a href="/">${t('nav.store')}</a><a href="/cart">${t('nav.cart')}${renderCartBadge(cart)}</a></nav></header>`
}
