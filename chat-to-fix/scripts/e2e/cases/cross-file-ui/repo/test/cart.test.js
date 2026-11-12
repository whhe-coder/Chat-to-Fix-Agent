import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCartBadge } from '../src/components/header.js'
import { renderCheckout } from '../src/views/checkout.js'

const cart = { items: [{ id: 'a', title: 'Space Miner', quantity: 2 }, { id: 'b', title: 'Tiny Farm', quantity: 1 }] }

test('the cart badge shows the number of copies', () => {
  assert.equal(renderCartBadge(cart), '<span class="cart-badge">3</span>')
})

test('the checkout page lists the lines and the number of copies', () => {
  const html = renderCheckout(cart)
  assert.match(html, /Space Miner × 2/)
  assert.match(html, /3 items/)
})

test('an empty cart shows no badge', () => {
  assert.equal(renderCartBadge({ items: [] }), '')
})
