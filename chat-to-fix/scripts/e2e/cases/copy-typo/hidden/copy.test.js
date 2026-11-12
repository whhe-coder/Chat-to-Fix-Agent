import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderProductCard } from '../src/components/productCard.js'

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))

test('the buy button reads Purchase', () => {
  assert.equal(en['card.purchase'], 'Purchase')
  assert.match(renderProductCard({ title: 'X', price: 1, owned: false }), /<button[^>]*>Purchase<\/button>/)
})

test('nothing else in en.json changed', () => {
  assert.deepEqual({ ...en, 'card.purchase': 'x' }, {
    'nav.store': 'Store',
    'nav.library': 'Library',
    'nav.cart': 'Cart',
    'card.purchase': 'x',
    'card.owned': 'Owned in library',
    'card.add_to_cart': 'Add to cart',
    'checkout.title': 'Checkout',
    'checkout.pay': 'Pay now',
  })
})
