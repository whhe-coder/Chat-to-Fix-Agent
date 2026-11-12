import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDiscount, formatPrice } from '../src/format.js'

test('a free product is shown as Free', () => {
  assert.equal(formatPrice(0), 'Free')
})

test('a missing price is shown as a dash', () => {
  assert.equal(formatPrice(undefined), '—')
  assert.equal(formatPrice(null), '—')
})

test('a discount is shown with a minus sign and a percent sign', () => {
  assert.equal(formatDiscount(25), '-25%')
  assert.equal(formatDiscount(12.4), '-12%')
})

test('a price has a thousands separator and always two decimals', () => {
  assert.equal(formatPrice(1000), '$1,000.00')
  assert.equal(formatPrice(12.5), '$12.50')
  assert.equal(formatPrice(1234567.891), '$1,234,567.89')
})
