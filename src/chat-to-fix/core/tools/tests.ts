// run_tests: the only way the Coding bot runs a command. Its DSH preset (`coding`, config/cordis.patch.yml)
// has no shell tool; this tool runs one of the test commands of the task's channel binding
// (`testCommands`, core/config.ts), exactly as configured, in the task's code directory.
//
// How a command runs: `sh -c <command>` (the command is configuration, written by a person, so a configured
// `npm ci && npm test` works as written), in its own process group, with a time limit (limits.testMinutes)
// after which the whole group is killed, and with an environment built from an allow-list (childEnv): no
// token of this process (Slack, Jira, GitLab, Anthropic, the control interface) reaches the command.
// The model cannot name another command, add arguments or change the directory. The code it runs is the
// code the Coding bot just changed, so this is not a sandbox: the boundary of a deployment is its container.
import { spawn } from 'node:child_process'
import { material } from './material.ts'

// The output kept for the model: the tail of stdout and stderr together.
export const TEST_OUTPUT_MAX_CHARS = 8000
const KEEP_BYTES = 256 * 1024

// The variables a command gets from this process's environment; anything else must be given explicitly.
const ALLOW_EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR'])
const ALLOW_PREFIX = ['LC_']
export const isAllowed = (key) => ALLOW_EXACT.has(key) || ALLOW_PREFIX.some((prefix) => key.startsWith(prefix))

/** The environment of a child process: the allow-listed variables of `source`, then `extra`. */
export function childEnv({ extra = {}, source = process.env }: { extra?: any, source?: any } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowed(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined || value === null) continue
    env[key] = String(value)
  }
  return env
}

/**
 * Runs one command with `sh -c` in `cwd`. Resolves { code, signal, timedOut, output, ms }; never rejects for
 * a failing command (a non-zero exit is a result). The whole process group is killed at the time limit.
 */
export function runCommand(command, { cwd, timeoutMs, env = childEnv() }: { cwd: string, timeoutMs: number, env?: any }) {
  return new Promise<any>((resolve, reject) => {
    const started = Date.now()
    let child
    try {
      child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let kept = ''
    const keep = (chunk) => {
      kept += chunk.toString('utf8')
      if (kept.length > KEEP_BYTES) kept = kept.slice(-KEEP_BYTES)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, output: kept, ms: Date.now() - started })
    })
  })
}

const minutesOf = (config) => config?.limits?.testMinutes ?? 10

/** The RoleTool definition of run_tests. */
export function testTools() {
  return [
    {
      name: 'run_tests',
      roles: ['coding'],
      write: false,
      retries: 0,
      // The command's own limit plus a margin for killing it and reading the output.
      timeoutMs: (config) => minutesOf(config) * 60_000 + 30_000,
      description: 'Run one of this repository\'s test commands in your code directory and see its exit code and output. The command must be one of the test commands listed in the task (task_read shows them under testCommands), given exactly as listed; nothing else can be run. Only in step code or step ci.',
      parameters: {
        command: { type: 'string', required: true, description: 'The test command, exactly as listed in testCommands' },
      },
      async run(ctx, args) {
        const { task } = ctx
        if (task.step !== 'code' && task.step !== 'ci') throw new Error(`run_tests can be used only in step code or step ci, the task is in step ${task.step}`)
        const dir = task.repo?.dir
        if (!dir) throw new Error('the code directory is not prepared yet')
        const allowed = (task.binding?.testCommands ?? []).map((command) => String(command).trim()).filter((command) => command !== '')
        if (allowed.length === 0) throw new Error('no test command is configured for this repository in Chat-to-Fix (testCommands of the channel binding is empty), so no test can be run; say so in your answer in these terms, not that the repository has no tests')
        const wanted = String(args.command ?? '').trim()
        if (!allowed.includes(wanted)) throw new Error(`"${wanted}" is not one of the test commands; run one of: ${allowed.map((command) => JSON.stringify(command)).join(', ')}`)
        const timeoutMs = minutesOf(ctx.config) * 60_000
        const result = await runCommand(wanted, { cwd: dir, timeoutMs })
        const tail = result.output.slice(-TEST_OUTPUT_MAX_CHARS)
        const cut = result.output.length > TEST_OUTPUT_MAX_CHARS ? `[cut: the last ${TEST_OUTPUT_MAX_CHARS} of ${result.output.length} characters are shown]` : ''
        const head = result.timedOut
          ? `${wanted}: stopped after ${minutesOf(ctx.config)} minutes (time limit); it did not finish.`
          : `${wanted}: exit code ${result.code ?? `none (signal ${result.signal})`}, ${Math.round(result.ms / 1000)} s.`
        return [head, '', 'Output (the end):', material('the test run', tail), cut]
          .filter((line) => line !== '').join('\n')
      },
    },
  ]
}
