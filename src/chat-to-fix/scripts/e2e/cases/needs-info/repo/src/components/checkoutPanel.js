import { t } from '../i18n.js'

/** The checkout page. order = { total } */
export function renderCheckout(order) {
  return [
    '<section class="checkout">',
    `<h2>${t('checkout.title')}</h2>`,
    `<p class="checkout__total">$${order.total.toFixed(2)}</p>`,
    `<button class="btn btn-primary checkout__pay">${t('checkout.pay')}</button>`,
    '</section>',
  ].join('')
}
