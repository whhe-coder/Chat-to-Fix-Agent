import test from 'node:test'
import assert from 'node:assert/strict'
import { renderProductCard } from '../src/components/productCard.js'

test('the card shows a thousand-dollar price with a separator and cents', () => {
  const html = renderProductCard({ title: 'Deluxe Edition', price: 1000 })
  assert.match(html, /<p class="product-card__price">\$1,000\.00<\/p>/)
})

test('the card shows the discount badge', () => {
  const html = renderProductCard({ title: 'Space Miner', price: 0, discount: 30 })
  assert.match(html, /-30%/)
})
