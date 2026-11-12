import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDiscount, formatPrice } from '../src/price.js'

test('a discount lowers the price', () => {
  assert.equal(applyDiscount(100, 10), 90)
  assert.equal(applyDiscount(200, 50), 100)
  assert.equal(applyDiscount(80, 25), 60)
  assert.equal(applyDiscount(100, 0), 100)
  assert.equal(applyDiscount(100, 100), 0)
  assert.ok(Math.abs(applyDiscount(19.99, 10) - 17.991) < 1e-9)
})

test('formatPrice is unchanged', () => {
  assert.equal(formatPrice(5), '$5.00')
})
