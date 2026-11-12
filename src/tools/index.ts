// Defines every tool of chat-to-fix in a tool registry: the task tools and the service tools.
import { registerTaskTools } from './task.ts'
import { slackTools } from './slack.ts'
import { jiraTools } from './jira.ts'
import { repoTools } from './repo.ts'
import { requestCodeTools } from './request-code.ts'

/** Defines all tools in the registry. After it, registry.validate() should report no problem. */
export function registerAllTools(registry) {
  registerTaskTools(registry)
  for (const def of [...slackTools(), ...jiraTools(), ...repoTools(), ...requestCodeTools()]) registry.defineRoleTool(def)
}
