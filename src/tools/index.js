// Defines every tool of chat-to-fix in a tool registry: the task tools and the service tools.
import { registerTaskTools } from './task.js'
import { slackTools } from './slack.js'
import { jiraTools } from './jira.js'
import { repoTools } from './repo.js'
import { requestCodeTools } from './request-code.js'

/** Defines all tools in the registry. After it, registry.validate() should report no problem. */
export function registerAllTools(registry) {
  registerTaskTools(registry)
  for (const def of [...slackTools(), ...jiraTools(), ...repoTools(), ...requestCodeTools()]) registry.defineRoleTool(def)
}
