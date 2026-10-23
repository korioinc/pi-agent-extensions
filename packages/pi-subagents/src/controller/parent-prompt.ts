import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { SPAWN_GUIDELINES } from "../instructions/parent.ts";

/** Keep provenance, not a second copy of the parent's rendered resource catalogs. */
export function registerParentPrompt(pi: ExtensionAPI) {
  let captured: { sessionId: string; options: NormalizedBuildSystemPromptOptions } | undefined;
  pi.on("before_agent_start", (event, ctx) => {
    // Later handlers mutate this same object. Capture its final values only at admission.
    captured = { sessionId: ctx.sessionManager.getSessionId(), options: event.systemPromptOptions };
  });
  pi.on("session_start", () => {
    captured = undefined;
  });
  pi.on("session_shutdown", () => {
    captured = undefined;
  });

  return (ctx: ExtensionToolContext): string => {
    if (!captured || captured.sessionId !== ctx.sessionManager.getSessionId())
      throw new Error(
        "Parent prompt provenance is unavailable. Submit a new prompt before delegating.",
      );
    const { options } = captured;
    const current = getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages);
    if (
      options.forceSystemPrompt !== undefined ||
      !current?.sections ||
      getSystemMessageText(current) !== ctx.getSystemPrompt()
    )
      throw new Error(
        "Cannot isolate an opaque or changed parent prompt. Use structured systemPromptOptions in prompt extensions, or an explicit replace agent (optionally with prompt_instruction_path).",
      );
    // These named sections advertise runtime resources, including compressed catalogs from
    // pi-cache-optimizer. Policy belongs in rules/context/addendum or a separate section.
    const sections = { ...current.sections };
    delete sections.skills;
    delete sections.mcp_servers;
    // The child owns tool declarations too; keep policy/rules/context and all other sections.
    delete sections.tools;
    // The child SDK supplies its own cwd; preserve any explicit parent override as policy.
    if (options.sections.cwd === undefined) delete sections.cwd;
    // SDK 1.3 exposes rendered sections, but not its prompt builder as a public API.
    // Remove only our exact native rule entries; never rebuild or discard user rules.
    const ownedRules = new Set(SPAWN_GUIDELINES.map((rule) => `- ${rule}`));
    if (sections.rules) {
      if (
        options.sections.rules !== undefined &&
        !options.customPrompt &&
        options.selectedTools.includes("spawn_agent") &&
        !options.hiddenTools.includes("spawn_agent")
      )
        throw new Error(
          "Cannot isolate subagent delegation guidance in overridden rules. Preserve native tool guidelines or use an explicit replace agent.",
        );
      sections.rules = sections.rules
        .split("\n")
        .filter((line) => !ownedRules.has(line))
        .join("\n");
    }
    if (
      Object.values(sections).some(
        (text) => typeof text === "string" && SPAWN_GUIDELINES.some((rule) => text.includes(rule)),
      )
    )
      throw new Error(
        "Cannot isolate relocated subagent delegation guidance. Keep it in native tool guidelines or use an explicit replace agent.",
      );
    return getSystemMessageText({ ...current, sections });
  };
}
