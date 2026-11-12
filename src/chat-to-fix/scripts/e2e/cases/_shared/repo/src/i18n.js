// Tiny i18n for the store client: t(key) looks the key up in src/locales/en.json.
// A key that is missing from the file is returned as it is (so the UI shows the raw key).
import { readFileSync } from 'node:fs'

const en = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8'))

export function t(key, params = {}) {
  const text = Object.hasOwn(en, key) ? en[key] : key
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}
