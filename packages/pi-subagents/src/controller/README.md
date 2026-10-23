# Controller

Caller capture always rechecks workspace identity and project trust. Only native branch ancestry is reused: a weak cache holds one ID set per SessionManager and invalidates on session ID, leaf ID or leaf-object changes. Reloading the same session/leaf IDs still replaces the native leaf object. Cached ancestry is never a fallback for unavailable live authority.

Execution and preflight share a lazy `ResearchSource`: initial preparation reads only its authority scope, then Runtime captures fresh policy and capability catalogs after resolving the requested definition. Model and schema copies are restricted to the selected capabilities. Creating the adapter does not read catalogs, capture prompts or execute tools.

One guarded `caller()` read captures live session, canonical path plus filesystem identity, branch, anchor and trust. Missing or same-path-replaced workspaces and disposed SDK contexts produce no matching snapshot. `ParentAccess.current()` never throws: Registry and direct Pool routes deny unavailable callers, while UI projections suppress stale data. Final rejected delivery still forwards incurred child-model usage. Fence writes, host-policy capture and cleanup remain separately owned operations; their failures are not swallowed by the identity guard.

`parent-prompt.ts` retains the run's native prompt options for structured policy capture. After admission,
append replays the current structured system prompt and verifies it against the effective prompt.
It removes the reserved resource catalogs (`skills`, `tools`, `mcp_servers`) and exact native
delegation rules defined in [`../instructions/parent.ts`](../instructions/parent.ts). It also removes the generated native cwd section only when
`options.sections.cwd === undefined`, preserving explicit custom cwd policy and other sections. No parent
package/extension skill catalog is inherited. Opaque forced prompts, overridden rules while
delegation guidance is active, and relocated owned guidance fail rather than leak instructions
or drop policy. No parent prompt or settings are mutated.

The fixed parent-only `spawn_agent` description, snippet and guidelines live in `instructions/parent.ts`.
`spawn-description.ts` combines that description with the bounded name/description advertisement.
Controller registers the guidance and uses the same guideline definitions for parent-prompt filtering.
Session start/reload and successful guarded catalog listings update the same tool
definition through native registration, preserving execution and exposure. No per-turn scan,
extra prompt section, autonomous router or new tool is introduced. Advertisements are advisory;
execution prepares again. Catalog failure never publishes partial results. Existing catalog
cancellation, ownership and shutdown drain also cover the initial advertisement.

Loads user capacity once before registering tools; creates Pool and the generation-local in-memory AgentRegistry. Registers catalog discovery, static preflight, explicitly named foreground submission, continuation, close, inspection and cancellation. Spawn, follow-up and close enter AgentRegistry; run inspection, cancellation and handoff projections use Pool directly. Cheap input validation and parent identity capture precede admission. For spawn or idle continuation, Registry reserves the logical admission lane, obtains a Pool run and commits the parent input fence before opening execution. Host-policy capture, selection and preparation follow atomic slot/deadline creation. Safe selection/preparation failures return admitted failed results with `runId`.

Controller passes the validated agent name to AgentRegistry, which supplies `{ agent, agentId }` to Pool. The same name is used for execution and the compatible final field. There is no task title parameter. `/subagent-runs [query]` displays the current owner summary in admission order, filtered by case-insensitive UUID/agent substring. Complete rows share the browser sanitizer and fit the catalog byte allowance with an omission count. The command rechecks session/branch before notifying; no discovery, polling, idle wait or model request. Definition listing and mentions stay unchanged.

`activity.ts` owns the TUI-only `SubAgents (N)` list under widget key `pi-subagents.activity`, without a footer status. It reads `Pool.inspectActivity` for current-owner active and retained terminal summaries with bounded assistant previews, in admission order. One 250ms unref timer runs only while authorized nonterminal runs exist; terminal-only rows remain without polling. Admission, settlement and session/tree events refresh immediately. Render reauthorizes rather than trusting cached rows. Shutdown revokes rendering before awaiting drain. UI failure disables that attachment without changing execution; only session start or new admission retries it. Other widgets, editor input and the parent working indicator remain untouched.

`render.ts` provides pure bounded Todo-style rows with status glyphs, collision-safe short IDs, live assistant text or cleanup detail and elapsed time when space permits. Failed rows show the stop reason, falling back to the authorized run error when no stop reason exists. Phase takes precedence over cleanup stage; blocked is never inferred to be complete. The spawn tool uses `renderShell: "self"` with empty call/admitted-result components, eliminating both colored cards and their spacer. Rejections and unknown stored details retain sanitized plain-text feedback. Renderers do not read Pool or start timers, and model-facing content/details/usage remain unchanged.

Optional spawn `handoff` validates exactly one bounded literal text or nonblank runId. Pool authorizes and copies only safe terminal references before synchronous new admission. Controller never serializes inspect results or reuses source capabilities. Final handoff provenance excludes text and is attached only after the target origin recheck, not to Pool RunView/progress.

For `send_message`, Controller validates parent authority and commits the latest input fence through AgentRegistry before publishing to the run-local Pool inbox. Parent permission hooks remain intact. There is no user-facing message command. Owner ancestry is captured from the actual guarded context, not supplied metadata.

`/subagents [search]` opens `browser.ts` inline in the editor area using Pi's model-selector pattern:
native search, compact name plus effective model/thinking rows, selected description, and Enter/Escape to close.
There are no popup, detail or diagnostic pages. RPC retains the bounded text listing; full configuration
and diagnostics remain in `list_agents`. The selector shares the owned catalog and origin recheck,
closes on shutdown, and aborts its pending scan on disposal without abandoning catalog cleanup.
The command is inspection-only: it never changes input, submits, runs or edits definitions. Listing adds no execution slot, readiness
connection, model request or transcript injection.

`mentions.ts` composes native TUI autocomplete without replacing the editor. Standalone `@` tokens
show matching agents first, color-coded with model/thinking metadata. Provider composition runs in
`resources_discover`, after all `session_start` registrations (including pi-fff), on startup/reload.
Literal inserted values remain
`@name`. File/skill completion retains its own handlers. A dedicated bounded `AgentCatalog` loads
manual user definitions on demand with one coalesced scan and a one-second snapshot; it is independent
of `/subagents` and branch history. Individual completion aborts suppress delivery without abandoning
shared work. Shutdown invalidates the snapshot and drains that scan alongside the command catalog.
A leading `@name` still revalidates through the command catalog and transforms user input into a
parent-model request for the existing spawn_agent tool. It does not guarantee invocation or fabricate a tool context. Known taskless or newly unavailable names are handled errors; unknown/inline/path mentions are unchanged.

Captures narrow parent model/tool adapters, never conversation entries or credentials. Parent prompt capture is mode-aware after definition resolution: append inherits it; replace does not read it, including when an instruction file is configured. Origin authorization is checked again for each capture. Only manually created agent-directory definitions are accepted. Invalid/disabled definitions fail closed without built-in or project fallback.

Updates and inspect expose progress, including `blocked`, without resolving foreground completion. Delivery waits for terminal accounting and safe cleanup, then rechecks origin authorization. Selected ordinary parent tools retain parent permission hooks. Explicit child MCP selection independently authorizes child-local calls; the parent hooks do not apply to those calls.

`subagent_preflight({ agent })` validates only the name, captures the originating context and uses `AgentCatalog.preflight` for bounded local preparation/projection. It never constructs ChildSession or executes captured capabilities. Raw instruction, selected skill metadata and ordinary-tool configuration budgets are checked; final native SDK rendering is reported as unchecked `rendered_prompt`. Selected skill bodies are also unchecked, reported as `skill_body_validation` when skills are selected. Fixed code/stage errors and explicit report projection suppress raw exceptions and resolved credentials. Both successful and invalid reports are delivered only after session/branch/cwd/trust revalidation; invalidated contexts return `not_available`.

`AgentCatalog` owns one bounded asynchronous list/preflight task per generation, no execution slot. Both use the same private `perform` lifecycle and reject competing operations. Owner-only catalog diagnostics include the operation kind. Preflight uses mode-sensitive host recapture and combined parent/owner cancellation. It shares validation with execution but never caches an authorization ticket. Concurrent calls return `busy`; output has omission counts. No-ID inspect reports generic catalog health/activity and origin-authorized stage/timing diagnostics, never scan paths or raw errors. Shutdown cancels and awaits pool and catalog drain. Unsafe catalog closure disables later listings and keeps its own completion pending without draining the pool. Existing runs and independent per-run discovery continue; no later caller receives the original caller's error text.

`spawn_agent` always creates a logical agent; `followup_task` starts an idle foreground run over retained native history or returns a usage-free active steering receipt. `close_agent` requires idle or `history_unusable` state and cannot force-release ownership. These tools are model-only and denied to children. Inspection accepts mutually exclusive run/agent/scope selectors and never returns transcripts. All associated controls and UI projections recheck the same parent/workspace and latest input fence. See [continuations](../../README.md#agent-continuations).

No exclusive workspace, background delivery or standalone MCP ownership. See the [architecture overview](../../architecture.html).
