// The engine a local agent runs on: Claude Code (stream-json, src/engine/claude.js). The entry
// names its route, its display name and how it starts. `args` run verbatim (no shell), ahead of
// the arguments launch.js builds.
export const KINDS = ['claude']

export const ENGINES = {
  'claude-code': { name: 'Claude Code', kind: 'claude', command: 'claude', args: [], version: ['--version'] },
}

export const engineOf = route => ENGINES[route]

export const isLocalAgentRoute = route => typeof route === 'string' && ENGINES[route] !== undefined
