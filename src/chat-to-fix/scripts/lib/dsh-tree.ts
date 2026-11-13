// The composed DSH plugin tree of the chat-to-fix profile, without starting DSH
// (docs/chat-to-fix/design/plan-dsh-trim.md section 6). `dumpTree` runs `dsh --dump-config` in a temporary
// DSH_HOME (nothing is loaded, no `!!js` is evaluated, no network); `parseRows` reads the top-level rows;
// `isEnabled` decides whether a row is on in a `--profile chat-to-fix` run.
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
/** The chat-to-fix project folder (src/chat-to-fix). */
export const PROJECT_DIR = path.resolve(here, '..', '..')
/** The repository root, where DSH is installed. */
export const REPO_ROOT = path.resolve(PROJECT_DIR, '..', '..')
export const PATCH_FILE = path.join(PROJECT_DIR, 'config', 'cordis.patch.yml')
const DSH_BIN = path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

export interface Row {
  id: string
  /** The package (or entry file) the row loads. */
  name: string
  /** The raw `disabled:` value, undefined when the row has none. */
  disabled: string | undefined
  /** The row's original text, for assertions that look into its config. */
  text: string
}

/** Dump the composed tree: the chat-to-fix patch, then `extraPatches` (absolute paths), over a clean personal-profile patch. */
export async function dumpTree(opts: { patches?: string[] } = {}): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'c2f-dsh-tree-'))
  try {
    const profile = path.join(tmp, 'dsh', 'profiles', 'chat-to-fix')
    await mkdir(profile, { recursive: true })
    await mkdir(path.join(tmp, 'home'))
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-chat-to-fix',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }) + '\n')
    await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n')
    const args = [DSH_BIN, '--profile', 'chat-to-fix', '--patch', PATCH_FILE]
    for (const p of opts.patches ?? []) args.push('--patch', path.resolve(p))
    args.push('--dump-config')
    const { stdout, stderr } = await run(process.execPath, args, {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '', HOME: path.join(tmp, 'home'), DSH_HOME: path.join(tmp, 'dsh'), DSH_TELEMETRY_DISABLED: '1' },
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (stderr.trim()) throw new Error(`dsh --dump-config wrote to stderr: ${stderr.trim()}`)
    return stdout
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** The top-level rows: from a `- id:` at column 0 to the next column-0 `- ` or `# == ` line. */
export function parseRows(text: string): Row[] {
  const rows: Row[] = []
  let cur: string[] | undefined
  const flush = () => {
    if (!cur) return
    const body = cur.join('\n')
    const id = /^- id: (.+)$/m.exec(body)?.[1]?.trim() ?? ''
    const name = (/^  name: (.+)$/m.exec(body)?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    const disabled = /^  disabled: (.+)$/m.exec(body)?.[1]?.trim()
    rows.push({ id, name, disabled, text: body })
    cur = undefined
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('- ') || line.startsWith('# == ')) {
      flush()
      if (line.startsWith('- id:')) cur = [line]
    } else if (cur) cur.push(line)
  }
  flush()
  return rows
}

/** Is the row on in a `--profile chat-to-fix` run on this platform? Throws for a `disabled` expression nobody has reviewed. */
export function isEnabled(row: Row): boolean {
  const d = row.disabled
  if (d === undefined || d === 'false') return true
  if (d === 'true') return false
  const js = /^!!js\s+(.*)$/.exec(d)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (js !== undefined) {
    const known: Record<string, boolean> = {
      "!ctx.get('profileContext')": true, // with --profile there is a profileContext
      "!ctx.get(''profileContext'')": true,
      "process.platform === 'win32'": process.platform !== 'win32',
      "process.platform !== 'win32'": process.platform === 'win32',
      "ctx.get('profileContext')?.name !== 'desktop'": false, // our profile is called chat-to-fix
      "ctx.get(''profileContext'')?.name !== ''desktop''": false,
    }
    if (js in known) return known[js]
  }
  throw new Error(`row ${row.id}: disabled is a new expression (${d}); review it before adding it to isEnabled in scripts/lib/dsh-tree.ts`)
}
