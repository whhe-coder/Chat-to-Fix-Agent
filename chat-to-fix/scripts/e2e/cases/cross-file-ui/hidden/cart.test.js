import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCartBadge, renderHeader } from '../src/components/header.js'
import { renderCheckout } from '../src/views/checkout.js'

const line = (id, quantity, removed) => ({ id, title: `Game ${id}`, quantity, ...(removed ? { removed: true } : {}) })
const badgeNumber = (cart) => Number(/>(\d+)</.exec(renderCartBadge(cart))?.[1])
const checkoutNumber = (cart) => Number(/(\d+) items/.exec(renderCheckout(cart))?.[1])

test('badge and checkout agree for several carts', () => {
  const carts = [
    { items: [line('a', 1)] },
    { items: [line('a', 2), line('b', 1)] },
    { items: [line('a', 3), line('b', 2, true), line('c', 4)] },
    { items: [line('a', 5, true), line('b', 1)] },
  ]
  const expected = [1, 3, 7, 1]
  carts.forEach((cart, i) => {
    assert.equal(badgeNumber(cart), expected[i], `badge ${i}`)
    assert.equal(checkoutNumber(cart), expected[i], `checkout ${i}`)
  })
})

test('badge edge cases keep working', () => {
  assert.equal(renderCartBadge({ items: [] }), '')
  assert.equal(renderCartBadge({ items: [line('a', 2, true)] }), '')
  assert.equal(renderCartBadge({ items: [line('a', 120)] }), '<span class="cart-badge">99+</span>')
  assert.match(renderHeader({ items: [line('a', 2)] }), /Cart<span class="cart-badge">2<\/span>/)
})

test('checkout still lists active lines only', () => {
  const html = renderCheckout({ items: [line('a', 2), line('b', 1, true)] })
  assert.match(html, /Game a × 2/)
  assert.doesNotMatch(html, /Game b/)
  assert.match(renderCheckout({ items: [] }), /Nothing to check out yet/)
})
