import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityLines, activityStatusText, type ActivityRun } from "./render.ts";

const KEY = "pi-subagents.activity";
const TICK_MS = 250;
type Binding = {
  mode: "tui" | "rpc";
  ui: ExtensionContext["ui"];
  read: () => readonly ActivityRun[];
  requestRender?: () => void;
  mounted: boolean;
  status?: string;
};

/** Presentation owns no execution resources. Every read rechecks the current caller. */
export class ActivityPresenter {
  private binding?: Binding;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private disabled = false;
  private refreshing = false;

  bind(ctx: ExtensionContext, read: () => readonly ActivityRun[], retry = false): void {
    if (this.disposed) return;
    try {
      const mode = ctx.mode === "tui" || ctx.mode === "rpc" ? ctx.mode : undefined;
      if (!mode || !ctx.hasUI) {
        this.clear();
        this.binding = undefined;
        return;
      }
      if (this.disabled && !retry) return;
      if (retry) this.disabled = false;
      if (!this.binding || this.binding.ui !== ctx.ui || this.binding.mode !== mode) {
        this.clear();
        this.binding = { mode, ui: ctx.ui, read, mounted: false };
      } else this.binding.read = read;
      this.refresh();
    } catch {
      this.fail();
    }
  }

  refresh(): void {
    if (this.disposed || this.disabled || this.refreshing || !this.binding) return;
    const binding = this.binding;
    this.refreshing = true;
    try {
      const runs = binding.read();
      if (this.disposed || this.disabled || this.binding !== binding) return;
      if (binding.mode === "rpc") {
        this.stopTimer();
        const next = activityStatusText(runs);
        if (next === binding.status) return;
        if (typeof binding.ui.setStatus !== "function") return;
        binding.status = next;
        binding.ui.setStatus(KEY, next);
        return;
      }
      if (!runs.length) {
        this.clear();
        return;
      }
      if (!binding.mounted) {
        // Mark before registering: a host can invoke the factory synchronously or throw afterward.
        binding.mounted = true;
        binding.ui.setWidget(
          KEY,
          (tui, theme) => {
            binding.requestRender = () => tui.requestRender();
            return {
              render: (width) => {
                if (this.disposed || this.disabled || this.binding !== binding || !binding.mounted)
                  return [];
                try {
                  return activityLines(
                    binding.read(),
                    width,
                    tui.terminal.rows,
                    binding.ui.theme ?? theme,
                  );
                } catch {
                  // Do not mutate the UI inside render. Revoke immediately and clear after it returns.
                  this.disabled = true;
                  queueMicrotask(() => {
                    if (this.binding === binding && this.disabled) this.fail();
                  });
                  return [];
                }
              },
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" },
        );
      }
      binding.requestRender?.();
      if (!runs.some((run) => run.phase !== "terminal")) {
        this.stopTimer();
      } else if (!this.timer) {
        this.timer = setInterval(() => this.refresh(), TICK_MS);
        this.timer.unref();
      }
    } catch {
      this.fail();
    } finally {
      this.refreshing = false;
    }
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private clear(): void {
    this.stopTimer();
    const binding = this.binding;
    if (!binding) return;
    const mounted = binding.mounted;
    const status = binding.status;
    binding.mounted = false;
    binding.status = undefined;
    binding.requestRender = undefined;
    if (mounted) {
      try {
        binding.ui.setWidget(KEY, undefined);
      } catch {
        /* Host UI is unavailable. */
      }
    }
    if (status !== undefined && typeof binding.ui.setStatus === "function") {
      try {
        binding.ui.setStatus(KEY, undefined);
      } catch {
        /* Host UI is unavailable. */
      }
    }
  }

  private fail(): void {
    this.disabled = true;
    this.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.binding = undefined;
  }
}
