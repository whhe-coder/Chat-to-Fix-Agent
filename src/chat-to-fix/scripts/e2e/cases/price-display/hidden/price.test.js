import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPrice, formatDiscount } from '../src/format.js'
import { renderProductCard } from '../src/components/productCard.js'

test('thousands separator and two decimals', () => {
  assert.equal(formatPrice(1000), '$1,000.00')
  assert.equal(formatPrice(12.5), '$12.50')
  assert.equal(formatPrice(59.99), '$59.99')
  assert.equal(formatPrice(1234567.891), '$1,234,567.89')
  assert.equal(formatPrice(0.1 + 0.2), '$0.30')
  assert.equal(formatPrice(999.999), '$1,000.00')
})

test('free, missing and discount output did not change', () => {
  assert.equal(formatPrice(0), 'Free')
  assert.equal(formatPrice(null), '—')
  assert.equal(formatPrice(undefined), '—')
  assert.equal(formatDiscount(25), '-25%')
})

test('the product card shows the formatted price', () => {
  assert.match(renderProductCard({ title: 'X', price: 1000 }), /<p class="product-card__price">\$1,000\.00<\/p>/)
  assert.match(renderProductCard({ title: 'X', price: 12.5 }), /\$12\.50/)
})
