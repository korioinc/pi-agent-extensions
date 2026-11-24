# Controller

`authority.ts` owns live caller snapshots (`caller`), hot-path in-memory snapshots (`callerFast`), shared origin matching (`sameOrigin`), parent access adapters and control replies. `commands.ts` registers `/subagent-runs` and `/subagents`; `sanitize.ts` provides shared terminal/BiDi text cleaning across `browser.ts`, `render.ts`, `commands.ts` and `mentions.ts`.

Caller capture always rechecks workspace identity and project trust. Only native branch ancestry is reused: a weak cache holds one ID set per SessionManager and invalidates on session ID, leaf ID or leaf-object changes. Reloading the same session/leaf IDs still replaces the native leaf object. Cached ancestry is never a fallback for unavailable live authority. Hot-path stream and tool-update checks use `callerFast` to avoid synchronous filesystem syscalls per event, while admission, dispatch, tool boundaries and disclosure keep full workspace verification.

Execution uses a lazy `ResearchSource`: initial preparation reads only its authority scope, then Runtime captures fresh policy and capability catalogs after resolving the requested definition. Model and schema copies are restricted to the selected capabilities. Creating the adapter does not read catalogs, capture prompts or execute tools.

One guarded `caller()` read captures live session, canonical path plus filesystem identity, branch, anchor and trust. Missing or same-path-replaced workspaces and disposed SDK contexts produce no matching snapshot. `ParentAccess.current()` never throws: Registry and direct Pool routes deny unavailable callers, while UI projections suppress stale data. Final rejected delivery still forwards incurred child-model usage. Fence writes, host-policy capture and cleanup remain separately owned operations; their failures are not swallowed by the identity guard.

`parent-prompt.ts` retains the run's native prompt options for structured policy capture. After admission,
append replays the current structured system prompt and verifies it against the effective prompt.
It removes the reserved resource catalogs (`skills`, `tools`, `mcp_servers`) and exact native
delegation rules defined in [`../instructions/parent.ts`](../instructions/parent.ts). It also removes the generated native cwd section only when
`options.sections.cwd === undefined`, preserving explicit custom cwd policy and other sections. No parent
package/extension skill catalog is inherited. Opaque forced prompts, overridden rules while
delegation guidance is active, and relocated owned guidance fail rather than leak instructions
or drop policy. No parent prompt or settings are mutated.

The parent-only `subagent` description, snippet and guidelines live in `instructions/parent.ts`.
`spawn-description.ts` combines that description with the bounded name/description advertisement.
Controller registers the guidance and uses the same guideline definitions for parent-prompt filtering.
Session start/reload and successful guarded catalog listings update the single `subagent` definition through native registration, preserving the active set, execution and exposure. `subagent` is default-active and has no legacy alias. No per-turn scan, extra prompt section or autonomous router is introduced. Advertisements are advisory;
execution prepares again. Catalog failure never publishes partial results. Existing catalog
cancellation, ownership and shutdown drain also cover the initial advertisement.

Loads user capacity and execution limits once before registering tools; creates Pool and the generation-local in-memory AgentRegistry. Registers catalog discovery, explicitly named foreground submission, continuation, close, inspection and cancellation. Spawn, follow-up and close enter AgentRegistry; run inspection and cancellation use Pool directly. Cheap input validation and parent identity capture precede admission. For spawn or idle continuation, Registry reserves the logical admission lane, obtains a Pool run and commits the parent input fence before opening execution. Host-policy capture, selection and preparation follow atomic slot/deadline creation. Safe selection/preparation failures return admitted failed results with `runId`.

Controller passes the validated agent name to AgentRegistry, which supplies `{ agent, agentId }` to Pool. The same name is used for execution and the compatible final field. There is no task title parameter. `/subagent-runs [query]` displays the current owner summary in admission order, filtered by case-insensitive UUID/agent substring. Complete rows share the browser sanitizer and fit the catalog byte allowance with an omission count. The command rechecks session/branch before notifying; no discovery, polling, idle wait or model request. Definition listing and mentions stay unchanged.

`activity.ts` owns the TUI `SubAgents (N)` list under widget key `pi-subagents.activity` (without a TUI footer status) and, in RPC mode (`ctx.mode === "rpc" && ctx.hasUI`), event-driven active-only summaries via `ctx.ui.setStatus("pi-subagents.activity", text)` without a polling timer. It reads `Pool.inspectActivity` for current-owner active and retained terminal summaries with bounded assistant previews, in admission order. One 250ms unref timer runs in TUI mode only while authorized nonterminal runs exist; terminal-only rows remain without polling. Admission, Pool activity transitions, settlement and session/tree events refresh immediately. RPC mode clears `setStatus` as soon as no owned nonterminal runs remain, authority changes, or shutdown starts. Render reauthorizes rather than trusting cached rows. Shutdown revokes rendering before awaiting drain. UI failure disables that attachment without changing execution; only session start or new admission retries it. Other widgets, editor input and the parent working indicator remain untouched.

`render.ts` provides pure bounded Todo-style rows with status glyphs, collision-safe short IDs, live assistant text or cleanup detail and elapsed time when space permits, plus `activityStatusText` for compact single-line RPC status banners. Running rows add `Waiting for tool slot (N)` from `queuedTools` or bounded active tool names from `activeToolNames`. Failed, cancelled and blocked rows show the structured failure code and fixed next-action label; failed rows fall back to stop reason or authorized error when no failure projection exists. Safe terminal failures with `safeguard.stage: "summarized"` show `Incomplete · Summary delivered` in warning style without changing execution outcome or recovery. Activity rows, `/subagent-runs`, RPC status banners and canonical subagent result display use the same status projection. Phase takes precedence over cleanup stage; blocked is never inferred to be complete. The spawn tool uses `renderShell: "self"` with empty call/admitted-result components, eliminating both colored cards and their spacer. Rejections and unknown stored details retain sanitized plain-text feedback. Renderers read no Pool state and add no timer or model request; they use the same failure data exposed in authorized results.

`input.ts` owns two separate flat contracts: `subagent` requires agent/handoff; `followup_task` requires agentId/handoff. All declared fields are required. Creation input remains strict; followup preparation copies only agentId and handoff, ignoring additional fields without interpreting or converting them. Neither tool substitutes aliases for a missing handoff or accepts an object as handoff.

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
parent-model request for active `subagent`. It does not guarantee invocation or fabricate a tool context. Known taskless or newly unavailable names are handled errors; unknown/inline/path mentions are unchanged.

Captures narrow parent model/tool adapters and a retry-only snapshot from `pi.getSettings()`, never conversation entries or credentials. Retry policy is captured in both prompt modes through the existing admitted host capture. Parent prompt capture is mode-aware after definition resolution: append inherits it; replace does not read it, including when an instruction file is configured. Origin authorization is checked again for each capture. Only manually created agent-directory definitions are accepted. Invalid/disabled definitions fail closed without built-in or project fallback.

Updates and inspect expose progress, including `blocked`, without resolving foreground completion. Delivery waits for terminal accounting and safe cleanup, then rechecks origin authorization. Selected ordinary parent tools retain parent permission hooks. Explicit child MCP selection independently authorizes child-local calls; the parent hooks do not apply to those calls.

`AgentCatalog` owns one bounded asynchronous list task per generation, no execution slot. Owner-only catalog diagnostics include the operation kind (`"list"`). Concurrent calls return `busy`; output has omission counts. No-ID inspect reports generic catalog health/activity and origin-authorized stage/timing diagnostics, never scan paths or raw errors. Shutdown cancels and awaits pool and catalog drain. Unsafe catalog closure disables later listings and keeps its own completion pending without draining the pool. Existing runs and independent per-run discovery continue; no later caller receives the original caller's error text.

`subagent({ agent, handoff })` only creates a logical agent. `followup_task({ agentId, handoff })` only enters Registry continuation and retry receipts. Idle agents start a new foreground invocation over retained history; active agents receive native steering and return a receipt. Controller forwards the complete SDK tool call ID as the internal Registry requestId without trimming, parsing, content hashing or random fallback. Redelivery of the same call/agent/text is deduplicated; a new call ID is a new task even when text matches. Additional caller fields cannot override internal request identity. Both controllers retain progress, revocation, usage and safe-settlement handling. IDs remain bounded opaque strings without format regexes. New IDs are generated only by Registry spawn. `close_agent` requires idle or history-unusable state. All three tools are model-only and denied to children.

`subagent_inspect.prepareArguments` accepts only strings, null or undefined as raw ID values before SDK conversion and removes exact empty strings from a copied argument object. SDK validation still owns optional null normalization, object shape, unknown keys and scope values. Whitespace IDs are unchanged. One ID may include its matching scope; two IDs or a mismatched scope return fixed `invalid_input`/`conflicting_selectors` guidance before target lookup. Default inspection still lists runs/generation. Direct and native codemode dispatch use the same path, and no inspection returns transcripts.

For `not_available` control/inspection results, Controller adds fixed `inspect_current_agents` recovery guidance with `historyLifetime: "generation"` and `automaticReplay: false`. It adds the current generation only when caller capture succeeds. Unknown, closed, foreign and previous-generation targets remain indistinguishable; no target metadata is added. Parent guidance directs one current-agent listing and effect/artifact verification before fresh work.

`subagent-result.ts` adds only a display projection to canonical `subagent` details after Registry authorizes progress/final delivery. It reuses `render.ts` lifecycle labels, selected `model` (`provider/id`), and the safely settled run text, never transcripts or TUI previews. Stable step zero keeps one T3 row through partial/final events. Failed/cancelled outcomes map to `error`/`aborted`; blocked work stays unfinished and the original foreground call stays pending. Rejections and continuation receipts have empty results. After a published row loses authority, Registry signals only verified safe settlement; Controller replaces that row with fixed redacted error text, without retaining child identity or model. Incurred usage is preserved. `followup_task` retains the same result projection and updates the RPC `setStatus` banner while active, but T3 renders it only as an ordinary tool row. It does not create a special T3 subagent card. See the [T3 display contract and limitations](../../README.md#t3-code-display).

No exclusive workspace, background delivery or standalone MCP ownership. See the [architecture overview](../../architecture.html).
