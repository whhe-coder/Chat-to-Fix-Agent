// The one price table and the cost math (token billing per task).
//
// Prices are Anthropic first-party list prices in USD per million tokens, taken from the claude-api
// skill's pricing table (cached 2026-11-03). They are a default only: the configuration key
// `pricing` ({ "<model id>": { input, output, cacheRead, cacheWrite?, cacheWrite1h? } }) replaces or
// adds rows, so a price change needs no code change.
//   - cacheWrite is the 5-minute-TTL rate (1.25 x input); cacheWrite1h is the 1-hour rate (2 x input).
//     DSH reports one `cacheWriteTokens` figure without the TTL, so the 5-minute rate is used for it.
//   - claude-haiku-5-5 is listed at its price for prompts up to 100K tokens.
//   - The Coding bot's cost does not come from this table: Claude Code reports its own costUSD per
//     model (src/engine/claude.ts), which is authoritative. The table prices the four API bots, and
//     the Coding bot only when the CLI sent no cost.
// A model that is not in the table has no price: the cost is null and the record is marked unpriced.
// A price is never guessed.

/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h?: number }} Price */

const row = (input, output, cacheRead) => Object.freeze({ input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 })

export const DEFAULT_PRICING = Object.freeze({
  'claude-sonnet-5-5': row(2.0, 10.0, 0.1),
  'claude-opus-5-5': row(4.0, 20.0, 0.2),
  'claude-haiku-5-5': row(0.1, 0.5, 0.005), // cacheRead: not in the source; 5% of input like the other two (derived)
})

const PER_MILLION = 1_000_000

/**
 * The key a model id is looked up under: no provider prefix (`anthropic/`, `claude-code/`), no
 * context-window suffix (`[1m]`), no trailing date (`-20261101`), lower case.
 */
export function normalizeModel(model) {
  if (typeof model !== 'string') return ''
  let id = model.trim().toLowerCase()
  id = id.slice(id.lastIndexOf('/') + 1)
  id = id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  return id
}

/** The table in force: the defaults with the configured `pricing` rows on top. */
export function priceTable(configured) {
  const table = { ...DEFAULT_PRICING }
  if (configured !== null && typeof configured === 'object') {
    for (const [model, price] of Object.entries(configured)) table[normalizeModel(model)] = price
  }
  return table
}

/** The price row of a model, or undefined when it is not in the table. */
export function priceOf(model, table = DEFAULT_PRICING) {
  const key = normalizeModel(model)
  return key !== '' && Object.hasOwn(table, key) ? table[key] : undefined
}

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/**
 * Cost in USD of one call: `{ input, output, cacheRead, cacheWrite }` are token counts, `input`
 * being the uncached input only (as Anthropic and DSH report it). Returns null for a model with no
 * price. `cacheWriteTtl` '1h' selects the one-hour write rate (when the row has one).
 */
export function costOf(model, tokens, table = DEFAULT_PRICING, { cacheWriteTtl = '5m' }: any = {}) {
  const price = priceOf(model, table)
  if (price === undefined) return null
  const write = cacheWriteTtl === '1h' && price.cacheWrite1h !== undefined ? price.cacheWrite1h : (price.cacheWrite ?? price.input * 1.25)
  const usd = (count(tokens?.input) * price.input
    + count(tokens?.output) * price.output
    + count(tokens?.cacheRead) * price.cacheRead
    + count(tokens?.cacheWrite) * write) / PER_MILLION
  return Number(usd.toFixed(8))
}

/** Checks the configured `pricing` object; returns problem texts (keys only). */
export function pricingProblems(pricing) {
  if (pricing === undefined) return []
  if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) return ['pricing must be an object']
  const problems = []
  for (const [model, price] of Object.entries(pricing)) {
    if (price === null || typeof price !== 'object' || Array.isArray(price)) { problems.push(`pricing.${model} must be an object`); continue }
    for (const key of ['input', 'output', 'cacheRead']) {
      const value = (price as any)[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) problems.push(`pricing.${model}.${key} must be a number of at least 0 (USD per million tokens)`)
    }
    for (const key of ['cacheWrite', 'cacheWrite1h']) {
      const value = (price as any)[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) problems.push(`pricing.${model}.${key} must be a number of at least 0`)
    }
  }
  return problems
}
