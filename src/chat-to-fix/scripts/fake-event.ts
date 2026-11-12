// The fake-event command (spec 4, section 4.7): stands in for a Slack @ while Slack is not hooked up.
//
//   node scripts/fake-event.ts --channel C0456 --text "The login button does nothing" \
//        [--thread 1731377400.000100] [--data-dir <dataDir>] [--url http://127.0.0.1:3090] [--token <t>]
//   node scripts/fake-event.ts --slash --channel C0456 --text "The login button does nothing" [--url ..] [--token ..]
//
// With --slash it stands in for the slash command /fix instead: it builds the slash payload, converts it
// the way the forwarder does, posts the body to /events (the server opens the discussion with its own
// opening message), and prints the result with the ephemeral text the requester would see.
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
import { slashCommandToEvent, slashFeedback } from './slack-forwarder.ts'

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

/**
 * Posts a slash command to /events the way the forwarder would (no discussion file is written: the
 * server's Slack adapter posts the opening message).
 * @returns {Promise<{ ok: boolean, status?: number, body?: object, eventId?: string, ephemeral: string, reason?: string }>}
 */
export async function sendFakeSlash({
  channel, text, url, token, command = '/fix', user = { id: 'U-FAKE', name: 'tester' }, fetchImpl = globalThis.fetch,
}: any) {
  const need = { channel, url, token }
  const missing = Object.entries(need).filter(([, v]) => typeof v !== 'string' || (v as string).trim() === '').map(([k]) => k)
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  const payload = {
    command, text: text ?? '', channel_id: channel, channel_name: 'fake', user_id: user.id, user_name: user.name,
    trigger_id: `fake.${randomBytes(6).toString('hex')}`,
  }
  const converted: any = slashCommandToEvent(payload, { command })
  // Empty text and a DM never reach /events: the requester gets the usage text in the acknowledgement.
  if (!converted.ok) return { ok: false, reason: converted.reason, ephemeral: converted.message ?? '' }
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-to-fix-token': token },
    body: JSON.stringify(converted.body),
  })
  let body
  const raw = await response.text()
  try { body = JSON.parse(raw) } catch { body = { raw } }
  return { ok: true, status: response.status, body, eventId: converted.body.eventId, ephemeral: slashFeedback({ status: response.status, body }, { command }) }
}

function parseArgs(argv) {
  const options: any = {}
  const names = { '--channel': 'channel', '--text': 'text', '--thread': 'threadTs', '--data-dir': 'dataDir', '--url': 'url', '--token': 'token', '--user': 'userId', '--name': 'userName' }
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--slash') { options.slash = true; i -= 1; continue }
    const key = names[argv[i]]
    if (key === undefined || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`)
    options[key] = argv[i + 1]
  }
  return options
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.slash === true) {
    const slash = await sendFakeSlash({
      channel: o.channel,
      text: o.text,
      url: o.url ?? process.env.CHAT_TO_FIX_URL,
      token: o.token ?? process.env.CHAT_TO_FIX_HTTP_TOKEN,
      user: o.userId === undefined ? undefined : { id: o.userId, name: o.userName ?? o.userId },
    })
    console.log(JSON.stringify({ status: slash.status ?? null, eventId: slash.eventId ?? null, response: slash.body ?? null, ephemeral: slash.ephemeral, ...(slash.ok ? {} : { rejected: slash.reason }) }, null, 2))
    if (!slash.ok || (slash.status as number) >= 400) process.exitCode = 1
    return
  }
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
