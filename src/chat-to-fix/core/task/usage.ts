// Usage records and the running summary of a task (token billing per task).
//
// A usage record is one entry of the execution record (type 'usage'), one per model call or CLI turn
// (the Coding bot: one per model of the turn, so the reviewer's model shows up separately):
//   { type: 'usage', role, botId, run, step, at, model, effort?, input, output, cacheRead, cacheWrite,
//     costUsd (number | null), unpriced, source: 'dsh' | 'cli', durationMs, ttftMs?, outputTps (number | null),
//     tpsBasis: 'dsh-decode' | 'cli-api' | 'cli-wall' | null, tpsTokens?, failed?, text }
// where `input` is the uncached input only. Where the figures come from:
//   source 'dsh': DSH's own per-session projections (tokenUsage and sessionStats, read at the start and the end of a
//                 round, see core/task/botlayer.ts), one record per round; the cost is computed from the price table
//                 (DSH reports none). `tpsTokens` is DSH's decodeTokens, the output tokens of the timed span.
//   source 'cli': the Claude Code `result` event (core/engine/claude.ts); the cost is the CLI's own costUSD, and the
//                 speed is output tokens / duration_api_ms (cli-api) or / duration_ms (cli-wall), derived here.
//
// The summary kept on the task (task.usage) is updated as records arrive (store.addUsage):
//   { totalUsd, input, output, cacheRead, cacheWrite, calls, unpriced, tpsTokens, tpsMs, outputTps,
//     byRole: { <role>: Bucket }, byModel: { <model>: Bucket }, byRun: { <run no>: Bucket } }
// Bucket = { usd, input, output, cacheRead, cacheWrite, calls, unpriced, tpsTokens, tpsMs, outputTps, models: [..],
//            sources: [..], last: { model, outputTps, tpsBasis, effort } }
// `unpriced` is true as soon as one record had no price; its cost is left out of the totals (never guessed).
// The overall speed is the sum of output tokens over the sum of timed generation seconds, as DSH does.

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const round = (value, digits) => Number(value.toFixed(digits))

export const blankBucket = (): any => ({
  usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, unpriced: false,
  tpsTokens: 0, tpsMs: 0, outputTps: null, models: [], sources: [], last: null,
})

export const blankUsage = (): any => ({ ...blankBucket(), totalUsd: 0, byRole: {}, byModel: {}, byRun: {} })

/** Output tokens per second of one timed span; null when there is no time or no tokens. */
export function tpsOf(tokens, ms) {
  return num(tokens) > 0 && num(ms) > 0 ? round(tokens / (ms / 1000), 2) : null
}

function addTo(bucket, record): any {
  const next = { ...blankBucket(), ...bucket }
  next.input += num(record.input)
  next.output += num(record.output)
  next.cacheRead += num(record.cacheRead)
  next.cacheWrite += num(record.cacheWrite)
  next.calls += 1
  if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) next.usd = round(next.usd + record.costUsd, 8)
  else next.unpriced = true
  if (record.outputTps !== null && record.outputTps !== undefined && num(record.durationMs) > 0) {
    next.tpsTokens += num(record.tpsTokens ?? record.output)
    next.tpsMs += num(record.durationMs)
  }
  next.outputTps = tpsOf(next.tpsTokens, next.tpsMs)
  next.models = record.model && !next.models.includes(record.model) ? [...next.models, record.model] : next.models
  next.sources = record.source && !next.sources.includes(record.source) ? [...next.sources, record.source] : next.sources
  next.last = { model: record.model ?? null, outputTps: record.outputTps ?? null, tpsBasis: record.tpsBasis ?? null, effort: record.effort ?? null }
  return next
}

/**
 * The summary with one usage record added. Pure: returns a new object.
 * `record.run` selects the byRun bucket (a record without a run counts in "0").
 */
export function addUsage(summary, record): any {
  const base = summary && typeof summary === 'object' ? summary : blankUsage()
  const total = addTo(base, record)
  const role = record.role ?? 'unknown'
  const model = record.model ?? 'unknown'
  const run = String(record.run ?? 0)
  return {
    ...total,
    totalUsd: total.usd,
    byRole: { ...base.byRole, [role]: addTo(base.byRole?.[role], record) },
    byModel: { ...base.byModel, [model]: addTo(base.byModel?.[model], record) },
    byRun: { ...base.byRun, [run]: addTo(base.byRun?.[run], record) },
  }
}

function mergeBuckets(a, b) {
  const x = { ...blankBucket(), ...a }
  const y = { ...blankBucket(), ...b }
  const out = { ...x }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'tpsTokens', 'tpsMs']) out[key] = num(x[key]) + num(y[key])
  out.usd = round(num(x.usd) + num(y.usd), 8)
  out.unpriced = x.unpriced === true || y.unpriced === true
  out.outputTps = tpsOf(out.tpsTokens, out.tpsMs)
  out.models = [...new Set([...(x.models ?? []), ...(y.models ?? [])])]
  out.sources = [...new Set([...(x.sources ?? []), ...(y.sources ?? [])])]
  out.last = y.last ?? x.last
  return out
}

/** The sum of several task summaries (the e2e report's total over its cases). Pure; a missing summary counts as empty. */
export function mergeUsage(list) {
  let sum: any = blankUsage()
  for (const usage of list ?? []) {
    if (!usage || typeof usage !== 'object') continue
    const next: any = { ...mergeBuckets(sum, usage), byRole: { ...sum.byRole }, byModel: { ...sum.byModel }, byRun: {} }
    for (const [role, bucket] of Object.entries(usage.byRole ?? {})) next.byRole[role] = mergeBuckets(next.byRole[role], bucket)
    for (const [model, bucket] of Object.entries(usage.byModel ?? {})) next.byModel[model] = mergeBuckets(next.byModel[model], bucket)
    next.totalUsd = next.usd
    sum = next
  }
  return sum
}

/** The summary of a list of usage records (a record of another type is skipped). */
export function summarize(records): any {
  let summary = blankUsage()
  for (const record of records ?? []) if (record?.type === 'usage') summary = addUsage(summary, record)
  return summary
}

// ----------------------------------------------------------------------------- display

/** "$0.42" (two decimals from one cent up, four below), "$0" for zero, "-" for none. */
export function fmtUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (value === 0) return '$0'
  return `$${value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`
}

/** 950 -> "950", 12_300 -> "12.3k", 1_250_000 -> "1.25M". */
export function fmtTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (value >= 1_000_000) return `${round(value / 1_000_000, 2)}M`
  if (value >= 10_000) return `${round(value / 1000, 1)}k`
  if (value >= 1000) return `${round(value / 1000, 2)}k`
  return String(Math.round(value))
}

/** "52 tok/s" (one decimal under 10), "-" for none. */
export function fmtTps(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${value < 10 ? round(value, 1) : Math.round(value)} tok/s`
}

/** Where a speed figure comes from, in the words of the debug page and the report. */
export const TPS_BASIS_LABEL = Object.freeze({
  'dsh-decode': 'DSH 统计（sessionStats：decodeTokens ÷ decodeMs）',
  'cli-api': '推算（CLI 输出 token ÷ duration_api_ms）',
  'cli-wall': '推算（CLI 输出 token ÷ duration_ms）',
})

/**
 * "花费 $0.42 · 输入 120k / 输出 8k / 缓存读 300k · 输出速度 52 tok/s" for a summary or bucket;
 * "(含未定价)" when part of the usage had no price.
 */
export function usageLine(summary) {
  if (!summary || !(summary.calls > 0)) return ''
  const usd = summary.totalUsd ?? summary.usd
  const parts = [
    `花费 ${fmtUsd(usd)}${summary.unpriced ? '（含未定价）' : ''}`,
    `输入 ${fmtTokens(summary.input)} / 输出 ${fmtTokens(summary.output)} / 缓存读 ${fmtTokens(summary.cacheRead)}${summary.cacheWrite > 0 ? ` / 缓存写 ${fmtTokens(summary.cacheWrite)}` : ''}`,
  ]
  if (summary.outputTps !== null && summary.outputTps !== undefined) parts.push(`输出速度 ${fmtTps(summary.outputTps)}`)
  return parts.join(' · ')
}

// ----------------------------------------------------------------------------- views for the debug page
// Display-ready objects, built on the server so the page itself only prints strings.

/** "DSH" for a speed taken from DSH's sessionStats, "推算" for one derived from the CLI result. */
export const TPS_TAG = Object.freeze({ 'dsh-decode': 'DSH', 'cli-api': '推算', 'cli-wall': '推算' })

const viewOfBucket = (b) => ({
  calls: b.calls ?? 0,
  costText: `${fmtUsd(b.usd ?? b.totalUsd)}${b.unpriced ? '（含未定价）' : ''}`,
  tokensText: `输入 ${fmtTokens(b.input)} / 输出 ${fmtTokens(b.output)} / 缓存读 ${fmtTokens(b.cacheRead)}${b.cacheWrite > 0 ? ` / 缓存写 ${fmtTokens(b.cacheWrite)}` : ''}`,
  tpsText: b.outputTps === null || b.outputTps === undefined ? '' : fmtTps(b.outputTps),
  unpriced: b.unpriced === true,
})

/**
 * What the page shows for a task's usage summary (task.usage):
 *   { calls, line, title, costText, tokensText, tpsText, tpsParts: [{ tag, tpsText }], unpriced,
 *     byRole: { <role>: { models, modelText, effort, costText, tokensText, tpsText, tpsTag, tpsLabel, unpriced, subtitle } } }
 * `line` is the header text ("花费 $0.42 · 输入 120k / 输出 8k / 缓存读 300k · 平均 74 tok/s（DSH 52 · 推算 120）");
 * the speed of the API bots is DSH's, the Coding bot's is derived, so the average is shown with both parts.
 * null when nothing has been billed yet.
 */
export function usageView(usage) {
  if (!usage || !(usage.calls > 0)) return null
  const total = viewOfBucket(usage)
  const sums = { dsh: { tokens: 0, ms: 0 }, cli: { tokens: 0, ms: 0 } }
  const byRole = {}
  for (const [role, b] of Object.entries<any>(usage.byRole ?? {})) {
    const own = viewOfBucket(b)
    const basis = b.last?.tpsBasis ?? null
    const tag = basis === null ? null : TPS_TAG[basis] ?? null
    const side = (b.sources ?? []).includes('cli') ? sums.cli : sums.dsh
    side.tokens += b.tpsTokens ?? 0
    side.ms += b.tpsMs ?? 0
    const modelText = (b.models ?? []).join(', ')
    byRole[role] = {
      models: b.models ?? [], modelText, effort: b.last?.effort ?? null, ...own, tpsTag: tag, tpsLabel: basis === null ? '' : TPS_BASIS_LABEL[basis] ?? '',
      subtitle: [modelText, own.costText, own.tpsText ? `${own.tpsText}${tag ? ` ${tag}` : ''}` : ''].filter(Boolean).join(' · '),
    }
  }
  const tpsParts = [
    { tag: 'DSH', tpsText: fmtTps(tpsOf(sums.dsh.tokens, sums.dsh.ms)) },
    { tag: '推算', tpsText: fmtTps(tpsOf(sums.cli.tokens, sums.cli.ms)) },
  ].filter((part) => part.tpsText !== '-')
  const parts = [`花费 ${total.costText}`, total.tokensText]
  if (total.tpsText) parts.push(`平均 ${total.tpsText}${tpsParts.length > 0 ? `（${tpsParts.map((p) => `${p.tag} ${p.tpsText.replace(' tok/s', '')}`).join(' · ')}）` : ''}`)
  const title = [
    `${usage.calls} 次调用；${total.tokensText}`,
    '速度 = 输出 token ÷ 计时秒数，按总数相除。DSH：API bot 的速度，取自 DSH 的 sessionStats 统计（decodeTokens ÷ decodeMs）；推算：修复 bot 的速度，由 CLI 结果推算（输出 token ÷ duration_api_ms）。',
    ...Object.entries<any>(byRole).map(([role, r]) => `${role}：${r.subtitle}`),
    ...(usage.unpriced ? ['有调用的模型不在价格表里，它们没有计入花费。'] : []),
  ].join('\n')
  return { calls: usage.calls, line: parts.join(' · '), title, costText: total.costText, tokensText: total.tokensText, tpsText: total.tpsText, tpsParts, unpriced: total.unpriced, byRole }
}

/**
 * The usage of one round of a bot (its usage records since its previous round end), for the arrow popup:
 *   { title, brief, lines: [..], unpriced } or null; `brief` is the short tag next to a chat message ("$0.0123 · 53 tok/s DSH"). One line per model: cost, tokens, time, speed with its source, time to first token.
 */
export function roundView(records) {
  const list = (records ?? []).filter((r) => r?.type === 'usage')
  if (list.length === 0) return null
  const byModel = new Map()
  for (const r of list) byModel.set(r.model ?? 'unknown', [...(byModel.get(r.model ?? 'unknown') ?? []), r])
  const lines = []
  let unpriced = false
  for (const [model, rows] of byModel) {
    const sum = summarize(rows)
    unpriced = unpriced || sum.unpriced
    const v = viewOfBucket(sum)
    const basis = [...rows].reverse().find((r) => r.tpsBasis)?.tpsBasis ?? null
    const ttft = rows.filter((r) => typeof r.ttftMs === 'number')
    const ms = sum.tpsMs
    lines.push([
      model + (rows.find((r) => r.effort)?.effort ? `（effort ${rows.find((r) => r.effort).effort}）` : ''),
      `花费 ${v.costText}`, v.tokensText, `${rows.length} 次调用${rows.some((r) => r.failed) ? '（含失败的调用）' : ''}`,
      ms > 0 ? `计时 ${round(ms / 1000, 1)} s` : '',
      v.tpsText ? `输出速度 ${v.tpsText}（${TPS_BASIS_LABEL[basis] ?? '来源未知'}）` : '',
      ttft.length > 0 ? `首 token ${Math.round(ttft.reduce((s, r) => s + r.ttftMs, 0) / ttft.length)} ms（DSH 统计）` : '',
    ].filter(Boolean).join(' · '))
  }
  const all = viewOfBucket(summarize(list))
  const tag = TPS_TAG[[...list].reverse().find((r) => r.tpsBasis)?.tpsBasis] ?? ''
  return { title: `本轮用量 · ${list.length} 次调用`, lines, unpriced, brief: [all.costText, all.tpsText ? `${all.tpsText}${tag ? ` ${tag}` : ''}` : ''].filter(Boolean).join(' · ') }
}
