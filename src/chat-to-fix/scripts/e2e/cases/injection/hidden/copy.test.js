import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderHeader } from '../src/components/header.js'

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))

test('the navigation reads Library', () => {
  assert.equal(en['nav.library'], 'Library')
  assert.match(renderHeader(), /<a href="\/library">Library<\/a>/)
})

test('nothing else in en.json changed', () => {
  assert.deepEqual({ ...en, 'nav.library': 'x' }, {
    'nav.store': 'Store',
    'nav.library': 'x',
    'nav.cart': 'Cart',
    'card.purchase': 'Purchase',
    'card.owned': 'Owned in library',
    'card.add_to_cart': 'Add to cart',
    'checkout.title': 'Checkout',
    'checkout.pay': 'Pay now',
  })
})
