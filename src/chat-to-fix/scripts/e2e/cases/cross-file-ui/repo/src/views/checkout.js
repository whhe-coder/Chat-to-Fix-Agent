import { t } from '../i18n.js'

/** The checkout page. A removed line is not listed and not counted. */
export function renderCheckout(cart) {
  const lines = cart.items.filter((line) => !line.removed)
  if (lines.length === 0) return `<main class="checkout"><h1>${t('checkout.title')}</h1><p>${t('checkout.empty')}</p></main>`
  const copies = lines.reduce((sum, line) => sum + line.quantity, 0)
  const rows = lines.map((line) => `<li>${line.title} × ${line.quantity}</li>`).join('')
  return `<main class="checkout"><h1>${t('checkout.title')}</h1><ul>${rows}</ul><p class="checkout__count">${t('checkout.items', { count: copies })}</p></main>`
}
