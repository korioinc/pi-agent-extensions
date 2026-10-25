# @korioinc/pi-subagents

Markdown-configured foreground subagents. Each spawn starts a new conversation; follow-up tasks can continue that child history. Parent Pi retains model authentication and authorization for inherited ordinary tools. Explicitly selected child MCP servers authorize calls independently; their capabilities are not limited to the parent callable-tool set or its permission hooks. See the [architecture overview](./architecture.html).

## Usage

From the repository root:

```sh
npm ci
npx pi -e ./packages/pi-subagents/index.ts
```

- `/subagents [search]`: inspect agent definitions and model/thinking settings in a compact TUI list. RPC keeps the text listing. No agent or MCP connection starts.
- `list_agents({})`: list definitions, configuration and diagnostics.
- `subagent_preflight({ agent: "reviewer" })`: check one agent’s local configuration without running a child or connecting MCP.
- `spawn_agent({ agent: "reviewer", task: "Review the current change" })`: create a new logical agent and run its first task.
- `followup_task({ agentId, requestId, message })`: continue an idle agent or steer its running task.
- `close_agent({ agentId })`: close idle or history-unusable agents; never force-release active work.
- `subagent_inspect({ runId?, agentId?, scope? })`: inspect owned runs or logical agents with mutually exclusive selectors.
- `/subagent-runs [query]`: list owned active and retained runs while foreground work continues (TUI/RPC).
- `interrupt_agent({ runId })`: request cancellation; acceptance does not prove work stopped.
- `send_message({ runId, messageId, message })`: parent-agent tool to queue additional data for an owned running child; no user-facing message command.

**Direct model calls only:** `spawn_agent`, `followup_task` and `close_agent` use `exposure: "model-only"`. `spawn_agent` delegates parent tools. Call it directly as a model tool, not as `tools.spawn_agent(...)` inside `codemode`. Codemode intentionally excludes it from `ALL_TOOLS` and `searchTools`; discovery cannot enable it. Use separate direct model tool calls for parallel spawns, and keep codemode batches for callable tools such as `bash`. Discovery and inspection tools remain callable from codemode.

**Tool-name migration:** `subagent` → `spawn_agent`, `subagent_agents` → `list_agents`, and `subagent_cancel` → `interrupt_agent`. Update tool calls and tool allowlists, then use Pi `/reload` or restart. Old names are not registered as aliases. `/subagents` and `@name` syntax are unchanged.

These names follow Codex V2 vocabulary, not its API contract: `spawn_agent({ agent, task })` remains foreground-only; `list_agents({})` lists Markdown definitions, not live agents; `interrupt_agent({ runId })` requests run cancellation without closing logical history; only safe settlement can make native history available for continuation. Inspection and static preflight keep their current names until a separate mapping is selected; neither has an equivalent Codex V2 operation.

The TUI selector appears in the input area, not a floating popup. Type to search, use ↑/↓ to move,
and press Enter or Escape to close. This command only inspects definitions; it never edits the input. Rows show each name followed by its effective `provider/model-id · thinking` settings.
The selected agent's description wraps to the terminal width below and is clipped to the available height; no source/type badges are shown. No detail pages or
configuration editing. Existing drafts are preserved; no task is submitted or executed. RPC listings use 240-byte UTF-8 description previews with an ellipsis when shortened.
Use `list_agents({})` for full configuration and diagnostic details.

`/subagents` rereads definitions created in your agents directory. “Available” means enabled and valid,
not a successful model, skill or MCP readiness check. Disabled/invalid definitions appear in diagnostics. There are no built-in agents. Use `list_agents({})` for full configuration
or non-UI clients. After installing or updating the extension, use `/reload` to register commands
and mention autocomplete.

### Parent delegation guidance

The extension supplies `spawn_agent` with a native `promptSnippet`, `promptGuidelines` and a bounded agent catalog in its tool description. The fixed [parent guidance](./src/instructions/parent.ts) and [subagent role](./src/instructions/subagent.ts) are maintained together in [`src/instructions`](./src/instructions/README.md); Controller registers and renders parent guidance, while Runtime prepares native child prompt inputs. No external `AGENTS.md` is required for this guidance. The parent is encouraged to delegate matching specialist work when it saves time or improves quality, keep simple work local, avoid duplicate investigation and conflicting edits, and verify returned results. User restrictions still apply. Execution remains model-selected and foreground-only; no automatic task router, background notification or task replay is added.

Session start/reload loads enabled definitions through the existing bounded catalog. Successful `list_agents`, `/subagents` and leading-mention lookups refresh the advertised snapshot. There is no per-turn scan or prompt-bottom injection. Changes after a snapshot require a fresh listing or `/reload`; every actual spawn still revalidates the definition. Failed refreshes do not publish partial data. The description includes only exact names and full descriptions after control-character and whitespace normalization, capped at 20 rows and 8 KiB of row text. Individual descriptions are never truncated; entries that exceed the remaining catalog budget are omitted entirely, with explicit omitted-agent counts. Full configuration and diagnostics remain in `list_agents`; availability does not prove runtime readiness.

These instructions and the advertised catalog are parent-only. Child tool selection excludes delegation/control routes, including under `tools: all`. `append` removes the parent tool catalog and this extension's exact native delegation rules while preserving unrelated policy; `replace` does not inherit the parent prompt. Overridden native rules while delegation guidance is active, or relocated guidance that cannot be isolated, reject append preparation rather than leak instructions or erase policy. This is not redaction of separately supplied user instructions, skills or task text.

### Live execution status

In the TUI, one Todo-style `SubAgents (N)` list sits above the editor. Each row shows a state indicator, agent name, short run ID, status, and the latest assistant response excerpt or cleanup detail. Preparing uses `○`, running uses `◐`, and completion uses `✓`; failures and cancellation remain distinct. Narrow terminals drop optional detail and report hidden runs. The list does not take focus or change your draft.

`Stopping`, `Cleaning up`, `Cleanup pending` and `Needs attention` are not completion. Only safe terminal settlement produces `Completed`, `Failed` or `Cancelled`. Rows stay in invocation order, oldest first, even after state changes. Completed rows remain while the Pool retains them; overflow hides later rows. There are no duplicate footer counts or spawn progress/completion cards. Pre-admission errors remain readable as plain text. There is no generated title. The response preview updates from existing assistant text, without another model request; thinking, tool arguments, tool results, task bodies and handoffs are not preview sources. Use `/subagent-runs` for full IDs and owner-scoped `subagent_inspect` for retained results.

The list reads only current-branch Pool summaries in memory, without a separate history cache. Its timer stops when no owned active runs remain; retained rows refresh on the next render or session event. Shutdown removes the list. It does not call models/tools, emit extra progress messages, or alter cancellation and accounting. RPC, JSON and print keep their existing payloads without a UI timer.

### Run identity

Use `spawn_agent({ agent: "reviewer", task: "Review authorization" })`. No `task_name` or separate title is accepted. Concurrent calls to the same agent remain distinct by run ID. **Only `runId` controls or authorizes a run**; the agent name is not a control alias.

Owner-scoped inspect, progress, final spawn results and cancellation results expose `identity: { agent }`. Preparation failures retain that identity. The existing final `agent` field remains compatible. Identity never stores task text or assistant output. The TUI-only preview retains at most 512 UTF-16 code units from the latest assistant text, sanitizes terminal controls, and clips from the left to show newly arriving text. It expires with the run and never enters model-facing summaries or progress.

`/subagent-runs [query]` lists owned active and retained terminal runs in admission order, with rows `runId · phase · agent` (optional values omitted). A case-insensitive substring query matches UUID or agent. Display sanitization removes terminal/control sequences without changing stored identity. The notification fits the catalog byte limit by omitting complete rows and reporting the omitted count; UUIDs are never shortened. It performs no discovery, model request, polling or idle wait, and rechecks origin eligibility before notification. Without UI, use `subagent_inspect`.

`/subagents` and `list_agents` still list definitions; `/subagent-runs` and `subagent_inspect` list executions. Agent mentions do not invent labels.

### Explicit result handoff

Use `spawn_agent({ agent, task, handoff: { runId } })` to reference one owned, retained result, or `handoff: { text }` for parent-supplied background. These forms are exclusive. Task and agent remain required. This always creates a fresh run, preparation, budget and session; it is not a follow-up to a living child or session resume.

Literal text must be nonblank valid UTF-8 and at most 16 KiB. Oversized text, blank IDs, both keys or extra keys are rejected before admission. Source lookup requires the current generation, session and origin branch ancestry. Unknown, expired and foreign sources share `not_available`. Owned nonterminal/unsafe sources return `source_not_terminal`; empty results return `source_empty`. No waiting, automatic retry or recovery occurs.

Safe terminal failed/cancelled results may be selected explicitly. Pool copies at most 16 KiB with UTF-8-safe truncation. `sourceTruncated` means the retained result was already shortened; `excerptTruncated` means handoff shortened it further. Outcome and truncation identify partial references. Source lookup and new admission are synchronous; a busy target does not change the source, and an accepted snapshot survives later source expiry.

Every initial user message wraps the actual task in `<subagent_task>...</subagent_task>`, with `&`, `<` and `>` escaped as XML text. With handoff, the reference warning and `REFERENCE` JSON precede that task block. Reference data never replaces policy or grants permissions. No source history, credentials, tools, MCP selection, model settings or usage are copied, and no model summarizes it. Current parent permission hooks and current agent/MCP selection remain authoritative. **References may contain secrets or misleading instructions:** explicit selection does not redact them or make them trusted. Reference and task framing is not a prompt-injection sandbox.

The actual serialized prompt must fit `5 × LIMITS.taskBytes + LIMITS.handoffBytes + 4 KiB`, allowing for the task's worst-case XML expansion (`&` becomes `&amp;`). Raw task and handoff limits stay unchanged. Serialization overflow produces an admitted failure before child startup, never truncation of policy or the new task. Native model context handling and execution budgets also apply. Omitting handoff still uses the same task block, without reference content.

After final origin authorization, spawn returns only handoff provenance: `{ runId, sourceOutcome, sourceTruncated, excerptTruncated }` or `{ source: "text" }`. It does not echo reference text in this metadata or add it to Pool views. Preflight still checks configuration only, not tasks or handoffs. Handoff provenance itself is not a continuation handle; use the new `agentId` to continue that conversation.

### Active-run messages

The parent agent uses `send_message` with the UUID from progress or `subagent_inspect({})`. Messages only affect the current running child; they never start a turn, wake an idle child, resume a session, or grant authority. Normal progression along the originating branch is allowed; another session or branch cannot send or inspect receipts. Children cannot inherit `send_message`, including through `tools: all` or explicit selection.

Choose a stable `messageId` matching `[A-Za-z0-9_-]{1,64}`. Retrying the same ID and exact text returns its current receipt, even after cancellation or completion. Different text returns `message_conflict`. IDs remain reserved for the run's retention; no receipt eviction or durable cross-generation guarantee exists.

Text must be nonblank and at most 8 KiB UTF-8; original text is preserved, never truncated. Each run accepts up to 8 pending messages, 32 KiB pending text, and 32 lifetime receipts. Capacity rejection creates no receipt. New IDs outside running return `not_accepting`; unknown, expired, or foreign runs return the same `not_available`.

The next natural model request takes the FIFO once as attributed JSON data, before any budget wrap-up notice. It does not enter child history or repeat on subsequent requests. Request budgets and any configured model-token allowance still apply. Receipts mean:

- `queued`: accepted and awaiting a natural request.
- `injected_not_confirmed`: added during context construction; network dispatch, reading, and action are **not confirmed**. Failed requests do not trigger resend.
- `discarded`: the run stopped or settled before consumption. Pending data does not extend execution.

Only owner-scoped `subagent_inspect({ runId })` includes pending count/bytes and message ID/state receipts. Bodies and digests are not returned. Enqueueing itself adds no provider usage. Tool calls retain normal parent permission hooks. **Do not include secrets:** tool arguments follow normal host transcript/logging behavior.

### Static configuration check

`subagent_preflight({ agent })` reuses the same bounded definition, model, skill, instruction, ordinary-tool and selected MCP preparation as execution. It starts no child session, provider authentication/request, tool effect, MCP connection or executable. Selected MCP environment/header values are checked locally but never returned. Append requires a current verifiable parent prompt; replace does not capture it.

`configuration_valid` means local preparation passed, **not ready to run**. The report explicitly leaves model authentication, MCP connectivity/catalog, task validity, call-time tool permissions and `rendered_prompt` unchecked. When skills are selected, it also reports `skill_body_validation` as unchecked. Preparation checks raw instruction text, selected skill metadata and ordinary-tool configuration; final SDK rendering requires a child session. Runtime execution preparation validates selected skill bodies and computes the continuation fingerprint before child startup, so an invalid body can pass preflight and still fail execution. The report returns bounded model/thinking provenance, counts and selected MCP names/transport/exposure only; oversized entries are omitted with counts, never truncated into misleading identities. Errors contain fixed codes and preparation stages, not raw exceptions, paths, prompts or credentials.

Preflight shares one catalog operation with listings, returns `busy` without queuing, and consumes no execution slot. Cancellation/shutdown still waits for acquired filesystem work and closure; unsafe closure remains owned. Results are withheld if the originating session, branch, cwd or trust changes. Reports are not cached or accepted as execution authority: every run prepares again. This does not change the meaning of availability in `/subagents` or autocomplete.

### Agent mentions

In normal TUI input, type a standalone `@` or `@code` to search. Matching agents appear above file
results, using a distinct theme color and a `Subagent` label with model/thinking metadata.
No prior `/subagents` command is required. The agent provider is composed after session-start
providers (including pi-fff), so file-only short-circuit providers cannot hide agent results. Choose an agent. Completion inserts
`@code-reviewer `; append the task, for example `@code-reviewer Review the current diff`.
The input hook requests the parent model to call `spawn_agent` with that exact agent and task.
This is model-mediated delegation, **not guaranteed direct execution**. Tool dispatch, permissions,
usage accounting and cleanup use the existing execution path. Verify that a subagent tool call occurs.

Only a leading `@name` matching an available agent and followed by a nonempty task is interpreted
(TUI/RPC input). Unknown names, inline mentions and explicit file paths remain ordinary input.
A known agent name takes precedence over a same-name file; use `@./name` for that file. Mention names support letters, digits, `_` and
`-`; other valid agent names remain callable through the tool. No multi-agent fan-out is added.
Autocomplete loads manually created definitions on demand, coalesces overlapping requests and caches
a successful snapshot for one second. Branch navigation does not hide these global definitions.
Subsequent `@` queries pick up changes automatically; submission always rescans. Up to 20 matching
agent suggestions precede existing file candidates. Explicit paths such as `@./file` stay file-only. `$skill` completion remains available. Catalog limits or
unavailable/disabled definitions can prevent a mention; use `/subagents` for diagnostics.
CLI positional `@` file-attachment syntax is unchanged. Attached images remain with the parent;
the existing child tool accepts only a text task. Vision-capable child models can inspect images
returned by selected tools; text-only child models receive the SDK's image-disabled notice.

No background delivery, task queue or automatic workspace creation. MCP connections are child-owned and explicitly selected.

## Agent continuations

`spawn_agent` always creates a new logical `agentId` and an initial `runId`. The definition name identifies configuration, not a conversation. Keep `agentId` for subsequent tasks; `runId` controls one invocation. Accepted output includes logical state. A preparation failure without safe native history is not resumable.

Call `followup_task({ agentId, requestId, message })` directly as a model tool:

- **Idle agent:** await a new foreground run with a fresh runtime, Budget, deadline, usage accumulator and provider/MCP resources. The SDK retains the child's native conversation. Current parent policy, permissions and the original named definition are revalidated; historical tool entries do not restore permissions. Only the new run's usage is returned.
- **Running agent:** queue a native steering task on that exact run. The response is a receipt, not a separate answer, and contains no `usage`. Steering uses the original run's remaining limits and deadline. It creates no second runtime or slot; the original foreground call owns completion and accounting. Preparing, stopping, settling and blocked runs reject new tasks.
- **Retry:** reuse the same `requestId` and message after uncertain delivery. An authorized identical retry returns the receipt without execution or usage again. A different message with that ID conflicts. Use a new ID only for an intentional new task. IDs use `[A-Za-z0-9_-]{1,64}`. `queued` and `injected_not_confirmed` do not prove model comprehension; undelivered input can become `discarded`.

`send_message` remains supplemental request-local data, not a follow-up task or a new turn. It never renews limits or restarts a finished run.

Inspection selectors are mutually exclusive: `{ runId }`, `{ agentId }`, or `{ scope: "runs" | "agents" }`. No selector preserves run/generation inspection. `scope: "agents"` lists owned logical agents in the current generation. `agentId` returns state, active/latest run, last outcome and bounded receipts, never transcript bodies or credentials. Old full run results and usage remain volatile and generation-scoped.

`close_agent({ agentId })` idempotently closes an idle or `history_unusable` agent and releases its in-memory history and receipt payloads. Active or blocked agents return `not_idle`: request `interrupt_agent({ runId })`, then wait for safe settlement before closing. Close never force-releases work or undoes external effects. Parent-owned branch-fence entries remain authoritative after history closes.

All controls, results, inspection, handoffs and activity rows require the same parent session, stable workspace identity and project-trust state. Workspace identity combines the canonical path with filesystem device, inode and creation time, so replacing a directory at the same path revokes retained authority. Identity capture fails closed when the filesystem does not provide a positive inode or verifiable creation time. A creation time equal to the change time requires a same-filesystem ancestor with distinct times; otherwise the value could be libuv's unstable change-time fallback and is rejected. The current branch must contain the **latest accepted input fence**, not just the spawn anchor. Accepted follow-ups and new supplemental messages advance that fence. A forked/imported parent, a sibling branch missing it or a changed trust decision cannot acquire authority. Authorization is rechecked before dispatch and disclosure.

### Memory-only history lifetime

AgentRegistry owns each child's native `SessionManager.inMemory()` conversation. Safe history remains available until explicit `close_agent` or the parent extension generation ends. Idle history has no time-based expiry. Reload, parent-session replacement and exit drain owned work before discarding history. A later generation cannot reopen the conversation, even with the same parent session or `agentId`.

Memory capacity failures mark history `history_unusable` and stop continuation rather than silently truncate or replace the conversation. One generation retains at most 32 open logical agents and 256 MiB of serialized native history across sessions and workspaces. Explicit close remains available after owned work settles. Terminal run results and closed-agent tombstones retain their separate one-hour limits; they do not define the conversation lifetime.

History accounting uses the native append-only entry count to avoid copying unchanged histories. New entries are accounted once; existing history errors and both per-agent and generation-wide limits remain checked on every visit.

This package does not write, restore, migrate or delete disk history. Existing files from earlier versions remain untouched. Disk storage, backups and any durable conversation workflow are outside this package. Memory-only continuation adds no background execution, automatic retries or replay.

## Concurrency settings

The runner pool defaults to **3 concurrent runs**. To change it, create
`<Pi agent directory>/sub-agents.json` (normally `~/.pi/agent/sub-agents.json`):

```json
{
  "maxConcurrentRuns": 3
}
```

`maxConcurrentRuns` accepts an integer from 1 through 32. A missing file or omitted key uses the default.
Invalid JSON, unknown keys, invalid values and read errors stop extension loading with a configuration
error; they do not silently fall back. The opened file must be a regular UTF-8 file no larger than
64 KiB; FIFO and other special files are rejected without waiting for a writer. Symlinks to regular
files remain supported. Only the user file is read, not project settings.

Settings are read once when the extension loads. Apply edits with Pi `/reload` or restart; active pools
are not resized. Reload still waits for owned cleanup. `subagent_inspect({})` reports the effective
`maxConcurrentRuns`. Increasing capacity also increases potential model, tool and MCP resource use.
This setting does not change the per-child tool concurrency limit.

## Agent definitions

Create each agent yourself as a direct `.md` file in `<Pi agent directory>/agents` (normally `~/.pi/agent/agents`). Only these files are read. No built-in/system agents, project-directory discovery/overrides, or package-agent autoload exists. Files are reread for listings and named invocations; they must be regular files, not symlinks. `spawn_agent` requires an explicit `agent` name and never falls back to a researcher.

```markdown
---
name: reviewer
description: Review changes without modifying files.
enabled: true
model: openai-codex/gpt-5.3-codex
thinking: high
tools: [read, grep, find, ls]
prompt_mode: append
skills: [review-guide]
---

Report actionable findings with paths and evidence. Do not edit files.
```

Use model IDs registered in parent Pi. See the [example](./examples/agents/reviewer.md) and its [skill](./examples/agents/skills/review-guide/SKILL.md). Copy the example skill to a default Pi skills directory, or declare its local directory in Pi's `skills` source settings; agent-local additional folders are no longer supported.

| Field                     | Behavior                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`     | Required nonempty strings; invocation name and selection description.                                                                                                                                                                                                                              |
| `max_model_tokens`        | Optional positive safe integer limiting observed cumulative child-model `Usage.totalTokens` per run. Omission leaves cumulative tokens uncapped; null, strings, fractions, zero and unsafe integers are invalid.                                                                                   |
| `enabled`                 | Boolean, default `true`. `false` creates a disabled name tombstone, blocking user fallback.                                                                                                                                                                                                        |
| `model`                   | Exact `provider/model-id` registered in parent Pi. Omitted: inherit the complete parent model. Model IDs may contain `/`; no bare-ID or provider fallback.                                                                                                                                         |
| `thinking`                | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; omitted inherits parent. Legacy `ThinkingLevel` / `thinkingLevel` aliases work; conflicts fail. Provider support determines actual reasoning.                                                                                         |
| `tools`                   | Exact ordinary parent-callable names, comma-separated or YAML list. Omitted/`all` inherits classified non-MCP/non-aggregator tools; `[]` selects none. Parent MCP, codemode/search/resource and declared aggregator routes are rejected. `read_text` and `list_files` remain local options.        |
| `mcp`                     | Exact server-name array from `<Pi agent directory>/mcp-sub-agents.json`; omitted/`[]` connects none. No parent/project MCP fallback. Unknown, disabled or namespace-colliding names fail.                                                                                                          |
| `prompt_mode`             | `append` (default): filtered parent policy + fixed role as the native preamble. `replace`: optional instruction file + fixed role, without parent policy. SDK renders the agent body as an addendum, followed by eligible skills, cwd and indirect MCP sections. Replace requires a nonempty body. |
| `skills`                  | Exact names, YAML list or legacy comma-separated names. Omitted/`[]` selects none in both modes; `all` and wildcard selectors error. Selected metadata uses SDK reader eligibility; no body is preloaded. Missing names fail and duplicate names keep the first discovered valid skill.            |
| `prompt_instruction_path` | Optional in `replace` only; rejected in `append`, including when the mode is omitted. UTF-8 file placed first, before the fixed role. Accepts absolute, `~/`, or agent-file-relative paths. A configured missing/empty/unreadable/oversized/invalid UTF-8 file fails preparation.                  |

Invalid or duplicate definitions block their names; malformed files are reported in diagnostics. If directory enumeration fails, the whole scan fails: definitions read before the failure cannot authorize execution or refresh the catalog. No definition error activates a replacement agent. Unknown semantic fields, including unsupported isolation/permission controls, are rejected. Only `display_name` and `color` are ignored with warnings. No executable child extensions are discovered.

`append` preserves the parent's structured policy, context and extension instructions, except the runtime `skills`, `tools` and `mcp_servers` catalogs and this extension's exact native delegation rules. It also removes the generated parent cwd section when `options.sections.cwd === undefined`; explicit custom cwd policy stays intact. The child SDK supplies its own cwd section. Only skills explicitly named by the agent are eligible for advertisement. Parent package/extension skills receive no inheritance exception. Parent conversation entries are never copied. `replace` does not capture parent instructions or resources.

Both modes always include the package-owned [subagent role instructions](./src/instructions/subagent.ts). They identify the child, keep work within its assignment, direct results and blockers to the parent, prohibit asking the user for permission or approval, and require preservation of shared edits. Supplemental `send_message` input remains data for the current task. The SDK renders the native layout: preamble containing the chosen base and fixed role → `<addendum>` containing the agent body → eligible `<skills>` metadata → cwd → `<mcp_servers>` for indirect MCP access. Direct MCP tools use native tool declarations. The task is a separate initial user message. This order does not create a separate instruction-priority level or change tool permissions.

Selected skill names, descriptions and locations pass through the SDK resource loader. The SDK advertises them when a native `read` or `bash` tool is selected; a hidden direct declaration uses native indirect-access wording. `tools: []`, `read_text` alone, and arbitrary custom/MCP readers do not satisfy that gate. Explicit selection opts in a skill marked `disable-model-invocation: true`, subject to the same reader gate. Full skill bodies are not inserted into the initial prompt; Runtime validates them separately during execution preparation and includes them in the continuation fingerprint. The extension does not manually render catalogs or force a final opaque system prompt. Its custom preamble always contains the fixed role, so the SDK does not add its default preamble; native addendum, cwd and catalog sections remain active.

Prompt extensions must keep policy outside the three resource-catalog sections. Compressed catalogs such as pi-cache-optimizer are supported. Opaque whole-prompt overrides (`forceSystemPrompt` or a returned `systemPrompt`) cannot be safely separated and fail before child startup; use structured `systemPromptOptions`, or explicitly configure `replace`, optionally with `prompt_instruction_path`. Arbitrary resource names mentioned in policy prose are not redacted.

**Prompt caching:** child requests use the parent provider's native retention default and environment (including `PI_CACHE_RETENTION=long` where supported), unless the SDK explicitly supplies a request preference. The bridge no longer forces caching off. Each logical child keeps its own session ID across follow-ups. MCP connection timing and tool-list order do not change the initial declaration order or native codemode catalog: metadata is sorted by tool name before rendering. No agent configuration change is required. Background cache warming remains off, so enabling ordinary prompt caching adds no maintenance requests.

Cache reuse still depends on provider support, minimum prefix size and expiry. Actual model, policy, tool-schema or capability changes remain authoritative and can change the reusable prefix. Supplemental data stays request-local, and safeguard summaries still disable tools and thinking. Cache stability never restores revoked tools or freezes outdated instructions. Inspect the existing child `usage.cacheRead` and `usage.cacheWrite` observations to assess real provider reuse; in-memory history alone does not guarantee a cache hit.

The extension owns a read-only candidate catalog. It includes default Pi skill directories, positive user/trusted-project settings paths and already-installed local/managed npm/Git package skill declarations. Parent activation exclusions (`!`, `+`, `-`, package skill selectors) do not remove child candidates; parent settings and active skills are never rewritten. Package manifest exclusions still apply. Candidate frontmatter is read first, and selected frontmatter is reread to revalidate metadata without acquiring full bodies. Same canonical files deduplicate; duplicate selected names keep the first valid skill in existing discovery order and skip later matches. Omitted or empty selection performs no skill discovery.

Defaults remain `<Pi agent directory>/skills`, `~/.agents/skills`, and trusted-project `.pi/skills` plus ancestor `.agents/skills` through the repository boundary. Relative source paths use their settings scope. Discovery skips dot entries and `node_modules`; `.gitignore`, `.ignore` and `.fdignore` are not interpreted. CLI/extension-injected roots and legacy npm locations are not automatically enumerable; declare their local directories in settings. Missing configured packages or unsupported installed-source forms fail explicitly, without installation, network access or package-manager subprocesses. Only canonical host/owner/repository Git locations are resolved; complex hosted URLs require an explicit local path.

For a shared subagent instruction file, use:

```yaml
prompt_mode: replace
prompt_instruction_path: ./instructions/subagent-base.md
```

The path is relative to the agent definition, not the working directory. The file content and fixed role form the preamble. The SDK places the agent Markdown body in `<addendum>` before eligible skill metadata, cwd and any indirect MCP server catalog. Omit the path to start the preamble with the fixed role; a nonempty body is required in either case. The fixed role is always included and cannot be disabled by omitting the path or selecting `replace`.

**Prompt composition change:** both modes now use SDK resource-loader inputs and native section ordering. The agent body is an addendum before skill metadata; skill display follows native reader eligibility, and direct MCP tools need no server catalog. Skill bodies and parent package/extension skill catalogs remain excluded. In `replace`, a configured instruction file precedes the fixed role. The role does not satisfy the nonempty agent-body requirement. User agent and instruction files are not rewritten.

**Migration:** rename `prompt_default_instruction_path` to `prompt_instruction_path`. Change `prompt_mode: append_custom` to `replace` and rename `prompt_default_instruction` to `prompt_instruction_path`; keep a nonempty agent body. The old mode and key now produce migration errors rather than falling back. A path configured with `append` must be removed or the mode explicitly changed to `replace`; it is never silently ignored. Remove `skill_add_folders` and replace `skills: all` with exact names. Existing `replace` definitions no longer inherit parent instructions. `append` no longer inserts an additional SDK default preamble. No agent file or parent setting is automatically converted. Leading `@name` mentions request model-mediated delegation through `spawn_agent({ agent, task })`. Native tool guidance and the advertised catalog also encourage the parent to select suitable specialists; deterministic automatic selection remains unsupported.

## Models and tools

Requires Node.js 24+ and stable Pi SDK **`>=1.4.0 <2.0.0`**. Model dispatch uses parent `modelRegistry.streamSimple()`, preserving existing API keys, OAuth/login, refresh, endpoints and custom-provider configuration. No separate subagent login or credential copy.

Select physical models. `pi-virtual` fails during admitted preparation before child creation or model dispatch because the SDK does not expose session-aware virtual routing here.

Named agents can select ordinary shell/mutation tools. Inherited calls use parent `ctx.executeTool()` with validation, permission hooks and combined cancellation. Parent MCP, `codemode`, `tool_search`, MCP resource tools and declared aggregators are excluded even under `tools: all`; explicit requests fail. Unknown provenance never broadens inheritance. Agents share the workspace without package-owned read/write locks, revision cancellation or quarantine. The SDK's native `write`/`edit` queue serializes same-file operations within its process/module; it does not cover `bash`, MCP or the whole workspace. Concurrent tasks must account for overlapping edits and external effects.

A user definition may explicitly select bounded `read_text` and `list_files` without shell or mutation tools. Reads use UTF-8 byte windows and `nextOffset`; directory scans inspect at most 200 entries and report possible truncation without a cursor. `read_text` compares checked and opened file identities, then rechecks the canonical target, its identity and the original root before reading bytes. Observed replacements are rejected and opened handles are closed. These pathname checks are not an atomic sandbox against a hostile concurrent writer; directory listings are not filesystem snapshots.

## Child-owned MCP

Select servers in agent Markdown:

```yaml
tools: [read]
mcp: [figma-bridge]
```

Define them separately in `<Pi agent directory>/mcp-sub-agents.json` (normally `~/.pi/agent/mcp-sub-agents.json`):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "/absolute/path/to/your-mcp-server",
      "args": [],
      "timeout": 30,
      "exposure": "codemode"
    }
  }
}
```

Replace the executable with the server's actual command. This file is not created automatically. Neither parent `mcp.json` nor project MCP configuration is read or merged. All selected servers must connect and list valid tools before the child prompts; failure closes acquired connections and returns an error, never parent fallback. One invocation owns its connections; simultaneous agents may start separate server processes.

`codemode` is the default, using Pi’s native `createMcpExtension`, `createCodemodeExtension` and `createToolSearchExtension` inside the child. The child registers only selected-server tools in its own SDK registry. Scripts use `ALL_TOOLS`, `searchTools()`, `describeTool()`, `describeNamespace()` and `tools.mcp__…()` exactly as in main Pi. `deferred` uses native child `tool_search` activation and remains callable from codemode; `direct` declares tools immediately; `hidden` is unreachable. Native `<mcp_servers>` lists indirect codemode/deferred access; direct tools use their declarations instead of a server catalog. `toolExposure` retains native exact/pattern precedence. Native resources, list-change updates and lazy reconnect apply only to selected servers. Parent MCP connections, registries, codemode and tool_search are never inherited.

To list MCP names in one codemode call:

```js
text(ALL_TOOLS.filter((tool) => tool.name.startsWith("mcp__")).map((tool) => tool.name));
```

Migrate agent instructions from the removed `mcp_search`/`mcp_describe`/`mcp_call` interfaces to these native APIs. Existing explicit `deferred` settings remain valid; change to `codemode` for the main-Pi default. User configuration and agent files are not rewritten automatically.

Supported configuration: stdio `command`/`args`/`cwd`/`env`, or HTTPS/loopback HTTP `url`/`headers`; optional `enabled`, `description`, `timeout` (positive seconds up to 180), `exposure`, `toolExposure`. `${ENV}` resolves only in selected env/headers; missing variables error. Stdio supplies `HOME` automatically (parent value, or the OS home directory when absent/empty) and inherits only `PATH`, `TMPDIR`, `SYSTEMROOT`, `WINDIR` plus explicit env—not all parent environment variables. Server-specific `env` overrides these defaults. Socket/cache clients such as `cua-driver` and `codebase-memory-mcp` need no explicit HOME entry. Credential variables still require explicit configuration. Relative cwd is invocation-relative; `~/` is expanded. HTTP redirects are rejected and every response body is bounded before parsing.

**Explicit unsupported settings:** `oauth`, provider-token `auth`, command-based `!` secret resolution and legacy SSE. Use explicit environment/header credentials. No login browser, stored parent OAuth credentials or parent model credential is used by this MCP path. Argument schemas, coercion and validation now use the same SDK implementation as main Pi; the previous custom schema subset and 100 ms VM validator are removed. Treat selected servers and their schemas as trusted executable dependencies: synchronous SDK validation is not preemptible. Native MCP results retain structured content for scripts and use native model-output truncation/spill behavior. Codemode non-chat `models` APIs are disabled to preserve the child’s model-budget/authentication boundary.

**Permission boundary:** selecting a server in a trusted agent definition authorizes its visible calls under this user configuration. Child-local MCP does not inherit parent permission-extension hooks. Use only trusted servers/configuration; this is routing isolation, not process/network sandboxing. Parent model authentication and ordinary inherited tool hooks remain unchanged. Server result content is not a secret-redaction service; protocol/transport exception details are suppressed, but an authorized server can intentionally return sensitive content.

Limits: four selected servers and 8 MiB aggregate tool-list response bytes per invocation. The SDK owns stdio/SSE framing limits; this extension does not override them (the pinned SDK 1.4.0 default is 16 MiB). Non-SSE HTTP responses, including JSON and error bodies, have a separate package-owned 16 MiB whole-body bound before SDK parsing, which otherwise buffers the whole body. Successful SSE responses use the SDK's per-event limit plus a separate 256 MiB transfer allowance per selected HTTP transport lifetime, shared across response streams and reconnects. Exhausting that transfer allowance aborts the transport's owned requests/readers and denies new acquisition; it does not detach pending cleanup. These transport resource limits are independent of model context capacity and model-facing text truncation.

Native pagination bounds and duplicate-cursor checks apply. The first model request waits for all selected servers; startup/catalog failure never exposes a partial ready set. Every dynamically registered native tool and nested codemode tool call passes through Runner Budget. Codemode itself consumes neither the actual-tool allowance nor a leaf-tool concurrency slot. Its nested tool calls each consume one start, just like direct calls. Codemode retains its authority, cancellation, deadline, output and pending-work guards. Native codemode also has its own process-wide worker limits. Abort starts SDK cancellation and native MCP shutdown/owned transport closure concurrently before pending work drains. First closure failure stays unsafe on repeated close; no timeout or zero count releases ownership. Remote side effects are not rolled back. HTTP cleanup aborts local I/O; remote session deletion and stdio descendant termination remain SDK/OS best effort.

Append removes the parent MCP advertisement section and tool catalog. Only servers explicitly selected by the agent connect. Selected skill metadata does not grant parent MCP routes. Policy prose and explicit agent instructions remain intact, so this is catalog isolation, not arbitrary text or filesystem redaction.

## Preparation and lifetime

Up to `maxConcurrentRuns` nonterminal runs (default 3) hold slots through preparation, execution and cleanup. Slot reservation and startup/invocation deadlines commit atomically before bounded asynchronous discovery. Excess work returns `busy` without discovery, queuing or retry. Agent selection and preparation errors become admitted failed results with `runId` when cleanup is safe, not pre-admission rejections.

Candidate limits apply even to unselected skills: 64 KiB per file, 8 MiB aggregate reads, 32 roots, 4,096 examined entries including skipped entries, depth 16. The 4 MiB prompt/configuration budget covers raw instructions, selected metadata and ordinary tools during preparation. ChildSession checks the SDK-rendered prompt at startup; before every dispatch, `ParentProvider.request` checks the actual system text and effective tool declarations, including dynamic SDK changes. Startup: 60 seconds from admission within a 30-minute invocation deadline. Overflow fails without truncating policy. Pending filesystem work and handle closure remain owned during cooperative cancellation.

Catalog listing owns one bounded task per generation without an execution slot. Concurrent requests return `busy`; shutdown cancels and awaits the task. Catalog output is capped at 64 KiB with explicit omission counts; omitted names require fresh bounded resolution.

After five seconds of **hard-stop** grace, `blocked` is progress through updates/inspect, not foreground completion. It retains its own slot and marks health as degraded without blocking other free slots. Foreground completion stays pending until started delegated calls, usage accounting, provider cleanup and SDK shutdown settle safely. Parent dispatch records nested tool usage; outer results report child-model usage only. Resource-close failures remain unsafe/blocked and retain the owning run's slot and shutdown barrier. No timer, expiry or force release establishes safety.

Run results require the current generation, originating parent session, stable workspace identity and a branch containing the latest logical-agent fence; authorization is rechecked before delivery. Unknown, expired and unauthorized IDs are indistinguishable. Retain at most 32 terminal answers for one hour, each capped at 256 KiB of UTF-8-safe text with truncation metadata. Active/blocked ownership never expires. Reload, replacement and exit drain invocation, catalog and cleanup work before discarding volatile results and memory history. Conversations cannot reopen in a later generation. Save answers first.

Each invocation allows 48 counted model turns. The initial request and later requests without new tool results consume a turn. The immediate request processing new native tool results does not, including error results and results accompanied by steering or supplemental data. A batch grants only one exemption; retained history grants none. A continued tool chain can therefore exceed 48 model dispatches. All dispatches remain counted in owner-only `providerRequests`, and all observed model usage remains accounted. Each `ParentProvider` serializes its requests through transport cleanup; there is no generation-wide provider gate. Other [limits](./src/runtime/limits.ts): requested 8,192 generated tokens or lower model limit, 256 actual child tool starts (excluding codemode itself), four concurrent leaf tools and 180 seconds per call. Pi SDK owns tool formatting, text truncation/spill, image normalization and structured script results. The wrapper preserves each result and update unchanged within these separate resource bounds:

| Resource                                 | Allowance                                                        | On excess                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One serialized tool result or update     | 64 MiB                                                           | Withhold a completed result with a recoverable tool error; stop/drain an active producer for an oversized update |
| Update activity per tool call            | 4,096 callbacks and 128 MiB serialized traffic                   | Stop the run and drain owned work                                                                                |
| Provider response processing per request | 8 MiB each for inbound wire bytes and serialized provider events | Stop and drain owned response work                                                                               |

Repeated progress snapshots do not consume the final result's allowance. Their serialized traffic still counts as processing work, including repeated data, and empty-update bursts consume the callback allowance. The wrapper uses `JSON.stringify` and counts UTF-8 bytes after serialization. It does not reserve aggregate tool-result memory. SDK model-facing text truncation and full `structuredContent` remain intact within the envelope ceiling. Provider response guards measure incoming response processing only, not outgoing history or images.

Model context handling remains with the SDK and selected provider. The wrapper does not impose a serialized-history/request byte cap as a model-context limit. Separate in-memory continuation capacity checks apply at native history boundaries; base64 image length is not a context-token count. It also does not turn the SDK's approximate token estimates into a new hard admission rule. Native context-limit errors fail the run through normal error/cleanup handling. Automatic child compaction and retries remain disabled; deadlines, tool limits and any configured cumulative model-token allowance still apply. More model requests can run within the deadline; without a configured model-token allowance, there is no fixed aggregate token or spending ceiling. These controls do not guarantee a fixed total heap footprint.

Completed-result errors report the measured size and limit so the child can inspect existing artifacts, request smaller output or report partial completion. The operation may already have had effects; nothing is rolled back or automatically replayed. Time, admission, model context and transport limits remain independent. Pre-return allocations and synchronous third-party work are not preempted by these checks.

A final model `length` stop reports a failed, incomplete answer while retaining partial text and usage; `truncated` still describes retained-output byte truncation only. An intermediate `length` turn followed by a normal SDK completion does not itself fail the run. Output truncation alone does not trigger safeguard. Parent tools own nested work and effects. Provider usage accuracy, retries, non-fetch transports and cancellation remain adapter-dependent or best effort. No universal billing, memory, forced termination or rollback guarantee. Automatic child retries, warming and compaction are disabled.

Before a natural model request, one wrap-up advisory still asks the child to finish when at most two counted turns or eight tool starts remain, or observed remaining `max_model_tokens` is positive and at most `ceil(limit * 0.1)`. This is an early advisory, not the safeguard allowance.

### Safe guard handoff

Exhausting counted turns, the invocation deadline, or a tool deadline enters `safeguarding` instead of immediately aborting the run:

```mermaid
flowchart LR
    Work[Normal work] -->|Turn or time limit| Finish[Seal new work; finish existing operations]
    Finish -->|SDK idle and operations drained| Summary[One no-tools handoff request]
    Summary --> Cleanup[Safe cleanup]
    Cleanup --> Parent[Parent receives incomplete result and handoff]
```

- New ordinary model requests, tool starts, steering and supplemental messages are denied. Already-started work has up to 30 seconds to finish before ordinary SDK/tool cancellation. No uncertain operation is automatically repeated.
- The same session then receives one handoff-only request using its existing evidence. Tools are deactivated and execution boundaries also deny tools, including nested codemode/MCP calls. The request reports findings, effects, verification, unfinished work and uncertainties.
- Summary time is at most 60 seconds, within an absolute 90-second safeguard window from the first trigger. Output is capped at 2,048 tokens or the model's lower ceiling, with thinking and retries disabled. This one request is separate from the exhausted ordinary-turn allowance; its usage is still counted.
- The result remains `failed`/incomplete, not successful task completion. `safeguard.reason` retains the first trigger; `safeguard.stage` reports `finishing`, `summarizing`, `summarized` or `unavailable`. A valid summary replaces the partial text only after provider cleanup. Failed, empty, truncated or tool-calling summaries preserve earlier useful text.
- Hard cancellation, shutdown, revoked authority, invalid history, unsafe cleanup, resource guards and explicit `max_model_tokens` still take precedence. Startup expiry has no usable execution session to summarize and remains a startup failure.
- The safeguard window bounds permission to work, not guaranteed return time. Uncooperative operations retain their slot and completion barrier; after hard-stop grace they remain `blocked`. Summary never overlaps unresolved tool/provider work. Cleanup failure cannot be hidden by a handoff.

After safe settlement, only an explicit `followup_task` starts another invocation with fresh limits. A safeguard is not a retry or a new task.

### Cumulative model-token allowance

Set `max_model_tokens: 50000` in the user-owned agent Markdown to limit one run's observed cumulative SDK `Usage.totalTokens`. Listing and successful preflight expose the configured `maxModelTokens`; preflight consumes no model usage. Omission leaves cumulative tokens uncapped. Spawn arguments cannot change the cap, and editing the definition does not change an active run.

Completed-message totals replace the previous observation; they are never added again. Cache and reasoning tokens are not added on top of the SDK total. Reaching or exceeding the cap stops new provider/tool effects, including tools proposed by that response. Even a normal final answer exactly at the cap returns failure with partial text and all incurred usage. Invalid, unsafe or decreasing enabled totals stop with `usage_unavailable: model token budget`; exhaustion uses `limit_exceeded: model tokens`. The first cancellation reason still wins, and started work retains its cleanup/accounting ownership.

Only owner ID inspect adds `observation.modelTokenBudget` with `limit`, optional last valid `observedTotal`, and `not_observed | within_budget | exhausted | unavailable`. No message means unobserved, not zero. The diagnostic is not an additional usage charge.

This is **future admission control, not a billing guarantee**. A dispatched request can overshoot before its completed usage arrives. Normal-work output `maxTokens` stays unchanged; safeguard uses its smaller ceiling. Delegated-tool model usage and other runs are excluded; provider under-reporting or missing usage normalized to zero cannot be detected here. Safeguard does not override this cap.

## Inspecting blocked work

Use `subagent_inspect({})` for generation health, owned-run diagnostics and catalog activity. Use `subagent_inspect({ runId })` for one owned run. Diagnostics separate the pool phase from the current Runner stage and include first admission/stop timestamps, phase/stage elapsed time, executor status and pending child-tool/provider-request counts, including codemode’s nested child calls. Durations use a monotonic clock and freeze at terminal settlement. No tool arguments, paths, prompts or credentials appear in the diagnostic snapshot. The owner-only `subagent_inspect({ runId })` response additionally includes volatile `activity`: `providerRequests`, actual-tool `toolStarts` and separate `codemodeStarts` admission totals, plus up to eight recent SDK tool calls with names (at most 128 UTF-8 bytes each) and `started`, `returned` or `error` states. An admitted actual tool consumes one start even if execution later fails. Codemode-only scripts consume no actual-tool allowance; their execution remains bounded by other guards. SDK-rejected unknown or invalid calls can appear without consuming a Budget tool start. These are not network-request counts, nested parent work or proof of semantic success. Arguments, results, raw errors and prompts are not retained; activity is excluded from progress, cancel responses, final results and no-ID lists.

ID-specific inspect also includes owner-only `observation`. Its optional `selection` freezes the prepared `provider/model-id`, thinking level and each choice’s `agent` or `parent` source. It is absent before successful preparation or when its metadata exceeds 4 KiB. `modelUsage` is `not_observed` before the first assistant message ends, `observed` with cumulative SDK totals afterward, or `unavailable` for invalid numeric totals. A real zero-usage message is distinct from a startup failure with no message. These are completed-message **child-model-only** observations, not streaming estimates, delegated-tool usage or guaranteed billing amounts. Unknown pricing can appear as zero. Repeated inspect calls do not add usage. Progress, cancel/final responses and no-ID lists omit the new observation; existing final-result usage remains unchanged. A blocked run can retain or update its last observation without proving cleanup.

A blocked run retains **only its own slot**; existing runs continue and new runs can use remaining capacity. `degraded` health is diagnostic, not an admission veto. Unsafe catalog cleanup disables further catalog listings without cancelling runs or preventing independent per-run discovery. Catalog stage/times are origin-scoped; other origins see only generic health/activity.

- Blocked `recovery: await_owned_work`: the executor is still pending and may finish safely. Inspect the stage and pending counts; cancellation cannot undo committed effects.
- `recovery: containment_required`: the executor rejected, or catalog cleanup is unsafe. No automatic recovery continuation exists; foreground completion and shutdown remain pending. Inspect external effects before operator containment. Never replay the accepted task automatically.
- `stage: mcp_close`: SDK cleanup attempts finished; MCP closure remains pending. The idle SDK is no longer retained merely by this wait, but neither its slot nor foreground result is released.
- Zero pending counts, elapsed deadlines and repeated cancellation never prove cleanup safety or unlock a slot.
- On request exhaustion, inspect the owned run’s `activity` for repeated tool names/errors. These summaries help distinguish failed calls from normal exploration; they do not diagnose why a model continued. A failed result preserves the last nonempty assistant text as partial work, not a successful answer.

If containment requires terminating Pi or a noncooperative external operation, first account for its external effects. Termination can lose volatile answers or usage. Never automatically replay an accepted task. Remaining Pool capacity does not isolate shared-workspace effects or process failures.

### Recovery procedure

1. Inspect from the originating parent session, workspace and authorized branch. `not_available` also covers a missing workspace or disposed host context. Restore the original workspace path or return to the authorized branch before inspecting again. A replacement session or generation cannot recover old history.
2. Save the owned `runId`, `agentId`, `phase`, `stopReason` and `diagnostics` before taking further action. Record `observation.modelUsage` separately from final accounted usage; adding the observation again would double-count it. Record known external effects without copying secrets or full tool payloads.
3. If the run is still doing ordinary work, request `interrupt_agent({ runId })`. Then inspect its current stage. Repeated interruption does not shorten cleanup or release capacity.
4. Use the table below to identify the owner still being awaited. Check the corresponding tool or MCP service's own status when available. Elapsed time and zero pending counters do not establish safety.
5. If the run becomes terminal, save its answer and final usage before `close_agent({ agentId })` when that history is no longer needed. If it remains `containment_required`, stop assigning work that depends on its uncertain effects and investigate those effects before deciding whether to terminate the affected external operation or Pi. Reload waits for safe settlement; close rejects active or blocked agents until they settle. Neither is a recovery shortcut.

| Observed state                                               | Owner or uncertainty                                                           | Operator action                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `await_owned_work` with `preparation`                        | Definition/skill I/O or handle closure has not finished.                       | Check the relevant local filesystem or mounted volume; keep the accepted run owned.                                             |
| `await_owned_work` with `execution`, `abort` or `operations` | A tool, model producer or transport may still be active.                       | Compare pending counts and recent tool names, then inspect the responsible operation. Do not repeat its effects.                |
| `sdk_shutdown` or `dispose`                                  | SDK teardown is still in progress.                                             | Wait for its lifecycle owner; empty tool counters do not bypass this stage.                                                     |
| `mcp_close`                                                  | SDK cleanup attempts finished while MCP closure remains pending.               | Check the selected MCP service or process. Remote session cleanup and descendant termination remain best effort.                |
| `containment_required` or catalog `unsafe`                   | Cleanup could not be established; no automatic settlement continuation exists. | Preserve diagnostics and reconcile external effects before operator containment. Remaining independent slots may still be used. |

All these steps use current inspection and existing cancellation. They do not add a background worker, force-unlock, automatic retry or durable recovery store.

## Internal ownership

Controller routes spawn, continuation and close through [`AgentRegistry`](src/agent-registry/index.ts). Registry owns logical identity, receipts, parent input fences and the lifetime of each native `SessionManager.inMemory()` history. Pool owns per-run admission, cancellation and settlement; Controller also uses Pool directly for run inspection, cancellation and handoff projections.

Controller captures live parent identity, stable workspace filesystem identity, branch, anchor and trust in one guarded read. An unavailable or replaced workspace produces no matching snapshot. Registry treats that absence as denied authority for admission, controls and disclosure; revocation still visits every active owner. Snapshots are never cached as fallback authority. Final denial preserves usage already incurred by safely settled work. Effectful fence writes and runtime cleanup retain their own failure paths.

Unchanged native branch ancestry is reused without caching workspace or trust decisions. Safe completion releases foreground callbacks/adapters while preserving only the shared authority needed for retained answers. Completed answers expire without requiring another query; active or unsafe owners never expire.

Preparation reads scope before discovery, then snapshots only the selected model and tool declarations from fresh parent state. Tool lookup uses first-match indexes with the same provenance checks. Streaming forwards new text rather than cumulative snapshots; Pool updates its bounded result and preview incrementally, while Session preserves full evidence for final results and safeguard handoffs.

Runner coordinates admitted preparation, budgets and cleanup. [`ChildSession`](src/session/index.ts) uses the registry-owned history and owns the disposable SDK child: creation, prompt/tool configuration, event subscriptions, parent-model streaming and SDK resource teardown. No second session store is introduced. `session/resources.ts` owns explicit loader/factory installation. `session/provider.ts` registers the parent bridge through native `Provider.streamSimple` and public `lazyStream`, rather than replacing the agent stream. It serializes requests through producer/result and transport closure, including late fetch acquisition; first cleanup failure prevents later dispatch. Child-model usage is still counted only by session message events.

Settlement proceeds in order: `ChildSession.abort()` → `Budget.drain()` → `ChildSession.close()` → Registry history validation → Pool terminal settlement. Abort starts MCP closure but awaits only SDK abort. After owned operations drain, close joins MCP closure and provider safety in parallel with SDK shutdown/disposal. A slow MCP close no longer retains an idle SDK context; final settlement still waits for every owner. The handle exists before asynchronous startup so partial initialization remains cleanable. Session cleanup failures retain blocked ownership instead of releasing capacity. Parent model authentication and ordinary inherited tool authorization remain unchanged; child MCP calls use the separately documented selection boundary.

## Development

```sh
npm run check
```

Run root `npm run check` and `npm run pack:check` before release. Maintained tests cover definition compatibility, bounded preparation, catalog ownership, admission, authorization, cancellation and cleanup. Offline SDK probes verify policy composition. The actual SDK late-usage test keeps foreground completion pending through blocked progress and records child usage 3 plus delegated usage 7 exactly once: 10 total. Offline SDK checks cover parent model/auth inheritance and permission hooks; no paid provider is the oracle.

### SDK support

Supports stable Pi SDK **`>=1.4.0 <2.0.0`**. The development workspace uses SDK 1.4.0.

See the [HTML architecture summary](./architecture.html) and root [release process](../../README.md).

## Installation

After the first npm release:

```sh
pi install npm:@korioinc/pi-subagents
```

## License

[MIT](./LICENSE).
