// Starts a command in its own session and process group (setsid through Node's `detached`;
// macOS has no setsid binary), writes the group's pid to a file, and returns at once.
// The caller stops the whole group with `kill -TERM -<pid>`; nothing is ever killed by name.
//
//   node scripts/lib/launch-detached.mjs <pid-file> <log-file> <cwd> -- <command> [args...]
//
// stdout and stderr of the command go to <log-file> (appended); stdin is /dev/null. The
// environment is inherited unchanged (the start script prepares it).
import { spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'

const [pidFile, logFile, cwd, separator, command, ...args] = process.argv.slice(2)
if (!pidFile || !logFile || !cwd || separator !== '--' || !command) {
  console.error('usage: launch-detached.mjs <pid-file> <log-file> <cwd> -- <command> [args...]')
  process.exit(2)
}
const log = openSync(logFile, 'a', 0o600)
const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', log, log] })
child.once('error', (error) => {
  console.error(`launch-detached: ${command}: ${error.message}`)
  process.exit(1)
})
child.once('spawn', () => {
  writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 })
  child.unref()
  process.exit(0)
})
