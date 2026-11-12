import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { renderPromoBanner } from '../src/components/promoBanner.js'

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))

test('the banner button reads Buy now, not the raw key', () => {
  const html = renderPromoBanner({ title: 'X', salePercent: 10 })
  assert.match(html, /<button[^>]*>Buy now<\/button>/)
  assert.doesNotMatch(html, /store\.buy_now/)
})

test('every key the components use exists in en.json', () => {
  const dir = new URL('../src/components/', import.meta.url)
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const match of source.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(en, match[1]), `${file}: ${match[1]}`)
  }
})

test('the existing strings did not change', () => {
  const { 'store.buy_now': _added, ...rest } = en
  assert.deepEqual(rest, {
    'store.add_to_cart': 'Add to cart',
    'store.wishlist': 'Add to wishlist',
    'store.sale_badge': '-{percent}%',
    'store.free': 'Free',
  })
})
