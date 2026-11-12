// The outbox (docs/chat-to-fix/slack/slackbot.md, 4.2 (2)): the messages Chat-to-Fix wants posted into a Slack discussion.
// Append-only file <dataDir>/outbox.jsonl, one JSON line per message, `seq` global from 1 and never reused.
// The company Slack Bot polls GET /outbox?after=<seq> and posts each message; Chat-to-Fix itself holds no Slack token.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const OUTBOX_DEFAULT_LIMIT = 50
export const OUTBOX_MAX_LIMIT = 200

const isText = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * @param {{ dataDir: string, store?: { findByThread: Function }, now?: () => string }} options
 *   `store` is only used to fill `taskId` from the discussion when the caller gives none.
 */
export function createOutbox({ dataDir, store, now = () => new Date().toISOString() }: any) {
  const path = join(dataDir, 'outbox.jsonl')
  let lastSeq: number | undefined
  let chain: Promise<any> = Promise.resolve()
  let lead = '' // '\n' when the file ends in a half-written line, so the next message starts on its own line

  async function readAll() {
    let text
    try { text = await readFile(path, 'utf8') } catch (error: any) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const messages = []
    lead = text !== '' && !text.endsWith('\n') ? '\n' : ''
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const m = JSON.parse(line)
        if (Number.isInteger(m?.seq)) messages.push(m)
      } catch { /* a half-written line: skipped */ }
    }
    return messages
  }

  // Appends are serialized: one at a time, so two replies never get the same seq.
  function serialized(fn) {
    const next = chain.then(fn, fn)
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  /** Adds a message; returns it with its seq. */
  function append({ channel, threadTs, purpose, kind = null, text, taskId }: any) {
    return serialized(async () => {
      if (!isText(channel) || !isText(threadTs)) throw new Error('outbox.append: channel and threadTs are required')
      if (!isText(text)) throw new Error('outbox.append: text is required')
      if (lastSeq === undefined) lastSeq = (await readAll()).reduce((max, m) => Math.max(max, m.seq), 0)
      let id = isText(taskId) ? taskId : null
      if (id === null && store?.findByThread) {
        try { id = (await store.findByThread(channel, threadTs))?.id ?? null } catch { id = null }
      }
      const message = { seq: lastSeq + 1, at: now(), taskId: id, channel, threadTs, purpose: purpose ?? null, kind: kind ?? null, text }
      await mkdir(dataDir, { recursive: true })
      await appendFile(path, `${lead}${JSON.stringify(message)}\n`, 'utf8')
      lead = ''
      lastSeq = message.seq
      return message
    })
  }

  /** The messages with seq > after, oldest first, at most `limit` (default 50, max 200); `next` is the cursor to ask with next time. */
  async function read(after = 0, limit = OUTBOX_DEFAULT_LIMIT) {
    await chain // writes in flight
    const from = Number.isInteger(after) && after >= 0 ? after : 0
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, OUTBOX_MAX_LIMIT) : OUTBOX_DEFAULT_LIMIT
    const messages = (await readAll()).filter((m) => m.seq > from).sort((a, b) => a.seq - b.seq).slice(0, max)
    return { messages, next: messages.length > 0 ? messages[messages.length - 1].seq : from }
  }

  return { append, read, path }
}
