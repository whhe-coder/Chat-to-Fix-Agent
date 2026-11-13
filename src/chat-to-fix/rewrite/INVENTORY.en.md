# Code inventory before the TS rewrite

Written 2026-11-12, against commit `d988a3e`. 中文版：[INVENTORY.md](INVENTORY.md)

This inventory answers two questions: which parts of `bot/` (taken from DS Bot) we actually use, and whether the tests still run once the rest is deleted. Its conclusions set the scope of the TS rewrite.

## 1. Conclusions

- `bot/` holds 407 files (excluding `node_modules`). The runtime loads only **36 JS files, 11,409 lines**, plus `bot/package.json` (`diagnostics.js` reads the version from it).
- After deleting the 338 unused files in a copy, our own tests and the smoke run gave exactly the same results as before: `npm test` 250/250, `test:layer` 18/18, smoke 23/23.
- `test:bot` went from 1828 tests to 136 (134 pass, 2 skipped — the same two as before, both Windows-only cases). The rest were deleted together with the modules they test; 42 of those files also test features we use and will be rewritten and kept, see section 6.
- The rewrite covers about 25,000 lines: 10,914 of our own, 11,409 of `bot/` runtime, and 2,561 of kept `bot/` tests.

## 2. Method

1. Starting from every file under `src/`, follow relative `import`, `export … from`, dynamic `import('…')` and `new URL('…', import.meta.url)`. What is reached is what the runtime loads. DSH loads a single plugin entry, `src/plugin.js` (`config/cordis.patch.yml` line 175), so every runtime entry is under `src/`.
2. Repeat from `test/`, `scripts/` and `bot/test/harness-resolve.mjs`; what this adds is test-only support.
3. `bot/src` has four dynamic imports with a computed path. All load external packages (MCP client, playwright, computer plugins), and all sit in files outside the runtime set.
4. Static analysis can miss things, so section 5 also deletes the files in a copy and runs all four suites and the smoke run.

The script is [inventory.mjs](inventory.mjs); per-file results are in [bot-files.tsv](bot-files.tsv).

## 3. Totals

| Part | Files | Lines | Action |
|---|---|---|---|
| Our `src/` | 35 | 4,474 | Rewrite |
| Our `test/` | 26 | 5,731 | Keep JS, rewrite last |
| Our `scripts/` | 6 | 709 | Rewrite |
| `bot/` runtime | 36 | 11,409 | Rewrite |
| `bot/` test support (`fake-ctx.js`, `loop-kit.js`, `harness-resolve.mjs`) | 3 | 203 | Keep |
| `bot/` tests touching only used modules | 14 | 2,358 | Keep |
| `bot/` test fixtures `test/fixtures/` | 11 | — | Keep |
| `bot/` licence files, `package.json`, `package-lock.json` | 5 | — | Keep |
| `bot/` unused source and other files | 195 | about 87,000 | Delete |
| `bot/` tests deleted with their modules | 143 | 39,768 | Delete |

Our own code by directory:

| Directory | Lines |
|---|---|
| `src/task/` | 1,758 |
| `src/tools/` | 828 |
| `src/adapters/` | 692 |
| `src/engine/` | 528 |
| `src/config.js` | 138 |
| `src/flow/` | 130 |
| `src/bot/` | 122 |
| `src/registry/` | 120 |
| `src/app.js` | 76 |
| `src/plugin.js` | 42 |
| `src/prompts/` | 40 |

## 4. The 36 `bot/` runtime files

"Imported by" lists direct importers only. `host/` means `bot/src/host/`.

| File | Lines | Imported by | External deps |
|---|---|---|---|
| `host/parts.js` | 1,633 | `src/bot/index.js` | `dsh-llm`, `deep-view/core` |
| `host/groups.js` | 1,509 | `src/bot/index.js`, `src/task/botlayer.js` | `dsh-llm`, `dsh-tools` |
| `host/turns.js` | 1,150 | `src/bot/index.js`, `groups.js`, `resume.js` | `dsh-scope` |
| `host/roster.js` | 788 | `src/bot/index.js` | |
| `host/tools.js` | 766 | `src/bot/index.js`, `groups.js`, `local-agents/index.js` | `dsh-tools` |
| `host/local-agents/adapter.js` | 563 | `local-agents/index.js` | `dsh-llm` |
| `host/store.js` | 560 | `src/bot/index.js` | |
| `host/resume.js` | 446 | `src/bot/index.js`, `parts.js` | |
| `host/btw.js` | 373 | `parts.js` | `dsh-llm` |
| `host/handoffs.js` | 331 | `src/bot/index.js` | |
| `host/models.js` | 315 | `src/bot/index.js` | |
| `host/chat-index.js` | 294 | `src/bot/index.js` | |
| `host/diagnostics.js` | 258 | `src/bot/index.js`, `turns.js` | |
| `host/schedules.js` | 249 | `turns.js` | |
| `host/folders.js` | 231 | `src/bot/index.js`, `tools.js` | |
| `host/local-agents/index.js` | 198 | `src/bot/index.js` | `dsh-tools` |
| `host/delivery.js` | 173 | `src/bot/index.js` | `dsh-llm` |
| `host/steward.js` | 166 | `parts.js` | |
| `host/requests.js` | 142 | `src/bot/index.js`, `tools.js` | |
| `host/local-agents/mcp.js` | 142 | `local-agents/adapter.js` | |
| `host/permissions.js` | 118 | `src/bot/index.js` | |
| `host/approvals.js` | 117 | `src/bot/index.js` | |
| `host/home-lock.js` | 99 | `store.js` | |
| `host/constants.js` | 95 | several modules | |
| `shared/im-platforms.js` | 87 | `groups.js`, `parts.js`, `turns.js` | |
| `host/local-agents/discover.js` | 83 | `local-agents/index.js` | |
| `host/prompt.js` | 74 | `src/bot/index.js` | |
| `shared/mentions.js` | 73 | `groups.js`, `roster.js`, `tools.js` | |
| `shared/group-replies.js` | 70 | `parts.js` | |
| `host/local-agents/launch.js` | 68 | `local-agents/index.js` | |
| `host/local-agents/claude-engine.js` | 60 | `local-agents/index.js` | |
| `host/text.js` | 50 | `src/task/botlayer.js` and several modules | |
| `host/time-context.js` | 47 | `src/bot/index.js` | `dsh-llm` |
| `host/links.js` | 40 | `tools.js`, `turns.js` | |
| `host/files.js` | 28 | `btw.js`, `store.js` | |
| `host/local-agents/engines.js` | 13 | `local-agents/adapter.js`, `local-agents/index.js` | |

External deps: the four `@deepseek-ai/*` packages come from DSH in `runtime/`. Of the dependencies in `bot/package.json`, only `deep-view` is still used (`parts.js` line 26). `@modelcontextprotocol/client`, `imapflow`, `mailparser`, `nodemailer` and the three dev dependencies are used only by deleted modules.

**Candidates for a second trim**: `btw.js` (side chat), `schedules.js`, `steward.js`, `shared/im-platforms.js`, `shared/group-replies.js`, and the `deep-view` card code in `parts.js`. By their names these are features we do not use, but kept modules import them directly, so the first pass kept them. Each is to be confirmed when its module is rewritten; none is counted in the conclusions above.

## 5. Trial deletion

In a full copy of `d988a3e` (the real directory untouched), the 338 files from section 3 were deleted and the same four suites run as before.

| Suite | Before (real directory) | After (copy) |
|---|---|---|
| `npm test` | 250, all pass | 250, all pass |
| `npm run test:layer` | 18, all pass | 18, all pass |
| `npm run smoke` | 23, all pass | 23, all pass |
| `test:bot` (`--test-concurrency=6`) | 1828: 1826 pass, 2 skipped | 136: 134 pass, 2 skipped |

Deleted files by directory:

| Directory | Files | Lines |
|---|---|---|
| `bot/test/` | 145 | 39,860 |
| `bot/` root (`client.js`, `index.js`, `office.js`, `web-search.js`, …) | 9 | 37,825 |
| `bot/src/client/` (web UI) | 94 | 22,635 |
| unused modules in `bot/src/host/` | 25 | 9,543 |
| `bot/dev/` | 19 | 3,360 |
| `bot/src/host/im/` | 11 | 3,097 |
| `bot/src/office/` | 11 | 2,397 |
| `bot/src/host/connectors/` | 7 | 2,363 |
| `bot/src/host/browser/` | 10 | 1,712 |
| `bot/src/host/computer/` | 3 | 1,378 |
| `bot/scripts/` | 3 | 261 |
| other empty files | 1 | 0 |

## 6. `bot/` tests

Classified by the `bot/src` modules each test file actually loads:

| Class | Files | Lines | Action |
|---|---|---|---|
| Only used modules | 14 | 2,358 | Keep; all run after the trial deletion |
| Both used and unused modules | 75 | 28,363 | Delete; part of them rewritten and kept, see below |
| Only unused modules | 48 | 7,060 | Delete |
| No `bot/src` (web build, styles, `dev/` scripts, …) | 20 | 4,345 | Delete |

Most of the 75 "both" files drive the runtime through `createRuntime` from DS Bot's full entry `bot/index.js`. Our entry `src/bot/index.js` also has `createRuntime`, but returns the public facade; with a three-line shim (using `runtimeOf` to get the internal object), 42 of those files were pointed at our entry and run.

| Result | Files | Tests |
|---|---|---|
| All pass | 5 (`request-id`, `switch-keeps-input`, `room-races`, `model-switch-compaction`, `agent-preset`) | 46 |
| Some pass | 20 | 192 pass of 415 |
| None pass | 17 | 0 of 102 |
| Total | 42 | 238 pass of 563 |

Most failures come from these tests driving the runtime through DS Bot's web endpoint `POST /api/bot` (237 fail at the same spot: the route that the test double's `ctx.connection.fetch` would register does not exist), and the web UI and the `connection` service have been removed. Per-file results are in [salvage-trial.tsv](salvage-trial.tsv).

Most of the 238 passing tests cover group rounds, handoff results and bot messages, which we use (for example `group-work` 58/77, `bot-messages` 39/50, `follow-through` 27/28, `blocking-question` 13/14).

**Decision (Zihui, 2026-11-12)**: these 42 files are kept and rewritten to call the runtime directly instead of the web endpoint. Afterwards, the cases that test removed features are deleted; every other case must pass, and they join the baseline before the TS work starts.

## 7. Rewrite steps

1. In the real directory, delete the files marked `delete` in [bot-files.tsv](bot-files.tsv), and keep only `deep-view` in the dependencies of `bot/package.json`. Run the four suites; the results must match the "After" column of section 5.
2. Rewrite the 42 test files as decided in section 6, still in JS. Then fix the baseline: counts and results of the four suites plus the smoke run.
3. Settle the TS conventions before anyone converts code: `tsconfig.json`, the type-check command, `.ts` extensions in import paths, only type syntax that Node can strip, and an actual test of whether DSH can load a `.ts` plugin entry. One person does this first; everyone in the parallel step follows it.
4. Rewrite the source in parallel while the tests stay JS. Sonnet 5.5 (high) subagents, each owning one group below, no overlap:

   | Group | Files | About lines |
   |---|---|---|
   | A | `src/task/` | 1,760 |
   | B | `src/tools/`, `src/adapters/` | 1,520 |
   | C | `src/engine/`, `flow/`, `registry/`, `prompts/`, `bot/`, `config.js`, `app.js`, `plugin.js`, and `scripts/` | 1,900 |
   | D | `host/parts.js`, `btw.js`, `steward.js`, `shared/group-replies.js` | 2,240 |
   | E | `host/groups.js`, `roster.js`, `shared/mentions.js`, `shared/im-platforms.js` | 2,460 |
   | F | `host/turns.js`, `resume.js`, `schedules.js`, `diagnostics.js`, `links.js` | 2,150 |
   | G | the other 16 files in `host/` (`tools`, `store`, `home-lock`, `files`, `folders`, `models`, `permissions`, `approvals`, `requests`, `delivery`, `handoffs`, `chat-index`, `prompt`, `time-context`, `text`, `constants`) | 3,440 |
   | H | `host/local-agents/` | 1,130 |

5. After merging, the main session runs the type check, fixes type mismatches across groups, and accepts the result with the same tests and smoke run as step 2; the results must equal the baseline. Verification and debugging use Opus subagents.
6. Finally convert the tests themselves to TS, also in parallel by directory.

## 8. Notes

- `src/bot/index.js` says only files under `bot/` can resolve `@deepseek-ai/dsh-tools`, which is why `defineTool` is re-exported from `bot/src/host/tools.js`. The tests rely on `bot/test/harness-resolve.mjs` to point `@deepseek-ai/*` at `runtime/`. If the rewrite changes the directory layout, both need handling together.
- Whether DSH can load a `.ts` plugin entry (`src/plugin.js`) has not been tried.
- Static analysis shows what is never loaded, not that everything loaded is executed. The 36 kept files still contain branches for features we do not use (handover section 5.3 notes `parts.js` was not trimmed).
- The "only used modules" class in section 6 is by the modules a file loads; a test file can still test only the parts of a module that we do not use.
