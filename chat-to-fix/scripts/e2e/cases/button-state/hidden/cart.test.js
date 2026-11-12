import test from 'node:test'
import assert from 'node:assert/strict'
import { renderBuyButton, renderCartPanel } from '../src/components/cartPanel.js'

const item = (id) => ({ id, title: `Game ${id}`, price: 9.5 })

test('empty cart: the button is disabled and marked', () => {
  const html = renderBuyButton({ items: [] })
  assert.match(html, /<button class="btn btn-primary is-disabled" disabled aria-disabled="true">Buy now<\/button>/)
})

test('one or more items: the button is enabled and not marked', () => {
  for (const items of [[item('a')], [item('a'), item('b'), item('c')]]) {
    assert.equal(renderBuyButton({ items }), '<button class="btn btn-primary">Buy now</button>')
  }
})

test('the panel still shows the empty message and the list', () => {
  assert.match(renderCartPanel({ items: [] }), /Your cart is empty/)
  const html = renderCartPanel({ items: [item('a')] })
  assert.match(html, /Game a \$9\.50/)
  assert.doesNotMatch(html, /is-disabled/)
})
