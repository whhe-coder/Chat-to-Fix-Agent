// Prompt loader (D2). Reads each prompt file once and keeps the text. The file names are the
// ones the registry (core/registry/bots.ts) names in `instructions` and in the coding
// `reviewer.instructions`; the group notice is the shared text every member sees.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILES = Object.freeze({
  main: 'main.md',
  slack: 'slack.md',
  jira: 'jira.md',
  pipeline: 'pipeline.md',
  coding: 'coding.md',
  reviewer: 'reviewer.md',
  'group-notice': 'group-notice.md',
})

/** The seven prompt names: five bot roles, the reviewer subagent and the group notice. */
export const PROMPT_NAMES = Object.freeze(Object.keys(FILES))

const cache = new Map()

/**
 * The text of one prompt. `name` is a prompt name ("main", "reviewer", "group-notice", ...) or
 * the file name the registry gives ("main.md").
 */
export function loadPrompt(name) {
  const key = typeof name === 'string' && name.endsWith('.md') ? name.slice(0, -3) : name
  if (!Object.hasOwn(FILES, key)) {
    throw new Error(`unknown prompt "${name}"; known prompts: ${PROMPT_NAMES.join(', ')}`)
  }
  if (!cache.has(key)) {
    cache.set(key, readFileSync(fileURLToPath(new URL(FILES[key], import.meta.url)), 'utf8').trim())
  }
  return cache.get(key)
}

/** The group notice text. */
export function groupNotice() {
  return loadPrompt('group-notice')
}
