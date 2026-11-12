import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRICING, costOf, normalizeModel, priceOf, priceTable, pricingProblems } from '../core/task/pricing.ts'
import { addUsage, blankUsage, fmtTokens, fmtTps, fmtUsd, summarize, tpsOf, usageLine } from '../core/task/usage.ts'

test('the default table holds the three models at the cached list prices', () => {
  assert.deepEqual({ ...DEFAULT_PRICING['claude-sonnet-5-5'] }, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 })
  assert.deepEqual({ ...DEFAULT_PRICING['claude-opus-5-5'] }, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })
  assert.equal(DEFAULT_PRICING['claude-haiku-5-5'].input, 0.1)
  assert.equal(DEFAULT_PRICING['claude-haiku-5-5'].output, 0.5)
})

test('costOf: input, output, cache read and cache write each at their own rate', () => {
  // 1M of each on Sonnet 5.5: 2 + 10 + 0.1 + 2.5 = 14.6 USD
  assert.equal(costOf('claude-sonnet-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 14.6)
  // the first call of the real T-1 run: 4 input, 53 output, 9047 cache write
  assert.equal(costOf('anthropic/claude-sonnet-5-5', { input: 4, output: 53, cacheWrite: 9047 }), Number(((4 * 2 + 53 * 10 + 9047 * 2.5) / 1e6).toFixed(8)))
  assert.equal(costOf('claude-opus-5-5', { input: 1000, output: 1000 }), 0.024)
  assert.equal(costOf('claude-sonnet-5-5', { cacheWrite: 1e6 }, DEFAULT_PRICING, { cacheWriteTtl: '1h' }), 4)
  assert.equal(costOf('claude-sonnet-5-5', {}), 0)
  assert.equal(costOf('claude-sonnet-5-5', { input: -5, output: Number.NaN }), 0, 'junk counts are ignored')
})

test('costOf: a model that is not in the table has no price (null, never a guess)', () => {
  assert.equal(costOf('claude-mystery-9', { input: 1000, output: 1000 }), null)
  assert.equal(costOf('', { input: 1 }), null)
  assert.equal(costOf(undefined, { input: 1 }), null)
  assert.equal(priceOf('toString'), undefined, 'a prototype name is not a model')
})

test('normalizeModel drops the provider, the [1m] suffix and a trailing date', () => {
  assert.equal(normalizeModel('anthropic/claude-sonnet-5-5'), 'claude-sonnet-5-5')
  assert.equal(normalizeModel('claude-code/claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(normalizeModel('claude-sonnet-5-5[1m]'), 'claude-sonnet-5-5')
  assert.equal(normalizeModel('Claude-Sonnet-5-5-20261101'), 'claude-sonnet-5-5')
  assert.equal(costOf('claude-sonnet-5-5-20261101', { input: 1e6 }), 2)
})

test('the configured pricing replaces and extends the table', () => {
  const table = priceTable({ 'claude-sonnet-5-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, 'my-model': { input: 1, output: 2, cacheRead: 0 } })
  assert.equal(costOf('claude-sonnet-5-5', { input: 1e6 }, table), 3)
  assert.equal(costOf('my-model', { input: 1e6, output: 1e6, cacheWrite: 1e6 }, table), 1 + 2 + 1.25, 'cacheWrite defaults to 1.25 x input')
  assert.equal(costOf('claude-opus-5-5', { input: 1e6 }, table), 4, 'rows not named keep the default')
  assert.deepEqual(pricingProblems({ x: { input: 1, output: 2, cacheRead: 0 } }), [])
  assert.deepEqual(pricingProblems({ x: { input: -1, output: 'a' } }).length, 3)
  assert.deepEqual(pricingProblems([]), ['pricing must be an object'])
})

test('tpsOf and the display formats', () => {
  assert.equal(tpsOf(100, 2000), 50)
  assert.equal(tpsOf(0, 2000), null)
  assert.equal(tpsOf(100, 0), null)
  assert.equal(fmtUsd(0.42), '$0.42')
  assert.equal(fmtUsd(0.0042), '$0.0042')
  assert.equal(fmtUsd(0), '$0')
  assert.equal(fmtUsd(null), '-')
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(12_300), '12.3k')
  assert.equal(fmtTokens(1_250_000), '1.25M')
  assert.equal(fmtTps(52.4), '52 tok/s')
  assert.equal(fmtTps(5.26), '5.3 tok/s')
  assert.equal(fmtTps(null), '-')
})

const rec = (over = {}) => ({ type: 'usage', role: 'main', run: 1, model: 'claude-sonnet-5-5', source: 'dsh', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, costUsd: 0.01, durationMs: 2000, outputTps: 50, tpsBasis: 'dsh-decode', ...over })

test('addUsage keeps totals by role, model and run, and the speed as sum of tokens over sum of time', () => {
  let usage = blankUsage()
  usage = addUsage(usage, rec())
  usage = addUsage(usage, rec({ output: 300, durationMs: 2000, outputTps: 150, costUsd: 0.03 }))
  usage = addUsage(usage, rec({ role: 'coding', model: 'claude-opus-5-5', source: 'cli', run: 2, costUsd: 1.5, effort: 'high', tpsBasis: 'cli-api', output: 400, durationMs: 4000, outputTps: 100 }))
  assert.equal(usage.totalUsd, 1.54)
  assert.equal(usage.calls, 3)
  assert.equal(usage.output, 800)
  assert.equal(usage.unpriced, false)
  assert.equal(usage.byRole.main.usd, 0.04)
  assert.equal(usage.byRole.main.outputTps, 100, '(100+300) tokens / 4 s')
  assert.deepEqual(usage.byRole.coding.models, ['claude-opus-5-5'])
  assert.deepEqual(usage.byRole.coding.sources, ['cli'])
  assert.deepEqual(usage.byRole.coding.last, { model: 'claude-opus-5-5', outputTps: 100, tpsBasis: 'cli-api', effort: 'high' })
  assert.deepEqual(Object.keys(usage.byModel).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.equal(usage.byRun['1'].calls, 2)
  assert.equal(usage.byRun['2'].usd, 1.5)
  assert.equal(usage.outputTps, 100, '800 tokens / 8 s')
})

test('an unpriced record is counted but adds no cost and marks the totals unpriced', () => {
  const usage = summarize([rec(), rec({ role: 'jira', model: 'mystery', costUsd: null }), { type: 'line', text: 'x' }])
  assert.equal(usage.calls, 2)
  assert.equal(usage.totalUsd, 0.01)
  assert.equal(usage.unpriced, true)
  assert.equal(usage.byRole.jira.unpriced, true)
  assert.equal(usage.byRole.main.unpriced, false)
  assert.equal(usage.byModel.mystery.usd, 0)
  assert.match(usageLine(usage), /未定价/)
})

test('a record without timing leaves the speed alone', () => {
  const usage = addUsage(addUsage(blankUsage(), rec({ durationMs: 0, outputTps: null, tpsBasis: null })), rec())
  assert.equal(usage.tpsMs, 2000)
  assert.equal(usage.tpsTokens, 100)
})

test('usageLine reads like the page header', () => {
  const usage = summarize([rec({ input: 120_000, output: 8000, cacheRead: 300_000, cacheWrite: 0, costUsd: 0.42, durationMs: 160_000, outputTps: 50 })])
  assert.equal(usageLine(usage), '花费 $0.42 · 输入 120k / 输出 8k / 缓存读 300k · 输出速度 50 tok/s')
  assert.equal(usageLine(blankUsage()), '')
})
