// Creates a small local repository with one obvious bug and a test command (`sh test.sh`), plus
// the bare repository to push to (spec 4, section 4.7).
//
//   node scripts/make-test-repo.ts [directory]     (default: a new temporary directory)
//
// It prints the two paths in the form a binding of the configuration needs (`localRepo`, `remote`).
// The function is exported so that the tests and the script share one implementation.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGit } from '../core/adapters/git.ts'

const AUTHOR = { name: 'Test Author', email: 'test@example.com' }

/** The sample project. `src/price.js` holds the bug: the discount is added instead of subtracted. */
export const SAMPLE_FILES = {
  'README.md': '# Sample shop\n\nTiny project used to try Chat-to-Fix. Run the tests with `sh test.sh`.\n',
  'src/price.js': `// Price helpers of the sample shop.

/** The price after a percentage discount: 100 with 10% off is 90. */
export function applyDiscount(price, percent) {
  // BUG: the discount is added instead of subtracted.
  return price + (price * percent) / 100
}

export function formatPrice(value) {
  return \`$\${value.toFixed(2)}\`
}
`,
  'src/greeting.js': `export function greet(name) {
  return \`Hello, \${name}!\`
}
`,
  'test.js': `import { applyDiscount, formatPrice } from './src/price.js'
import { greet } from './src/greeting.js'

let failed = 0
function check(name, actual, expected) {
  if (actual === expected) console.log(\`ok   \${name}\`)
  else { failed += 1; console.log(\`FAIL \${name}: expected \${expected}, got \${actual}\`) }
}

check('greet', greet('Ann'), 'Hello, Ann!')
check('formatPrice', formatPrice(5), '$5.00')
check('applyDiscount(100, 10)', applyDiscount(100, 10), 90)
check('applyDiscount(80, 25)', applyDiscount(80, 25), 60)
process.exit(failed === 0 ? 0 : 1)
`,
  'test.sh': `#!/bin/sh
# The test command of this repository: exit code 0 when everything passes.
cd "$(dirname "$0")" || exit 2
exec node test.js
`,
  'package.json': '{\n  "name": "sample-shop",\n  "version": "1.0.0",\n  "type": "module"\n}\n',
}

/**
 * Creates <dir>/project (the local repository, branch `defaultBranch`, one commit, remote `origin`
 * pointing at the bare repository) and <dir>/project.git (the bare repository, already holding the
 * commit). Returns { localRepo, remote, defaultBranch, commit, files }.
 */
export async function createTestRepo({ dir, defaultBranch = 'master' }: any = {}) {
  const root = resolve(dir ?? await mkdtemp(join(tmpdir(), 'chat-to-fix-test-repo-')))
  const localRepo = join(root, 'project')
  const remote = join(root, 'project.git')
  await mkdir(localRepo, { recursive: true })
  const git = (args, cwd): Promise<any> => runGit(args, { cwd, author: AUTHOR } as any)

  await git(['init', '--quiet', '--bare', '-b', defaultBranch, remote], root)
  await git(['init', '--quiet', '-b', defaultBranch, localRepo], root)
  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    const full = join(localRepo, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
  await git(['add', '-A'], localRepo)
  await git(['commit', '--quiet', '-m', 'Initial sample shop'], localRepo)
  await git(['remote', 'add', 'origin', remote], localRepo)
  await git(['push', '--quiet', 'origin', `${defaultBranch}:${defaultBranch}`], localRepo)
  const commit = (await git(['rev-parse', 'HEAD'], localRepo)).stdout.trim()
  return { localRepo, remote, defaultBranch, commit, files: Object.keys(SAMPLE_FILES) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createTestRepo({ dir: process.argv[2] }).then((made) => {
    console.log(`Created the test repository (its \`sh test.sh\` fails on purpose: see src/price.js).`)
    console.log('Put these two lines into the binding of the channel in the configuration:')
    console.log(`  "localRepo": ${JSON.stringify(made.localRepo)},`)
    console.log(`  "remote": ${JSON.stringify(made.remote)},`)
    console.log(`  "defaultBranch": ${JSON.stringify(made.defaultBranch)}`)
  }, (error) => {
    console.error(`make-test-repo failed: ${error.message}`)
    process.exit(1)
  })
}
