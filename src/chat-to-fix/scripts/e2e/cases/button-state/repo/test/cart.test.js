import test from 'node:test'
import assert from 'node:assert/strict'
import { renderBuyButton, renderCartPanel } from '../src/components/cartPanel.js'

test('the buy button is disabled when the cart is empty', () => {
  const html = renderBuyButton({ items: [] })
  assert.match(html, /<button[^>]* disabled/)
  assert.match(html, /is-disabled/)
})

test('the buy button is enabled when the cart has items', () => {
  const html = renderBuyButton({ items: [{ id: 'a', title: 'Space Miner', price: 19.99 }] })
  assert.doesNotMatch(html, / disabled/)
})

test('the panel lists the items and the buy button', () => {
  const html = renderCartPanel({ items: [{ id: 'a', title: 'Space Miner', price: 19.99 }] })
  assert.match(html, /Space Miner \$19\.99/)
  assert.match(html, />Buy now<\/button>/)
})
