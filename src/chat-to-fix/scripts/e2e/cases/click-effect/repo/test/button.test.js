import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declarationsOf } from './lib/css.js'

const css = readFileSync(new URL('../src/styles/button.css', import.meta.url), 'utf8')

test('the primary button has a pressed (:active) state from the design note', () => {
  const pressed = declarationsOf(css, '.btn-primary:active')
  assert.ok(pressed, '.btn-primary:active is missing')
  assert.equal(pressed.transform, 'scale(0.98)')
  assert.equal(pressed.background ?? pressed['background-color'], '#1f7a38')
})

test('the primary button animates the change', () => {
  assert.match(declarationsOf(css, '.btn-primary').transition ?? '', /transform/)
})

test('the hover state of the primary button is unchanged', () => {
  assert.equal(declarationsOf(css, '.btn-primary:hover').background, '#31b556')
})
