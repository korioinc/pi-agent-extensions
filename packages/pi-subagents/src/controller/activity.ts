import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityLines, type ActivityRun } from "./render.ts";

const KEY = "pi-subagents.activity";
const TICK_MS = 250;
type Binding = {
  ui: ExtensionContext["ui"];
  read: () => readonly ActivityRun[];
  requestRender?: () => void;
  mounted: boolean;
};

/** Presentation owns no execution resources. Every read rechecks the current caller. */
export class ActivityPresenter {
  private binding?: Binding;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private disabled = false;

  bind(ctx: ExtensionContext, read: () => readonly ActivityRun[], retry = false): void {
    if (this.disposed) return;
    try {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        this.clear();
        this.binding = undefined;
        return;
      }
      if (this.disabled && !retry) return;
      if (retry) this.disabled = false;
      if (!this.binding || this.binding.ui !== ctx.ui) {
        this.clear();
        this.binding = { ui: ctx.ui, read, mounted: false };
      } else this.binding.read = read;
      this.refresh();
    } catch {
      this.fail();
    }
  }

  refresh(): void {
    if (this.disposed || this.disabled || !this.binding) return;
    const binding = this.binding;
    try {
      const runs = binding.read();
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
    binding.mounted = false;
    binding.requestRender = undefined;
    if (mounted) {
      try {
        binding.ui.setWidget(KEY, undefined);
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
