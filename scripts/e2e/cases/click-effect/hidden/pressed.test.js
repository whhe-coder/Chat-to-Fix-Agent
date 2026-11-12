import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declarationsOf, selectorsOf } from './css.js'

const css = readFileSync(new URL('../src/styles/button.css', import.meta.url), 'utf8')

test('pressed state of the primary button', () => {
  const pressed = declarationsOf(css, '.btn-primary:active')
  assert.ok(pressed, '.btn-primary:active is missing')
  assert.match(pressed.transform ?? '', /^scale\(\s*0?\.98\s*\)$/)
  assert.equal(String(pressed.background ?? pressed['background-color']).toLowerCase(), '#1f7a38')
  assert.equal(pressed.transition, undefined, 'the transition belongs on .btn-primary, not on :active')
})

test('the transition is on .btn-primary and covers transform and the background', () => {
  const transition = declarationsOf(css, '.btn-primary').transition ?? ''
  assert.match(transition, /transform/)
  assert.match(transition, /background/)
})

test('no other button changed', () => {
  assert.deepEqual(declarationsOf(css, '.btn'), {
    display: 'inline-block', padding: '8px 16px', border: '0', 'border-radius': '4px', cursor: 'pointer', font: 'inherit',
  })
  assert.deepEqual(declarationsOf(css, '.btn-secondary'), { background: '#3a4656', color: '#ffffff' })
  assert.deepEqual(declarationsOf(css, '.btn-secondary:hover'), { background: '#46546a' })
  assert.deepEqual(declarationsOf(css, '.btn-primary:hover'), { background: '#31b556' })
  const active = selectorsOf(css).filter((s) => s.includes(':active'))
  assert.deepEqual(active, ['.btn-primary:active'])
})
