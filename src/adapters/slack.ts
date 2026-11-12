// The Slack adapter (spec 4, section 2.2, I5). Two functions only:
//   readThread(origin)               -> [{ user: { id, name }, at, text, files }]
//   reply(origin, purpose, text)     -> the identifier of the message sent (string)
// `origin` is the task's origin ({ channel, threadTs, ... }); the adapter can reach only that
// discussion. The fake keeps its files under <dataDir>/fake/slack/ (spec 4, section 2.3).
import { join } from 'node:path'
import { REPLY_PURPOSES } from '../task/contracts.ts'
import { AdapterError, notImplemented } from './errors.ts'
import { appendJsonLine, fakeRoot, readJson } from './fake/files.ts'

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** The file that holds the messages of one discussion. Shared with scripts/fake-event.ts. */
export function threadFile(dataDir, channel, threadTs) {
  for (const [name, value] of [['channel', channel], ['threadTs', threadTs]]) {
    if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
      throw new AdapterError('bad_origin', `origin.${name} is missing or has characters that are not allowed`)
    }
  }
  return join(fakeRoot(dataDir), 'slack', 'threads', `${channel}-${threadTs}.json`)
}

export const repliesFile = (dataDir) => join(fakeRoot(dataDir), 'slack', 'replies.jsonl')

/** Chooses the implementation by `config.adapters.slack`. */
export function createSlackAdapter(config, options = {}) {
  if (config.adapters?.slack === 'real') return createRealSlack(config, options)
  return createFakeSlack(config, options)
}

/** Plug-in point of the real implementation (work package R1): same two functions as the fake. */
export function createRealSlack() {
  throw notImplemented('slack')
}

export function createFakeSlack(config) {
  const dataDir = config.dataDir
  let sequence = 0

  return {
    async readThread(origin) {
      const messages = await readJson(threadFile(dataDir, origin?.channel, origin?.threadTs), undefined)
      if (messages === undefined) {
        throw new AdapterError('thread_not_found', `no fake discussion for channel ${origin.channel}, thread ${origin.threadTs}`)
      }
      if (!Array.isArray(messages)) throw new AdapterError('thread_invalid', 'the fake discussion file must hold a list of messages')
      return messages.map((m) => ({
        user: { id: m?.user?.id ?? 'unknown', name: m?.user?.name ?? m?.user?.id ?? 'unknown' },
        at: m?.at ?? null,
        text: typeof m?.text === 'string' ? m.text : '',
        files: Array.isArray(m?.files) ? m.files : [],
      }))
    },

    async reply(origin, purpose, text) {
      threadFile(dataDir, origin?.channel, origin?.threadTs) // validates the origin
      // `system` is the purpose of the notices the system itself posts (spec 3, section 4.6); the bots' tool offers only the other three.
      if (purpose !== 'system' && !REPLY_PURPOSES.includes(purpose)) throw new AdapterError('bad_purpose', `purpose must be one of ${REPLY_PURPOSES.join(', ')}, system`)
      if (typeof text !== 'string' || text.trim() === '') throw new AdapterError('bad_text', 'the reply text is empty')
      // A Slack-like message id: seconds.microseconds, unique inside this process.
      const id = `${Math.floor(Date.now() / 1000)}.${String(++sequence).padStart(6, '0')}`
      await appendJsonLine(repliesFile(dataDir), {
        id, at: new Date().toISOString(), channel: origin.channel, threadTs: origin.threadTs, purpose, text,
      })
      return id
    },
  }
}
