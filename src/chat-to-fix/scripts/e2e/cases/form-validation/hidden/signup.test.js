import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderSignupForm, validate } from '../src/components/signupForm.js'

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))
const GOOD = 'longenough'
const state = (email, password, extra = {}) => ({ values: { email, password }, touched: {}, ...extra })
const buttonDisabled = (html) => /<button[^>]* disabled/.test(html)

test('email validation', () => {
  for (const bad of ['abc@', 'abc', '@b.co', 'a b@c.com', 'abc@.com', 'abc@x.']) assert.ok(validate({ email: bad, password: GOOD }).email, bad)
  for (const good of ['player@example.com', 'a.b+c@mail.example.org']) assert.equal(validate({ email: good, password: GOOD }).email, undefined, good)
  assert.ok(validate({ email: '', password: GOOD }).email)
})

test('password validation did not change', () => {
  assert.ok(validate({ email: 'a@b.co', password: 'short' }).password)
  assert.equal(validate({ email: 'a@b.co', password: '12345678' }).password, undefined)
})

test('an invalid email shows a readable message under the field once touched', () => {
  const html = renderSignupForm(state('abc@', GOOD, { touched: { email: true } }))
  assert.match(html, /<p class="field-error"[^>]*>[^<]*valid email[^<]*<\/p>/i)
  assert.doesNotMatch(html, /form\.email_invalid/)
  assert.equal((html.match(/field-error/g) ?? []).length, 1)
})

test('no message before the player touched or submitted; messages for every bad field after submit', () => {
  assert.doesNotMatch(renderSignupForm(state('', '')), /field-error/)
  assert.doesNotMatch(renderSignupForm(state('player@example.com', GOOD, { touched: { email: true } })), /field-error/)
  const html = renderSignupForm(state('', 'x', { submitted: true }))
  assert.match(html, /Enter your email address/)
  assert.match(html, /at least 8 characters/)
})

test('the submit button follows validity', () => {
  assert.equal(buttonDisabled(renderSignupForm(state('abc@', GOOD))), true)
  assert.equal(buttonDisabled(renderSignupForm(state('player@example.com', 'short'))), true)
  assert.equal(buttonDisabled(renderSignupForm(state('', ''))), true)
  assert.equal(buttonDisabled(renderSignupForm(state('player@example.com', GOOD))), false)
  assert.match(renderSignupForm(state('player@example.com', GOOD)), />Create account<\/button>/)
})

test('the existing copy is unchanged and the new copy is readable', () => {
  assert.equal(en['form.email_required'], 'Enter your email address')
  assert.equal(en['form.password_short'], 'Password must be at least 8 characters')
  assert.equal(en['form.submit'], 'Create account')
  assert.match(en['form.email_invalid'] ?? '', /valid email/i)
})
