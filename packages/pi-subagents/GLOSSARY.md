# Subagents

Terms for delegated work, retained evidence, and continuation within a parent conversation.

## Language

**Logical agent**: A delegated conversation whose identity and history can survive multiple invocations until it is closed.
_Avoid_: Run, worker process

**Invocation**: One admitted execution of a logical agent with its own work limits and resource lifetime. Steering adds input to the current invocation; continuing an idle agent starts another invocation.
_Avoid_: Conversation

**Child tools**: The capabilities selected for one invocation, including delegated ordinary tools and tools from explicitly selected MCP servers. They exclude unselected parent capabilities.
_Avoid_: Parent tool catalog

**Response evidence**: Assistant text retained for the parent together with its completion or failure information. Useful evidence can survive an incomplete invocation; it is distinct from the full conversation history and incurred usage.
_Avoid_: Transcript

**Safeguard handoff**: A final, tool-free summary of existing evidence after a supported work limit is reached. It does not restart the task or turn incomplete work into success.
_Avoid_: Retry, continuation
