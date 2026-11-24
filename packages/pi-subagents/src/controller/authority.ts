import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { FastParentSnapshot, ParentAccess, ParentSnapshot } from "../agent-registry/index.ts";
import { createResearchSource } from "../runtime/index.ts";
import { inspectWorkspace, sameWorkspace } from "../workspace/identity.ts";

// Native history is append-only. Reloading the same IDs replaces the leaf object,
// so identity also invalidates ancestry without retaining a second transcript.
const branches = new WeakMap<
  ExtensionContext["sessionManager"],
  {
    sessionId: string;
    anchor: string | null;
    leaf: ReturnType<ExtensionContext["sessionManager"]["getLeafEntry"]>;
    ids: ReadonlySet<string>;
  }
>();

function captureBranch(history: ExtensionContext["sessionManager"]) {
  const sessionId = history.getSessionId();
  const anchor = history.getLeafId();
  const leaf = history.getLeafEntry();
  let branch = branches.get(history);
  if (branch?.sessionId !== sessionId || branch.anchor !== anchor || branch.leaf !== leaf) {
    branch = {
      sessionId,
      anchor,
      leaf,
      ids: new Set(history.getBranch().map((entry) => entry.id)),
    };
    branches.set(history, branch);
  }
  return branch;
}

export function caller(ctx: ExtensionContext): ParentSnapshot | undefined {
  try {
    const rawCwd = ctx.cwd;
    const workspace = inspectWorkspace(rawCwd);
    const branch = captureBranch(ctx.sessionManager);
    return {
      sessionId: branch.sessionId,
      cwd: workspace.root,
      rawCwd,
      workspace,
      branch: branch.ids,
      anchor: branch.anchor,
      trustedProject: ctx.isProjectTrusted(),
    };
  } catch {
    // Disposed SDK contexts and missing workspaces have no usable authority snapshot.
    return undefined;
  }
}

/** Hot-path authority snapshot without synchronous filesystem syscalls. */
export function callerFast(ctx: ExtensionContext): FastParentSnapshot | undefined {
  try {
    const cwd = ctx.cwd;
    const branch = captureBranch(ctx.sessionManager);
    return {
      sessionId: branch.sessionId,
      cwd,
      rawCwd: cwd,
      branch: branch.ids,
      anchor: branch.anchor,
      trustedProject: ctx.isProjectTrusted(),
    };
  } catch {
    return undefined;
  }
}

export function sameOrigin(
  origin: ParentSnapshot,
  current: ParentSnapshot | undefined,
): current is ParentSnapshot {
  return (
    current !== undefined &&
    current.sessionId === origin.sessionId &&
    sameWorkspace(current.workspace, origin.workspace) &&
    current.trustedProject === origin.trustedProject &&
    (origin.anchor === null || current.branch.has(origin.anchor))
  );
}

export function createParentAccess(
  ctx: ExtensionToolContext,
  pi: ExtensionAPI,
  parentPrompt: (ctx: ExtensionToolContext) => string,
): ParentAccess {
  return {
    ...createResearchSource(
      ctx,
      () => pi.getAllTools(),
      parentPrompt,
      () => pi.getSettings(),
    ),
    current: () => caller(ctx),
    currentFast: () => callerFast(ctx),
    fence: (data) => {
      pi.appendEntry("pi-subagent-fence", data);
      const id = ctx.sessionManager.getLeafId();
      const entry = id ? ctx.sessionManager.getEntry(id) : undefined;
      if (
        !entry ||
        entry.type !== "custom" ||
        entry.customType !== "pi-subagent-fence" ||
        JSON.stringify(entry.data) !== JSON.stringify(data)
      )
        throw new Error("Parent acceptance fence is unavailable.");
      return entry.id;
    },
  };
}

export function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
    isError,
  };
}

export function controlResult(
  ctx: ExtensionContext,
  generation: string,
  value: unknown,
  isError = false,
) {
  if (
    value &&
    typeof value === "object" &&
    "rejection" in value &&
    value.rejection === "not_available"
  )
    return toolResult(
      {
        ...value,
        generation: caller(ctx) ? generation : undefined,
        recovery: {
          code: "inspect_current_agents",
          historyLifetime: "generation",
          automaticReplay: false,
          guidance:
            'Inspect subagent_inspect({"scope":"agents"}) once. Histories exist only in the current generation. If the agent is absent, check prior effects and artifacts before explicitly assigning fresh work; never automatically replay the old task.',
        },
      },
      isError,
    );
  return toolResult(value, isError);
}
