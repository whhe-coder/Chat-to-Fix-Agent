// The CI job "changeset" of the e2e case ci-changeset. It is NOT part of the case repository: like a shared CI
// template it lives outside it, and prepare.ts copies it to <run folder>/ci/ci-changeset/. The simulated GitLab
// CI (src/adapters/fake/ci.ts) runs it in a checkout of the pushed commit.
// Passes when .changeset/ holds at least one valid changeset (README.md is not one), fails otherwise.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const DIR = '.changeset'
const pkg = JSON.parse(readFileSync('package.json', 'utf8')).name
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort() : []
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const example = `---\n"${pkg}": patch\n---\n\nOne line that says what changed.`

if (files.length === 0) {
  console.log('changeset: error: no changeset found in this merge request.')
  console.log(`Every merge request must add a changeset: a Markdown file in ${DIR}/ (for example ${DIR}/fix-buy-button.md):`)
  console.log(example)
  process.exit(1)
}

const problems = []
for (const file of files) {
  const text = readFileSync(`${DIR}/${file}`, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (m === null) { problems.push(`${DIR}/${file}: no front matter (a "---" line, the package line, a "---" line)`); continue }
  if (!new RegExp(`^\\s*["']?${escape(pkg)}["']?\\s*:\\s*(patch|minor|major)\\s*$`, 'm').test(m[1])) problems.push(`${DIR}/${file}: the front matter must name the package and the bump, e.g. "${pkg}": patch`)
  if (m[2].trim() === '') problems.push(`${DIR}/${file}: the summary below the front matter is empty`)
}
if (problems.length > 0) {
  console.log('changeset: error: invalid changeset')
  for (const p of problems) console.log(`  ${p}`)
  console.log(`Expected:\n${example}`)
  process.exit(1)
}
console.log(`changeset: ${files.length} changeset(s) found: ${files.join(', ')}`)
