import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../.changeset/', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

test('the merge request carries a valid changeset (what the CI job "changeset" asks for)', () => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md') : []
  assert.ok(files.length >= 1, 'no changeset in .changeset/')
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
    assert.ok(m, `${file}: no front matter`)
    assert.match(m[1], new RegExp(`^\\s*["']?${pkg}["']?\\s*:\\s*(patch|minor|major)\\s*$`, 'm'), `${file}: package and bump`)
    assert.notEqual(m[2].trim(), '', `${file}: empty summary`)
  }
})
