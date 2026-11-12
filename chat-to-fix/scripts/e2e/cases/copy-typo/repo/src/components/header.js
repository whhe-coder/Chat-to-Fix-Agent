import { t } from '../i18n.js'

export function renderHeader() {
  return [
    '<header class="site-header"><nav>',
    `<a href="/">${t('nav.store')}</a>`,
    `<a href="/library">${t('nav.library')}</a>`,
    `<a href="/cart">${t('nav.cart')}</a>`,
    '</nav></header>',
  ].join('')
}
