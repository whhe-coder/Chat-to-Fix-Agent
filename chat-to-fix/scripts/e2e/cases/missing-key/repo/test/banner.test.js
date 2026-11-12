import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPromoBanner } from '../src/components/promoBanner.js'
import { renderProductRow } from '../src/components/productRow.js'

test('the promo banner has a "Buy now" button', () => {
  const html = renderPromoBanner({ title: 'Space Miner', salePercent: 30 })
  assert.match(html, /<button[^>]*promo-banner__buy[^>]*>Buy now<\/button>/)
  assert.match(html, /-30%/)
})

test('a free product row shows "Free"', () => {
  assert.match(renderProductRow({ title: 'Tiny Farm', price: 0 }), /Free/)
})
