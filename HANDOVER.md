# Chat-to-Fix Handover Document

Written on 2026-11-12. 中文版: [HANDOVER.zh.md](HANDOVER.zh.md)

This document is for the engineer taking over and for the Claude session taking over. Earlier development was done under a personal Claude account. From the point where the project connects to the company Slack, it counts as company work and continues under the company Claude account. A new session cannot see the earlier conversations or memory, so everything it needs to know is written here.

The document merges the content of two conversations: the main conversation (design, implementation, verification) and its forked conversation (the company's "Chat-to-Fix Project Overview" and "Permission Request List"; the task was to check both against what was actually built for discrepancies, and it was not finished). The results of that check are in sections 6 and 7.

## 1. Current state in one sentence

The prototype runs: one simulated Slack @ comes in, the system creates five bots and a group, and walks through the seven steps using fake Slack, Jira and GitLab plus a real local git; the Coding bot can use a real Claude Code to change code, run tests, have the reviewer review it and report the conclusion. What is not done yet: running the whole seven steps end to end with real models, and connecting real Slack, Jira and GitLab.

All the code is on this machine. It was committed locally on 2026-11-12; there is no remote repository.

## 2. Names

| Term | What it refers to |
|---|---|
| Chat-to-Fix | The whole system, and also the name used by the company documents and the company repository `whhe-coder/Chat-to-Fix-Agent`. Renamed by Zihui on 2026-11-12; formerly BA Fix Bot |
| `chat-to-fix` | The short identifier in code: the project folder, the plugin name, the MCP server name; environment variables start with `CHAT_TO_FIX_`. Formerly `fixbot`; fully renamed on 2026-11-12 |
| Coding bot | The bot that writes code. Do not call it fix bot; it gets confused with the system name |
| DSH | DeepSeek Harness, the runtime the five bots run in. The project ships its own copy and does not modify it |
| DS Bot | An open-source DSH plugin (0.3.1); the bot layer was adapted from it |

## 3. Where things are

| Content | Location |
|---|---|
| Code | `~/Documents/mywork/chat-to-fix/chat-to-fix/` |
| Design documents (one Chinese and one English copy of each) | `~/Documents/mywork/chat-to-fix/chat-to-fix-design-2026-11-11/`, start from `README.md` |
| Verification results for the real Claude Code and the Coding bot's launch parameters | Section 4.9 of `spec-5-bot-layer.md` in the design documents |
| DS Bot upstream original (read-only reference) | `~/Documents/mywork/ds-bot/upstream/DS-Bot-0.3.1/ds-bot` |
| The company's existing fix-flow notes (Jira automation + Rovo) | `~/Documents/ChatGPT/ba-fix-bot/research/phase-1/README.md` |

Structure of the code directory:

| Directory | Content |
|---|---|
| `src/task/` | Task layer: listener interface, queue, group creation and wrap-up, monitor, recorder, task store, step checks, bot layer facade |
| `src/registry/`, `src/flow/` | Bot registry (each of the five bots' name, model, permissions, tools) and the seven-step flow table |
| `src/tools/` | Tool registration and all the tools: task tools, Slack, Jira, code repository, `request_code` |
| `src/adapters/` | The three adapters for Slack, Jira and the code repository. Currently only fake implementations exist; the attachment points for the real implementations are in place |
| `src/engine/` | Claude Code driver: launch parameters, environment variables, send and receive |
| `src/prompts/` | Instructions for the five bots and the reviewer, group notice |
| `src/bot/`, `src/plugin.js`, `src/app.js` | Bot layer entry, DSH plugin entry, the wiring that connects the parts |
| `bot/` | Bot layer source adapted from DS Bot 0.3.1, with its own tests |
| `runtime/` | The project's own DSH 0.2.2-rc.1 (332 packages, about 930 MB, not in git) |
| `config/` | DSH configuration patch `cordis.patch.yml` and its notes |
| `scripts/` | Environment, start and stop, smoke run, demo, simulated @ event, test repository creation |
| `test/` | Tests for the task layer and the driver; `test/bot/` holds the tests against the real bot layer |

## 4. Architecture overview

The architecture and the flow are two separate layers.

- **Architecture**: there is only one kind of registrable thing, the bot. One service maps to one bot: the Main bot for task routing and state, the Slack bot for Slack, the Jira bot for Jira, the pipeline bot for GitLab, the Coding bot for Claude Code.
- **Flow**: a separate seven-step table: fetch discussion, create ticket, prepare code, write code, open MR, write back, finish. Each step has a responsible bot, the evidence to check before advancing, and the write tools that are allowed only in that step.

How it runs:

- All five bots run in the same DSH process, and each bot is one DSH session. The watchdog (listening, queueing, monitoring) is also in this process.
- The Coding bot is special: its "model call" is replaced by one turn of Claude Code, so it depends on both DSH and Claude Code. The model calls of the other four bots go through the Anthropic API.
- Review is a read-only reviewer sub-agent inside Claude Code, built into the Coding bot. It is not a separate bot.
- Each task has one group and a fresh set of bots, created and dissolved by the system; the bots do not create groups themselves. Tasks run serially, with an interface left for concurrency.
- The flow and state belong to the system; content and judgement belong to the bots. Hand-over happens through the task store, not through chat text. An MR cannot be opened unless "review passed" has been recorded.

For the full description see `software-spec.md` in the design documents; for decisions and reasons see `decision-record.md`.

## 5. Progress

### 5.1 Done and checked

| Content | Evidence |
|---|---|
| All task layer modules and the Claude Code driver | `npm test`, all 250 items pass |
| Task layer against the real bot layer (fake DSH environment) | `npm run test:layer`, all 18 items pass |
| Bot layer trimming: removed autonomous bot creation, group creation, asking the user, display cards and the "capability" tool; `stop_bot` can only be used by the group administrator; removed the drivers for the other two command lines; Chief is no longer created automatically | DS Bot's own tests: 1828 items, 1826 pass, 2 skipped |
| Role tools registered into each bot's DSH session, differentiated by role | `test/bot/role-tools.test.js` |
| Fake responses for the three external services and the 13 corresponding tools | Three scenarios in `test/e2e.test.js`: normal seven steps, review failed, missing information then rerun |
| Claude Code driver matches the behaviour of the real command line 2.1.321 | 18 real experiments, results in section 4.9 of spec 5 |
| Coding bot completes one step in the bot layer with the real Claude Code | Using only its own instructions: read the task, change one line, run tests, reviewer passes, `review_report` writes the conclusion into the task. 8 turns, 32 seconds, about 0.06 USD |

### 5.2 Handed back but not checked personally

The isolated launch of the project's own DSH. The following was reported by the agent in charge. After taking over, run `npm run smoke` yourself first to check it:

- The DSH packages are in `runtime/`, the start and stop scripts work, and all data the process writes is in `.data/` inside the project.
- The smoke run with a local fake model passes 23 items: the DSH process starts, the plugin loads, one simulated @ creates five bots and a group, the Main bot receives the task, its tool list contains only read-only tools and its own task tools, and everything is cleaned up after stopping.
- The process listens only on the local address and makes no outbound connections; other DSH and DS Bot data under the user directory is unchanged.
- The configuration patch was corrected against the real runtime: no approvals, telemetry off, web service off, read-only preset, plugin line.

Two leftover issues it reported:

- **The read-only preset does not cover everything.** Three places create sessions without passing a preset: the bot's session in the group, the group's own session, and the next session after a hand-over (`bot/src/host/groups.js:293`, `roster.js:510`, `parts.js:1056`). For now one line in the patch changes the default preset to read-only to cover this. The proper fix is to pass the bot's own preset in these three places and then delete that line.
- **One write outside the project.** Each start leaves one npm log in `~/.npm/_logs` (caused by the lookup of the npm global directory in `bot/src/host/local-agents/discover.js`). This step can be skipped when the absolute path of the command line is given.

### 5.3 Not done

- Running the whole seven steps with real models. The four bots that use the API need `ANTHROPIC_API_KEY`.
- Real Slack, Jira and GitLab integration.
- Reading the MR's pipeline result and fixing it (see row 7 of section 6).
- Test commands configured separately per repository bound to a channel. For now they can only be written in the plugin configuration; if not configured, Claude Code's test runs are rejected.
- Remaining DS Bot cleanup: unused modules have not been deleted, the prompts still mention tools that were already deleted, `parts.js` has not been trimmed.
- An evaluation on historical issues; packaging as a container image.

### 5.4 Points not verified

- Whether, after Claude Code's background tasks are turned off, late events can still leak into the next turn.
- Restarting the Coding bot's process after an idle shutdown and resuming the conversation.
- A real run using the API key method (`engineAuth: apiKey`).
- Whether Claude Code's `memory/` directory under the same working directory makes two tasks carry content over to each other.
- How to write test commands with arguments in the allow-list.

## 6. Discrepancies with the company's "Chat-to-Fix Project Overview"

The content of the overview comes from text pasted in the forked conversation (compiled after 2026-11-11 18:28). On 2026-11-12 the current versions of the canvases were read from Slack (overview `F0CHUDNP596`, permission list `F0CGZSQKQ7L`); they match this text section by section and have not been updated. Below is a row-by-row comparison with what was actually built. Which side should change is for Zihui and the team to decide; what Zihui has already decided is written in the Discrepancy column and after the table.

| # | What the overview says | Actual state | Discrepancy |
|---|---|---|---|
| 1 | The repository is `whhe-coder/Chat-to-Fix-Agent` | The code is in a local folder, with no remote repository, and has not been pushed anywhere | Yes |
| 2 | Uses TypeScript | Everything is JavaScript. The reason is that the bot layer was adapted from DS Bot, which is JavaScript | Yes. **Zihui decided on 2026-11-12: switch to TypeScript** |
| 3 | The base is a fork of the open-source DSH, with the server side and the default Bash tool trimmed, extended through plugins | DSH was not forked and not modified: it is installed from npm as a whole package, and one configuration patch turns off the web service and gives four bots a read-only preset without file-writing and command-line tools. What was modified is DS Bot (a plugin of DSH), which the overview does not mention | Yes. Zihui said on 2026-11-12 this does not matter; keep as is |
| 4 | The first version has no built-in coding agent, calls an existing command line, Claude first; the bot and coding layers are decoupled | Consistent. The Coding bot calls the Claude Code command line through the driver | No |
| 5 | Do not use an agent where it can be avoided; the connections to Slack, Jira and GitLab use self-written code tools, not agents; get it working with the fewest agents first | The connections themselves are indeed code (adapter plus tools). But what calls these tools are three separate bots: the Slack bot, the Jira bot and the pipeline bot. Together with the Main bot and the Coding bot that makes five bots, plus one reviewer sub-agent | Yes. This is Zihui's design choice (one service maps to one registrable bot) and differs from the team's "fewest first" statement |
| 6 | Group creation and dissolution, watchdog, monitor, recorder and task store are all deferred and listed as todo | All of these have been built and have tests | Yes |
| 7 | Read the MR's latest pipeline; if it fails, add a fix to the same MR, at most 3 rounds; part of the first version's scope | Not done. `mr_get` only returns the MR status and a pipeline field, which is fixed to "none" in the fake implementation; job logs are not read and there is no CI fix loop. The existing "at most 3 rounds" refers to the number of rounds of code changes and review inside the Coding bot, not CI | Yes. **Zihui decided on 2026-11-12: do it as the overview says, in the first version** |
| 8 | Seven-step single-task flow | Consistent | No |
| 9 | Jira project F2PGBA, type "Task" | The project and type are configuration items; the sample has placeholder values | Configuration only |
| 10 | Branch `ai/<Jira key>`, open Draft MR only, no merge and no deployment | Consistent. The instructions also say not to merge, approve or close the MR | No |
| 11 | The MR branch should be created through the ticket feature and bound to the ticket | The branch is created locally with git, with the ticket number in its name, and is not created through Jira's ticket feature | To be confirmed whether this is sufficient |
| 12 | Repository rule: commits are single-line Conventional Commits with no body | Commits are generated by the adapter, with the MR title as the subject and the MR description as the body. This rule was not followed | Yes |
| 13 | Repository rule: use pnpm; change only `src/locales/en.json`; the complexity check must not use `:update` | Not specifically implemented. Claude Code reads the target repository's own instruction files and the Coding bot's instructions also require following them, but this has not been verified | Not verified |
| 14 | The entry point is built as a platform-style entry like Neuronet | The entry point is an HTTP interface on this machine, `POST /events`, waiting for another program to forward Slack events to it | The overview also lists it as todo |
| 15 | The MR author uses a dedicated bot account | The committer is taken from `commitAuthor` in the configuration | Configuration only |

On 2026-11-12, after reading the draft reply to the team, Zihui decided: row 2 switches to TypeScript; row 3 does not matter; row 7, CI reading and at most 3 rounds of fixes, goes into the first version as the overview says; the other rows are reported to the team as they are, with no further action. The scope of the TypeScript switch (only `src/`, or also the parts of `bot/` adapted from DS Bot) is not decided yet.

## 7. Check of the "Permission Request List"

The list was written from the overview. Below, each item is checked against what the actual code needs:

| Item in the list | Actually used? | Notes |
|---|---|---|
| Slack `app_mentions:read` | Used | Task entry point |
| Slack `channels:history`, `groups:history` | Used | `slack_read_thread` reads the discussion where the @ is |
| Slack `chat:write` | Used | "Received", questions, results, and system notices |
| Slack `users:read` | Possibly used | The current event format carries the user name directly; it is needed if real events give only the user ID |
| Slack Socket Mode (`connections:write`) | Depends on the setup | The code has no Socket Mode client. The current design is that another program converts events into `POST /events`. Either write a forwarding program, or add Socket Mode in the adapter |
| Jira browse, create ticket, add comment | Used | `jira_create_issue`, `jira_get_issue`, `jira_add_comment` |
| Jira transition status (optional) | Used | `jira_transition`; the allowed statuses are limited by configuration |
| GitLab 5486 Developer, token `api` and `write_repository` | Used | Clone, push branch, open Draft MR, read MR |
| GitLab sonarqube component 4568 Reporter | Needed for the reason given in the list | Unrelated to our code; it is a precondition for starting the pipeline |
| Read pipeline and job logs | Will be used | The corresponding feature is not built yet; Zihui decided the first version will have it (row 7 of section 6). The permissions are as the list says; no change needed |
| Anthropic API key, for the "coding part" | Incomplete statement; the list should change | Confirmed by Zihui on 2026-11-12. In the current design the four bots that use the API also use this key, not only the coding part, so purpose and usage should be counted for all bots. The Coding bot also uses it in deployment (`engineAuth: apiKey`); in the local demo the command line's own login is used |

The four "to be confirmed" items in the list are still to be confirmed; nothing in the code depends on the answer to any one of them.

## 8. How to run

Run all commands from the project root, loading the environment first:

```bash
. scripts/dev-env.sh
```

The three paths in this script are specific to this Mac: the location of Node 24, the location of DSH, the location of the Claude Code command line. Change them when switching machines.

| What | Command | Notes |
|---|---|---|
| Tests for the task layer and the driver | `npm test` | Does not need DSH, does not call a real model |
| Tests against the real bot layer | `npm run test:layer` | Needs the DSH packages in `runtime/` |
| DS Bot's own tests | `npm run test:bot` | See the note below |
| Smoke run | `npm run smoke` | Starts the project's own DSH with a local fake model, costs nothing |
| Start and stop | `npm start`, `npm stop` | First create `.data/chat-to-fix.json` from `config.example.json` |
| Claude Code demo | `node scripts/claude-demo.mjs --unattended --cwd <temporary repo> --prompt "…"` | Real call, costs money |
| Simulate a Slack @ | `node scripts/fake-event.mjs --channel C1 --text "…"` | Writes the discussion file and submits it to the listener interface |
| Create a test repository with a bug | `node scripts/make-test-repo.mjs <directory>` | Prints the two lines to fill in the configuration |

`npm run test:bot` contains one time-dependent test (`local-agents-discover.test.js`, which checks that "finding the command line does not wait for npm"). It often fails when the whole suite runs in parallel and passes when run alone. With the number of test files running at the same time limited to 6, two consecutive runs had no failures, taking about 21 seconds: add `--test-concurrency=6` to the command. This option has not yet been written into `package.json`.

Notes for real calls: run them only in a small repository in a temporary directory, and do not point Claude Code at the project directory or a real repository; think before each run about what you want to verify. So far real calls have cost about 1.8 USD in total (as reported by the command line itself), charged to the personal Console account.

## 9. What to do when changing account or machine

**Claude account**

- The Claude Code command line is currently logged in to the personal Console account. After switching to the company account, run the command line in your own terminal and `/login` again; when choosing the login method, only the authorization code given by the web page can be pasted at "Paste code here", an API key cannot.
- Deployment and the four bots that use the API use `ANTHROPIC_API_KEY`. A person should set it in their own terminal or in secret management, and should not paste it into the conversation.
- In an earlier conversation a string starting with `sk-ant-` was pasted. If it is a long-lived key, it should be revoked and regenerated.
- There are no credentials in the code or configuration.

**Memory and conventions**

- Memory under the personal account is in `~/.claude/projects/-Users-zihuifan-Documents-mywork-ba/memory/`, which a new session may not be able to read. The content of it that is useful for later work has all been written into sections 12 and 13 of this document.

**Where the code goes**

- All work after the baseline commit `2185ed7` was committed locally on 2026-11-12 (together with the rename). Whether to push to a remote is not decided.
- Whether to push to the company repository `whhe-coder/Chat-to-Fix-Agent` and whether to change to TypeScript is for Zihui and the team to decide.

**Dependencies**

`runtime/node_modules` and `bot/node_modules` are not in git and must be reinstalled when changing machine, which needs network access:

```bash
cd runtime && npm install --legacy-peer-deps=false --no-package-lock --no-fund --no-audit
```

```bash
cd bot && npm ci --ignore-scripts --no-audit --no-fund
```

`bot/dev/harness/package.json` is an empty shell left after DSH was moved out, and can be deleted.

## 10. Third-party code and licences

| Source | Licence | Status in the project |
|---|---|---|
| DS Bot 0.3.1 | Apache-2.0 | In `bot/`, already modified (tools and drivers trimmed, hooks added, one defect fixed). `LICENSE.upstream` and `NOTICE.upstream` are kept. Apache-2.0 requires changes to be stated in the modified files; this has not yet been done systematically |
| DSH 0.2.2-rc.1 | The main package is marked MIT | In `runtime/`, installed from npm, not modified. The licences of the 332 packages have not been checked one by one |
| Claude Code command line | Anthropic's product | Not in the project; the one already installed on this machine is used |

Before company use, someone should confirm that these licences meet the company's requirements.

## 11. Next steps, in order

1. Decide whether to push to the company repository (already committed locally).
2. Run `npm run smoke` yourself, check the content of section 5.2, and close the two leftover issues.
3. Align with the team on the discrepancies in section 6, at least these four: language, repository, number of bots, whether CI fixing is in the first version. This decides whether to continue with the current structure or to shrink it.
4. After setting `ANTHROPIC_API_KEY`, run the whole seven steps with the fake external services and real models. This is the first time the five bots will actually collaborate on their own, and it is expected to expose problems with the prompts and time limits.
5. After getting the colleagues' integration plan, write the real implementations of the three adapters. The attachment points are `createRealSlack`, `createRealJira` and `createRealGitlab` in `src/adapters/`. The questions to ask the colleagues are already written, in `questions-for-colleagues.md` in the design documents.
6. Change the commit message format according to the target repository's rules, and make the test command configurable per repository.
7. If the first version needs CI fixing: add adapter functions and tools that read the pipeline and job logs, and add a step after "open MR".
8. Clean up the rest of DS Bot and calibrate the time limits (the current values are initial estimates and have not been calibrated). The rename is done.

## 12. Working conventions

These were stated explicitly by Zihui in earlier conversations:

- Answer in Chinese, directly and briefly.
- Documents come in one Chinese and one English copy, as separate files: `name.zh.md` is Chinese, `name.md` is English, with the same content.
- Deliverables must be completed fully; verify facts before stating them, and state them accurately without hedging.
- Do not show him lists of implementation-level details to review and confirm; the implementer decides those and writes them in the implementation documents.
- Do not ask one question per step. Do what you can judge yourself, then say what was done.
- Use Sonnet sub-agents to write code, and Opus sub-agents to verify and tune parameters; the main session integrates and reruns the tests itself. Use sub-agents in parallel often, and give each sub-agent ownership of only the files explicitly listed for it.
- If there is a reference, modify on top of the reference; do not write from scratch.
- Commit or push only when he asks.
- He enters credentials himself, not through the conversation.

## 13. Settled design, do not raise again

- One service maps to one registrable bot, five in total. Do not propose merging Slack and Jira into a single "integration bot".
- One Main bot per group, created and destroyed with the task. Do not propose a permanent Main bot.
- Groups are created by the system, not by a bot. The Main bot has no tool for creating groups.
- Review is a sub-agent built into the Coding bot, not a separate bot.
- DSH is used as a whole package and not modified.
- There is no tool like `step_done`: when a turn ends it is a hand-over, and the system decides from evidence whether it can advance.
- Do not use Claude's SDK unless necessary; the Coding bot goes through the command line.
- MCP packaging is not done for now.

If the team's requirements conflict with these (see row 5 of section 6), put the conflict to Zihui and let him decide; do not change the design on your own.

## 14. Known pitfalls

- In DS Bot, only a member that has used a "tool outside the team tool list" counts as having "done something", and only a member that has done something is handed back to the bot that called it. So the names of role tools must not appear in the team tool list (`bot/src/host/constants.js`).
- If nobody answers a Claude Code permission request, that turn hangs forever; it does not time out by itself. A timeout was added in the driver.
- A denial of a permission request must carry reason text, otherwise the command line treats it as invalid.
- The allow-list must not contain unscoped `Read`, `Edit`, `Write` or `Bash`, because writes outside the directory or arbitrary commands would be allowed. The argument-generating function raises an error directly.
- The reviewer runs in the background by default; if this is not handled, the turn ends before it answers. The Coding bot's process is set with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- Our tools must be loaded in Claude Code with tool search first; the model will not think of this on its own. The Coding bot's instructions say so explicitly.
- When no model is specified, Claude Code uses `claude-opus-5-5`; it is decided by `codingModel` in the configuration.
- The bot's own private chat session is created before it is bound to a task, so the role tools have to be attached at binding time; sessions in the group are created later and go through the normal hook.
- Other DSH and DS Bot instances are also running on this machine (`~/Documents/mywork/dsh-worl`, `~/Documents/mywork/ds-bot`); do not touch their processes or data. Port 3080 belongs to another service.
