// Interface contracts between the parts of fixbot.
//
// This file holds names and shapes only. The behaviour of each interface is defined in the
// detailed specifications under ../../../ba-fix-bot-design-2026-11-11/ (spec-1 … spec-6).
// One file belongs to one work package; to change a contract, change it here first.

/** The five roles. One bot per service. (spec 1, 2.1) */
export const ROLES = Object.freeze(['main', 'slack', 'jira', 'pipeline', 'coding'])

/** The seven steps, in order. (spec 1, 2.3) */
export const STEP_IDS = Object.freeze(['fetch', 'issue', 'prepare', 'code', 'mr', 'writeback', 'close'])

/** Task states. (spec 2, 2.3) */
export const TASK_STATES = Object.freeze(['queued', 'running', 'done', 'needs_info', 'failed', 'timed_out', 'stopped', 'expired'])

/** Outcomes accepted by gate.close / task_close. (spec 1, 4.4) */
export const CLOSE_OUTCOMES = Object.freeze(['done', 'needs_info', 'failed', 'needs_person'])

/** Purposes of slack_reply. (spec 4, 4.3) */
export const REPLY_PURPOSES = Object.freeze(['ack', 'question', 'result'])

/** Types of execution-record entries. (spec 2, 2.4) */
export const RECORD_TYPES = Object.freeze(['line', 'notice', 'tool_call', 'tool_result', 'round_end', 'advance', 'refused', 'limit', 'approval', 'system'])

/**
 * I1 bot-layer facade — src/task/botlayer.js (spec 5, section 3)
 * @typedef {object} BotLayer
 * @property {(def: {name: string, label: string, instructions: string, model: string, permission: string, preset?: string}) => Promise<string>} createBot
 * @property {(def: {name: string, memberIds: string[], adminId: string, notice: string}) => Promise<string>} createGroup
 * @property {(groupId: string, dir: string) => Promise<void>} setGroupWorkDir
 * @property {(groupId: string, text: string, requestId: string) => Promise<void>} postTask
 * @property {(req: {fromSessionId: string, toBotId: string, text: string}) => Promise<void>} askBot
 * @property {(botId: string) => Promise<void>} stopBot
 * @property {(groupId: string) => Promise<void>} stopGroup
 * @property {(groupId: string) => Promise<void>} deleteGroup
 * @property {(botId: string) => Promise<void>} deleteBot
 * @property {(groupId: string) => boolean} groupExists
 * @property {(groupId: string) => boolean} isQuiet
 * @property {() => object} status
 * @property {(fn: Function) => () => void} onGroupLine
 * @property {(fn: Function) => () => void} onSessionEvent
 * @property {(fn: Function) => () => void} onToolResult
 * @property {(fn: Function) => () => void} onRoundEnd
 * @property {(fn: Function) => () => void} onApproval
 * @property {(id: string, choice: 'allow' | 'reject') => void} answerApproval
 * @property {(botId: string, binding: {taskId: string, role: string}) => void} bindBot
 * @property {(botId: string) => void} unbindBot
 * @property {(sessionId: string) => ({botId: string, role: string, taskId: string} | undefined)} botOfSession
 */

/**
 * I2 task store — src/task/store.js (spec 2, 3.1)
 * @typedef {object} TaskStore
 * @property {(eventId: string) => (string | undefined)} knownEvent
 * @property {(origin: object, binding: object) => Promise<object>} createTask
 * @property {(id: string) => Promise<object | undefined>} getTask
 * @property {(channel: string, threadTs: string) => Promise<object | undefined>} findByThread
 * @property {(id: string, patch: object) => Promise<object>} patchTask
 * @property {(id: string, run: {groupId: string, bots: Record<string, string>}) => Promise<object>} startRun
 * @property {(id: string, state: string, endReason: string) => Promise<object>} endRun
 * @property {(id: string, entry: object) => Promise<void>} appendRecord
 * @property {(id: string, filter?: {step?: string}) => Promise<object[]>} readRecords
 * @property {(filter?: {state?: string}) => Promise<object[]>} listTasks
 */

/**
 * I3 step checks — src/task/gate.js (spec 1, sections 3 and 4)
 * @typedef {object} Gate
 * @property {(taskId: string, toStep: string) => Promise<{ok: true} | {ok: false, missing: string[]}>} advance
 * @property {(taskId: string, toolName: string, purpose?: string) => Promise<{ok: true} | {ok: false, reason: string}>} allow
 * @property {(taskId: string, role: string, text: string) => Promise<{other: boolean}>} confirmNeedsInfo
 * @property {(taskId: string, outcome: string, note?: string) => Promise<{ok: true} | {ok: false, reason: string}>} close
 */

/**
 * I4 tool definition — src/tools/register.js (spec 4, 2.1)
 * @typedef {object} RoleTool
 * @property {string} name
 * @property {string[] | 'all'} roles
 * @property {boolean} write
 * @property {(args: object) => (string | undefined)} [purpose]
 * @property {string} description
 * @property {object} parameters
 * @property {(ctx: ToolContext, args: object) => Promise<string>} run
 *
 * @typedef {object} ToolContext
 * @property {object} task
 * @property {string} role
 * @property {string} botId
 * @property {TaskStore} store
 * @property {Gate} gate
 * @property {Adapters} adapters
 * @property {object} config
 * @property {BotLayer} botlayer
 */

/**
 * I5 adapters — src/adapters/ (spec 4, 2.2). Every adapter has a fake and a real implementation.
 * @typedef {object} Adapters
 * @property {{readThread: Function, reply: Function}} slack
 * @property {{createIssue: Function, getIssue: Function, addComment: Function, transition: Function}} jira
 * @property {{prepare: Function, diff: Function, readFile: Function, log: Function, openDraftMR: Function, getMR: Function, cleanup: Function}} repo
 */

/**
 * I7 bot registry and flow definition — src/registry/bots.js, src/flow/steps.js (spec 1, 2.2 and 2.3)
 * @typedef {object} BotDef
 * @property {string} role
 * @property {string} name          Name prefix; the task number is appended when the bot is created.
 * @property {string} label         DS Bot's `role` field (at most 24 characters).
 * @property {string} instructions  Name of the prompt file.
 * @property {string} model         Model route, or the name of the config key that holds it.
 * @property {string} permission
 * @property {string[]} tools       Tools only this bot has.
 *
 * @typedef {object} StepDef
 * @property {number} no
 * @property {string} id
 * @property {string[]} roles
 * @property {string[]} evidence
 * @property {string[]} writeTools
 */
