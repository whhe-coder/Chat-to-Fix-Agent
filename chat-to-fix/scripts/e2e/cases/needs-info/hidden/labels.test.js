import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderCheckout } from '../src/components/checkoutPanel.js'
import { renderCartPanel } from '../src/components/cartPanel.js'
import { renderProductCard } from '../src/components/productCard.js'

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))

test('the pay button of the checkout page reads "Place order"', () => {
  assert.equal(en['checkout.pay'], 'Place order')
  assert.match(renderCheckout({ total: 19.99 }), /<button[^>]*checkout__pay[^>]*>Place order<\/button>/)
})

test('the other buttons keep their labels', () => {
  assert.match(renderCartPanel({ items: [] }), />Buy now<\/button>/)
  assert.match(renderProductCard({ title: 'X', price: 1, owned: false }), />Purchase<\/button>/)
})

test('nothing else in en.json changed', () => {
  assert.deepEqual({ ...en, 'checkout.pay': 'x' }, {
    'nav.store': 'Store',
    'nav.library': 'Library',
    'nav.cart': 'Cart',
    'card.purchase': 'Purchase',
    'card.owned': 'Owned in library',
    'card.add_to_cart': 'Add to cart',
    'cart.title': 'Your cart',
    'cart.buy_now': 'Buy now',
    'checkout.title': 'Checkout',
    'checkout.pay': 'x',
  })
})
