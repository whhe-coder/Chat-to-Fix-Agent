// File helpers for the fake adapters (spec 4, section 2.3): everything lives under <dataDir>/fake/.
// Two tools called close together must not lose an entry, so every read-modify-write of one file
// goes through a per-path queue in this process, and every write is a temp file + rename, so a
// reader never sees half a file. (Two separate processes are not covered; the bot is one process.)
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AdapterError } from '../errors.js'

const queues = new Map()
let counter = 0

/** Runs `fn` after every earlier job on the same key has finished (errors do not block the queue). */
export function serialized(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  const tail = next.then(() => undefined, () => undefined)
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return next
}

/** The folder of the fake files. */
export const fakeRoot = (dataDir) => join(resolve(dataDir), 'fake')

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new AdapterError('fake_file_unreadable', `the fake file ${path} cannot be read: ${error.message}`)
  }
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${++counter}.tmp`
  try {
    await writeFile(temp, text)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Reads a JSON file; `fallback` when it does not exist. Waits for writes that are in flight. */
export function readJson(path, fallback) {
  return serialized(path, () => readJsonFile(path, fallback))
}

/** Writes a whole JSON file (atomically, queued). */
export function writeJson(path, value) {
  return serialized(path, () => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`))
}

/**
 * Read-modify-write of one JSON file. `fn(current)` returns `{ value, result }`: `value` is written
 * (skipped when undefined), `result` is returned to the caller.
 */
export function updateJson(path, fallback, fn) {
  return serialized(path, async () => {
    const current = await readJsonFile(path, fallback)
    const { value, result } = await fn(current)
    if (value !== undefined) await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
    return result
  })
}

/** Appends one JSON line to a .jsonl file (queued). */
export function appendJsonLine(path, value) {
  return serialized(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(value)}\n`)
  })
}

/** Next number of a sequence kept by the caller; helper for stable ids. */
export const nextSuffix = (keys, prefix) => {
  let max = 0
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const n = Number(key.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}
