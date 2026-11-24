import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { agentIdSchema } from "../agent-registry/index.ts";
import { LIMITS } from "../runtime/limits.ts";

const handoff = Type.String({
  minLength: 1,
  maxLength: LIMITS.taskBytes,
  description: "The complete task and context to give the agent. Always a plain string.",
});

export const subagentParameters = Type.Object(
  {
    agent: Type.String({
      minLength: 1,
      maxLength: LIMITS.taskBytes,
      description: "A definition name from list_agents. Creates a new conversation.",
    }),
    handoff,
  },
  { additionalProperties: false },
);

export const followupTaskParameters = Type.Object(
  {
    agentId: agentIdSchema,
    handoff,
  },
  { additionalProperties: false },
);

export function prepareSubagentArguments(args: unknown): Static<typeof subagentParameters> {
  if (!Check(subagentParameters, args))
    throw new Error(
      "subagent creates a new agent. Use only { agent, handoff }; handoff must be a plain string. To continue, use followup_task.",
    );
  return args;
}

/** Follow-up intentionally ignores extra caller fields while strictly validating agentId and handoff. */
export function prepareFollowupArguments(args: unknown): Static<typeof followupTaskParameters> {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    throw new Error("followup_task expects { agentId, handoff }.");
  const input = {
    agentId: "agentId" in args ? args.agentId : undefined,
    handoff: "handoff" in args ? args.handoff : undefined,
  };
  if (!Check(followupTaskParameters, input))
    throw new Error("followup_task needs an agentId and a plain-string handoff.");
  return input;
}
