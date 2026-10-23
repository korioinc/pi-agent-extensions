# Workspace identity

`identity.ts` captures stable workspace identity for parent authorization. Identity combines canonical path, device, inode and creation time, so replacing a directory at the same path revokes retained authority. Capture fails closed unless the filesystem provides a positive inode and verifiable creation time. Equal creation/change times require an ancestor on the same filesystem with distinct times. This synchronous, uncached check rejects libuv's change-time fallback; if no qualifying ancestor exists, capture also fails closed.

Controller captures the current identity with parent session, project trust and branch state. AgentRegistry and Pool use that authority for admission, controls and disclosure. Identity checks remain separate from tool execution and cleanup ownership.

Agents share the workspace. This module provides no read/write lock, revision tracking or quarantine. The SDK's native `write`/`edit` queue serializes same-file operations within its process/module; it does not cover `bash`, MCP or the whole workspace. Unsafe cleanup retains the owning run's Pool slot and shutdown barrier.
