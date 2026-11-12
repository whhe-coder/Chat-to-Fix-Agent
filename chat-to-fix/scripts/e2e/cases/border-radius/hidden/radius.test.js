import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declarationsOf, parseCss } from './css.js'

const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8')
const card = read('card.css')

test('card 8px, card button 6px', () => {
  assert.equal(declarationsOf(card, '.product-card')['border-radius'], '8px')
  assert.equal(declarationsOf(card, '.product-card__buy')['border-radius'], '6px')
})

test('the rest of the card styles did not change', () => {
  assert.deepEqual({ ...declarationsOf(card, '.product-card'), 'border-radius': '' }, {
    display: 'flex', 'flex-direction': 'column', gap: '8px', padding: '12px', background: '#1b2838', 'border-radius': '', overflow: 'hidden',
  })
  assert.deepEqual(declarationsOf(card, '.product-card__title'), { margin: '0', 'font-size': '16px' })
  assert.deepEqual(declarationsOf(card, '.product-card__price'), { margin: '0', color: '#a4d007' })
  assert.deepEqual({ ...declarationsOf(card, '.product-card__buy'), 'border-radius': '' }, { 'align-self': 'flex-start', 'border-radius': '' })
})

test('other buttons were not touched and nothing uses !important', () => {
  const button = read('button.css')
  assert.equal(declarationsOf(button, '.btn')['border-radius'], '4px')
  assert.equal(declarationsOf(button, '.btn-primary').background, '#2a9d4a')
  assert.equal(parseCss(card).some((rule) => Object.values(rule.decls).some((v) => /!important/.test(v))), false)
})
