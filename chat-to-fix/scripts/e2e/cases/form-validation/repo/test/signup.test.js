import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSignupForm, validate } from '../src/components/signupForm.js'

const state = (email, password, extra = {}) => ({ values: { email, password }, touched: {}, ...extra })

test('a complete email address is valid', () => {
  assert.deepEqual(validate({ email: 'player@example.com', password: 'longenough' }), {})
})

test('"abc@" is not a valid email address', () => {
  assert.ok(validate({ email: 'abc@', password: 'longenough' }).email)
})

test('a touched field with a bad value shows its error message', () => {
  const html = renderSignupForm(state('abc@', 'longenough', { touched: { email: true } }))
  assert.match(html, /<p class="field-error" role="alert">Enter a valid email address<\/p>/)
})

test('the submit button is disabled while the form is invalid and enabled when it is valid', () => {
  assert.match(renderSignupForm(state('abc@', 'longenough')), /<button[^>]* disabled/)
  assert.doesNotMatch(renderSignupForm(state('player@example.com', 'longenough')), /<button[^>]* disabled/)
})
