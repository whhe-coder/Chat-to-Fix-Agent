# config/

`cordis.patch.yml` is chat-to-fix's DSH profile patch. `scripts/start-chat-to-fix.sh` loads it as a `--patch` overlay over the profile `chat-to-fix` (bundles `@deepseek-ai/dsh-base`, then `@deepseek-ai/dsh-web-app`). It has been loaded by the real runtime (DSH 0.2.2-rc.1 installed from the repository root), and `scripts/smoke.ts` checks what it does.

## Runtime installation

- Root `package.json` names the DSH packages. One `npm ci` at the repository root installs them. `scripts/dev-env.sh` sets `DSH_HARNESS` to the root package for tests.
- From the repository root, `npm start` launches the Agent and the local mock Slack page; `npm stop` stops both. Use `npm run start:agent` and `npm run stop:agent` to control only the Agent. Run the smoke check with `npm run smoke:agent` (`--sentinel-home` gives an exact list of writes under HOME).
- The configuration file is `$CHAT_TO_FIX_DATA/chat-to-fix.json` (default `src/chat-to-fix/.data/connected/chat-to-fix.json` for `npm start`), or the path in `CHAT_TO_FIX_CONFIG`. Keep `dataDir` and `worktreesDir` under `$CHAT_TO_FIX_DATA`; the start script warns when they are not.
- The token is read from `CHAT_TO_FIX_HTTP_TOKEN`. If that is not set, the start script creates `$CHAT_TO_FIX_DATA/http-token` (mode 600) once.
- Claude Code: the start script passes `CLAUDE_BIN` (set by `dev-env.sh`) through, and the plugin row turns it into `claudeCommand`. Without a CLI there is no `claude-code` route, and every task fails at start.

## What the start script sets, and why

The command is `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile chat-to-fix --patch src/chat-to-fix/config/cordis.patch.yml [--patch …]`. The working directory is `$CHAT_TO_FIX_DATA/work`. The process runs in its own session and process group (`scripts/lib/launch-detached.ts`), with its pid in `$CHAT_TO_FIX_DATA/run/chat-to-fix.pid` and its output in `run/chat-to-fix.log`. Stopping sends SIGTERM to the group, then SIGKILL after 15 s, and never kills by name.

The environment is cleared except for `PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM`, the proxy variables (`HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY` and their lower-case forms), `ANTHROPIC_API_KEY CHAT_TO_FIX_SLACK_TOKEN CHAT_TO_FIX_JIRA_TOKEN CHAT_TO_FIX_JIRA_EMAIL CHAT_TO_FIX_GITLAB_TOKEN CLAUDE_BIN CHAT_TO_FIX_HTTP_TOKEN` and the names in `CHAT_TO_FIX_PASS_ENV`. Removing everything else (`DSH_*`, `DS_BOT_*`, `DEEPSEEK_*`, `NODE_OPTIONS`, …) keeps settings from other installations out. The script then sets these:

| Variable | Value | Closes |
|---|---|---|
| `DSH_HOME` | `$CHAT_TO_FIX_DATA/dsh` | `~/.dsh`: profiles, sessions, storages, `.credentials.yaml`, `.env`, `cordis.patch.yml`, logs, and the bot layer's `bot/` (state.json, workspace) |
| `DSH_AGENTS_HOME` | `$CHAT_TO_FIX_DATA/agents` | `~/.agents` (global AGENTS.md, skills/) |
| `DSH_TELEMETRY_DISABLED` | `1` | the launcher adds `session-telemetry-otel: disabled` |
| `TMPDIR` | `$CHAT_TO_FIX_DATA/tmp` | `/var/folders/…/T`: node compile cache, native-addon cache, spill files, the bot layer's probe dirs |
| `XDG_*_HOME` | `$CHAT_TO_FIX_DATA/xdg/*` | `~/.config`, `~/.cache`, `~/.local` for anything that honours XDG |
| `npm_config_cache`, `npm_config_store_dir` | `$CHAT_TO_FIX_DATA/cache/*` | npm/pnpm caches if DSH's plugin manager ever runs pnpm |
| cwd | `$CHAT_TO_FIX_DATA/work` | DSH reads `<cwd>/.env`; this one is empty |

## Rows of cordis.patch.yml

| Row | Effect | Observed |
|---|---|---|
| 1 `llm-pi-ai` → `providers.anthropic` | model route; the key comes from the `ANTHROPIC_API_KEY` reference; model `claude-sonnet-5-5` (in pi-ai's catalog) | yes: with the smoke overlay (`baseURL` = mock) the Main bot's request reached the mock as `claude-sonnet-5-5` |
| 2 `agent-default-model` | default for new sessions | composed (dump-config); not observed separately, because the bot layer names the model per bot |
| 3 `approval: never`, `permission` with `defaultPreset: workspace-write` and three presets set to never | nothing waits for a click | yes: the row first refused to start ("defaults match no preset"), so `defaultPreset` and the approval row were added; the session logs show `read-only` / `workspace-write` pinned. A situation that would have asked was not exercised |
| 4 telemetry rows disabled | no OTel export | yes: the composed tree shows `disabled: true`; the process had no outward socket or proxy attempt |
| 5 headless: web-startup, webserver, web-runtime, modules, client-hmr, session-log-download, ui-deliverables, directory-picker, open-in-app, office-to-pdf, harness-dev-context and workspace-changes disabled; `connection` restated without `inject: [webStartup]` | no web server, browser or desktop integration | yes: every row activated, and the only listener is the control interface on 127.0.0.1 |
| 6 `preset-readonly` (new) | read and search only | yes: the four API bots' own sessions record `agentPreset: readonly`; since the bot layer passes each bot's preset at every session it creates (own chat, group session, fresh part; the relay session prefers `readonly`), the shipped `standard` preset is unchanged and only the Coding bot uses it |
| 7 plugin row `chat-to-fix/src/chat-to-fix/core/plugin.ts`, config `claudeCommand` | loads chat-to-fix from the profile's `node_modules/chat-to-fix` link | yes: the plugin starts and the `claude-code` route exists |

Loader rules confirmed against the real runtime:

- A patch row can set `disabled: true`.
- A patch row can replace `inject`.
- `config` replaces the whole config of a row.
- YAML anchors work.
- A local plugin is named as `<linked package>/<subpath>`.

## Known leaks and what remains open

- **npm debug log.** The bot layer (`bot/src/host/local-agents/discover.ts`) runs `npm prefix --global`, which writes `~/.npm/_logs/<time>-debug-0.log`. With a sentinel HOME, this was the only file the process wrote under HOME. Fix: skip `refreshSearchDirs()` when `claudeCommand` is an absolute path, or give that call `npm_config_logs_max=0`.
- **Login shell.** The same file runs `$SHELL -l -c`, which reads `~/.zprofile` and `~/.zshenv`. These are reads only; that no file is written was shown with the sentinel HOME.
- **Claude Code.** In real runs, Claude Code writes under `~/.claude` (projects, settings). This is known and accepted.
- **Node binary.** Node comes from `~/Documents/mywork/ds-bot/.toolchain` (`dev-env.sh`). It is executed only, never written.
