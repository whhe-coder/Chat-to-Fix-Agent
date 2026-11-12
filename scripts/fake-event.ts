// The fake-event command (spec 4, section 4.7): stands in for a Slack @ while Slack is not hooked up.
//
//   node scripts/fake-event.ts --channel C0456 --text "The login button does nothing" \
//        [--thread 1731377400.000100] [--data-dir <dataDir>] [--url http://127.0.0.1:3090] [--token <t>]
//
// It writes the discussion file under <dataDir>/fake/slack/threads/ (a new discussion: its first
// message is the text; with --thread: the text is added to that discussion), then submits the event
// to POST /events of the listener and prints the response. Defaults: --url CHAT_TO_FIX_URL,
// --token CHAT_TO_FIX_HTTP_TOKEN, --data-dir CHAT_TO_FIX_DATA_DIR.
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateJson } from '../src/adapters/fake/files.ts'
import { threadFile } from '../src/adapters/slack.ts'

let counter = 0
const slackTs = () => `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, '0')}${String(++counter % 1000).padStart(3, '0')}`

/**
 * Writes the discussion file and posts the event.
 * @returns {Promise<{ status: number, body: object, eventId: string, threadTs: string, messageTs: string, file: string }>}
 */
export async function sendFakeEvent({
  channel, text, threadTs, dataDir, url, token,
  user = { id: 'U-FAKE', name: 'tester' }, fetchImpl = globalThis.fetch,
}) {
  const need = { channel, text, dataDir, url, token }
  const missing = Object.entries(need).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k)
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)

  const messageTs = slackTs()
  const thread = threadTs ?? messageTs
  const file = threadFile(dataDir, channel, thread)
  const message = { ts: messageTs, user, at: new Date().toISOString(), text, files: [] }
  // A new discussion starts with this message; an existing one gets the message added at the end.
  await updateJson(file, [], (messages) => ({ value: [...messages, message], result: undefined }))

  const eventId = `Ev-fake-${randomBytes(5).toString('hex')}`
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-to-fix-token': token },
    // A fake discussion has no real Slack link; this one names the discussion file's channel and thread.
    body: JSON.stringify({ eventId, channel, threadTs: thread, messageTs, user, text, permalink: `fake://slack/${channel}/${thread}` }),
  })
  let body
  const raw = await response.text()
  try { body = JSON.parse(raw) } catch { body = { raw } }
  return { status: response.status, body, eventId, threadTs: thread, messageTs, file }
}

function parseArgs(argv) {
  const options = {}
  const names = { '--channel': 'channel', '--text': 'text', '--thread': 'threadTs', '--data-dir': 'dataDir', '--url': 'url', '--token': 'token', '--user': 'userId', '--name': 'userName' }
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]]
    if (key === undefined || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`)
    options[key] = argv[i + 1]
  }
  return options
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const result = await sendFakeEvent({
    channel: o.channel,
    text: o.text,
    threadTs: o.threadTs,
    dataDir: o.dataDir ?? process.env.CHAT_TO_FIX_DATA_DIR,
    url: o.url ?? process.env.CHAT_TO_FIX_URL,
    token: o.token ?? process.env.CHAT_TO_FIX_HTTP_TOKEN,
    user: o.userId === undefined ? undefined : { id: o.userId, name: o.userName ?? o.userId },
  })
  console.log(JSON.stringify({ status: result.status, threadTs: result.threadTs, eventId: result.eventId, response: result.body }, null, 2))
  if (result.status >= 400) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`fake-event failed: ${error.message}`)
    process.exitCode = 1
  })
}
