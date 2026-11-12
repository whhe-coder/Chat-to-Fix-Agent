import test from 'node:test'
import assert from 'node:assert/strict'
import { renderProductCard } from '../src/components/productCard.js'
import { renderHeader } from '../src/components/header.js'

test('the buy button of a product card reads "Purchase"', () => {
  const html = renderProductCard({ title: 'Space Miner', price: 19.99, owned: false })
  assert.match(html, />Purchase<\/button>/)
})

test('an owned product shows the owned badge instead of a buy button', () => {
  const html = renderProductCard({ title: 'Space Miner', price: 19.99, owned: true })
  assert.match(html, /Owned in library/)
  assert.doesNotMatch(html, /<button/)
})

test('the header links to store, library and cart', () => {
  const html = renderHeader()
  for (const label of ['Store', 'Library', 'Cart']) assert.ok(html.includes(`>${label}</a>`), label)
})
