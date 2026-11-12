import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declarationsOf } from './lib/css.js'

const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8')

test('the product card has the 8px corner radius of the design', () => {
  assert.equal(declarationsOf(read('card.css'), '.product-card')['border-radius'], '8px')
})

test('the buy button on a card has the 6px corner radius of the design', () => {
  assert.equal(declarationsOf(read('card.css'), '.product-card__buy')['border-radius'], '6px')
})

test('other buttons keep 4px', () => {
  assert.equal(declarationsOf(read('button.css'), '.btn')['border-radius'], '4px')
})
