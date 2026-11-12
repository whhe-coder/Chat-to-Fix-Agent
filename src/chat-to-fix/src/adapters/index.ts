// The adapters (spec 4, section 2.2, I5): { slack, jira, repo }.
// Each one is the fake or the real implementation, chosen by `config.adapters.<name>`
// (`gitlab` selects the merge-request half of `repo`). A `real` choice throws "not implemented yet"
// here, at creation, so a wrong configuration fails at startup and not in the middle of a task.
import { createJiraAdapter } from './jira.ts'
import { createRepoAdapter } from './repo.ts'
import { createSlackAdapter } from './slack.ts'

export { AdapterError } from './errors.ts'

/**
 * @param {object} config  The loaded configuration (src/config.ts).
 * @param {{ env?: object, warn?: Function, outbox?: object }} [options]  `env` and `warn` are passed on to the real implementations; `outbox` is the shared outbox of adapters.slack "outbox".
 * @returns {{ slack: object, jira: object, repo: object }}
 */
export function createAdapters(config, { env = process.env, warn = (...args) => console.warn(...args), outbox = undefined }: any = {}) {
  const options = { env, warn, outbox }
  return {
    slack: createSlackAdapter(config, options),
    jira: createJiraAdapter(config, options),
    repo: createRepoAdapter(config, options),
  }
}
