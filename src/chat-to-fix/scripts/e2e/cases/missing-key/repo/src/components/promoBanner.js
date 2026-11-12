import { t } from '../i18n.js'

/** The promo banner at the top of the store front page. game = { title, salePercent } */
export function renderPromoBanner(game) {
  return [
    '<section class="promo-banner">',
    `<h2 class="promo-banner__title">${game.title}</h2>`,
    `<span class="promo-banner__sale">${t('store.sale_badge', { percent: game.salePercent })}</span>`,
    `<button class="btn btn-primary promo-banner__buy">${t('store.buy_now')}</button>`,
    `<button class="btn btn-secondary promo-banner__wishlist">${t('store.wishlist')}</button>`,
    '</section>',
  ].join('')
}
