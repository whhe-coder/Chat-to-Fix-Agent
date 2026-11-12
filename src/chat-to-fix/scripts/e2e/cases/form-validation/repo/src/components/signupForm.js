import { t } from '../i18n.js'

const EMAIL = /@/

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** The errors of the sign-up form: { email?: <en.json key>, password?: <en.json key> }; no key means the field is fine. */
export function validate(values) {
  const errors = {}
  const email = String(values.email ?? '').trim()
  if (email === '') errors.email = 'form.email_required'
  else if (!EMAIL.test(email)) errors.email = 'form.email_invalid'
  const password = String(values.password ?? '')
  if (password.length < 8) errors.password = 'form.password_short'
  return errors
}

/**
 * The sign-up form. state = { values: { email, password }, touched: { email?, password? }, submitted? }
 * An error message is shown under a field once the player has touched the field OR has tried to submit.
 * The submit button is disabled while the form has any error.
 */
export function renderSignupForm(state) {
  const errors = validate(state.values)
  const field = (name, type) => {
    const shown = state.touched?.[name] && state.submitted
    const message = shown && errors[name] ? `<p class="field-error" role="alert">${t(errors[name])}</p>` : ''
    const value = type === 'password' ? '' : ` value="${escapeHtml(state.values[name] ?? '')}"`
    return `<label class="field"><span>${t(`form.${name}_label`)}</span><input name="${name}" type="${type}"${value}>${message}</label>`
  }
  const disabled = errors.length > 0
  return [
    '<form class="signup-form">',
    field('email', 'email'),
    field('password', 'password'),
    `<button class="btn btn-primary" type="submit"${disabled ? ' disabled' : ''}>${t('form.submit')}</button>`,
    '</form>',
  ].join('')
}
