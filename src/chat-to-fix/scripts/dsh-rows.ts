// Prints the composed DSH plugin tree of the chat-to-fix profile, one row per line: `on|off <id> <package>`,
// in tree order. `--patch <file>` overlays more patches (to try a trim step before committing it).
// Does not start DSH. See docs/chat-to-fix/design/plan-dsh-trim.md.
import { dumpTree, isEnabled, parseRows } from './lib/dsh-tree.ts'

const patches: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--patch' && argv[i + 1]) patches.push(argv[++i])
  else { console.error('usage: node scripts/dsh-rows.ts [--patch <file>]...'); process.exit(2) }
}
for (const row of parseRows(await dumpTree({ patches }))) {
  console.log(`${isEnabled(row) ? 'on ' : 'off'} ${row.id} ${row.name}`)
}
