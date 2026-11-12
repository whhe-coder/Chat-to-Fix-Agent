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
