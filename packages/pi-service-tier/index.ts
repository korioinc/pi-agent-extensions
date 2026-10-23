import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyServiceTier, selectServiceTier } from "./service-tier.ts";
import {
  disableAllModes,
  loadSettings,
  setModeEnabled,
  type Mode,
  type Settings,
} from "./settings.ts";

const FAST_LABEL = "⚡ Fast";
const ULTRAFAST_LABEL = "⚡⚡ Ultrafast";

function statusText(settings: Settings, ctx: ExtensionContext): string | undefined {
  const tier = selectServiceTier(settings, ctx.model);
  if (!tier) return undefined;
  const ultrafast = tier === "ultrafast";
  const icon = ctx.ui.theme.fg("warning", ultrafast ? "⚡⚡" : "⚡");
  return `· ${icon} ${ultrafast ? "Ultrafast" : "Fast"}`;
}

export default function serviceTierExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "extensions", "pi-service-tier.json");
  let startupModes: Set<Mode> | undefined;

  pi.registerFlag("fast", {
    description: `Start with ${FAST_LABEL} enabled without saving it`,
    type: "boolean",
  });
  pi.registerFlag("ultrafast", {
    description: `Start with ${ULTRAFAST_LABEL} enabled without saving it`,
    type: "boolean",
  });

  function withStartupModes(settings: Settings): Settings {
    // CLI values are populated after the extension factory has loaded.
    startupModes ??= new Set(
      (["fast", "ultrafast"] as const).filter((mode) => pi.getFlag(mode) === true),
    );
    for (const mode of startupModes) settings[mode].enabled = true;
    return settings;
  }

  function reportError(error: unknown, ctx: ExtensionContext): void {
    const message = `pi-service-tier: ${error instanceof Error ? error.message : String(error)} (${settingsPath})`;
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-service-tier", undefined);
      ctx.ui.notify(message, "error");
    } else {
      console.error(message);
    }
  }

  function refresh(ctx: ExtensionContext): Settings | undefined {
    try {
      const settings = withStartupModes(loadSettings(settingsPath));
      if (ctx.hasUI) ctx.ui.setStatus("pi-service-tier", statusText(settings, ctx));
      return settings;
    } catch (error) {
      reportError(error, ctx);
      return undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    refresh(ctx);
  });

  pi.registerCommand("fast", {
    description: `Toggle ${FAST_LABEL}; /fast ultra toggles ${ULTRAFAST_LABEL}; /fast off disables both`,
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "ultra", label: ULTRAFAST_LABEL, description: "Toggle Ultrafast independently" },
        { value: "off", label: "Off", description: "Disable Fast and Ultrafast" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument !== "" && argument !== "ultra" && argument !== "off") {
        ctx.ui.notify(
          `Usage: /fast (${FAST_LABEL}), /fast ultra (${ULTRAFAST_LABEL}), or /fast off`,
          "warning",
        );
        return;
      }
      try {
        const current = withStartupModes(loadSettings(settingsPath));
        const mode = argument === "ultra" ? "ultrafast" : "fast";
        const saved =
          argument === "off"
            ? disableAllModes(settingsPath)
            : setModeEnabled(settingsPath, mode, !current[mode].enabled);
        if (argument === "off") startupModes?.clear();
        else startupModes?.delete(mode);
        const settings = withStartupModes(saved);
        ctx.ui.setStatus("pi-service-tier", statusText(settings, ctx));
        const fastStatus = `${FAST_LABEL} ${settings.fast.enabled ? "on" : "off"}`;
        const ultrafastStatus = `${ULTRAFAST_LABEL} ${settings.ultrafast.enabled ? "on" : "off"}`;
        ctx.ui.notify(
          argument === "off"
            ? `${fastStatus} · ${ultrafastStatus}`
            : argument === "ultra"
              ? ultrafastStatus
              : fastStatus,
          "info",
        );
      } catch (error) {
        reportError(error, ctx);
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const settings = refresh(ctx);
    if (settings) return applyServiceTier(settings, ctx.model, event.payload);
  });
}
