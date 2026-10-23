import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  isKeyRelease,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";

function thinkingChoices(model: Model<Api>, explicitMap: boolean) {
  if (!model.reasoning) return [];
  const levels = getSupportedThinkingLevels(model);
  if (!explicitMap || !model.thinkingLevelMap) return levels;
  return levels.filter((level) => typeof model.thinkingLevelMap?.[level] === "string");
}

async function selectItem(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  current?: string,
  query?: string,
  cancelLabel = "cancel",
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const view = new Container();
    const input = query !== undefined ? new Input({ placeholder: "Search models" }) : undefined;
    const details = input ? new Text("", 1, 0) : undefined;
    const showDetails = (item: SelectItem | null) =>
      details?.setText(item ? theme.fg("muted", `${item.label}\n${item.value}`) : "");
    const listView = new Container();
    let list: SelectList;
    let visibleRows = 10;
    function filter(value: string, selectedValue = value ? undefined : current): void {
      const filtered = value
        ? fuzzyFilter(
            items,
            value,
            (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
          )
        : items;
      list = new SelectList(filtered, visibleRows, getSelectListTheme(), {
        truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
      });
      if (selectedValue !== undefined)
        list.setSelectedIndex(
          Math.max(
            0,
            filtered.findIndex((item) => item.value === selectedValue),
          ),
        );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      list.onSelectionChange = showDetails;
      showDetails(list.getSelectedItem());
      listView.clear();
      listView.addChild(list);
    }
    input?.setValue(query ?? "");
    filter(query ?? "");
    view.addChild(new Text(theme.fg("accent", title), 1, 0));
    view.addChild(new Spacer(1));
    if (input) {
      view.addChild(input);
      view.addChild(new Spacer(1));
    }
    view.addChild(listView);
    view.addChild(new Spacer(1));
    if (details) {
      view.addChild(details);
      view.addChild(new Spacer(1));
    }
    view.addChild(new Text(`↑↓ navigate · Enter select · Escape ${cancelLabel}`, 1, 0));
    return {
      get focused() {
        return input?.focused ?? false;
      },
      set focused(value: boolean) {
        if (input) input.focused = value;
      },
      render(width: number) {
        const lines = view.render(width);
        const surroundingRows = lines.length - list.render(width).length;
        // Leave room for Pi's footer and the list's scroll indicator.
        const nextVisibleRows = Math.max(1, Math.min(10, tui.terminal.rows - surroundingRows - 4));
        if (nextVisibleRows === visibleRows) return lines;
        visibleRows = nextVisibleRows;
        filter(input?.getValue() ?? "", list.getSelectedItem()?.value);
        return view.render(width);
      },
      invalidate: () => view.invalidate(),
      handleInput(data: string) {
        const navigation = [
          "tui.select.up",
          "tui.select.down",
          "tui.select.pageUp",
          "tui.select.pageDown",
          "tui.select.confirm",
          "tui.select.cancel",
        ] as const;
        if (navigation.some((key) => keybindings.matches(data, key))) list.handleInput(data);
        else if (input) {
          input.handleInput(data);
          filter(input.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

async function chooseModel(
  ctx: ExtensionContext,
  query: string,
  current: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
  await ctx.modelRegistry.refresh({ allowNetwork: false });
  const available = ctx.modelRegistry.getAvailable();
  const scoped = ctx.scopedModels;
  const models = available.filter(
    (model) =>
      scoped.length === 0 ||
      scoped.some(
        (entry) => entry.model.provider === model.provider && entry.model.id === model.id,
      ),
  );
  const choices = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const selected = await selectItem(
    ctx,
    "Model",
    [...choices].map(([value, model]) => ({ value, label: model.name, description: value })),
    current && `${current.provider}/${current.id}`,
    query,
  );
  return selected === undefined ? undefined : choices.get(selected);
}

export function registerModelPicker(
  pi: ExtensionAPI,
  catalogProviders: ReadonlyMap<string, string>,
  refreshCatalogs: (ctx: ExtensionContext) => Promise<void>,
): void {
  let busy = false;
  let revision = 0;
  let unsubscribe: (() => void) | undefined;

  async function select(
    ctx: ExtensionContext,
    command: string,
    argument: string,
    version: number,
  ): Promise<void> {
    if (command === "model" && argument === "refresh") {
      await refreshCatalogs(ctx);
      return;
    }
    let model = ctx.model;
    while (version === revision) {
      if (command === "model") model = await chooseModel(ctx, argument, model);
      if (!model || version !== revision) return;
      const levels = thinkingChoices(
        model,
        catalogProviders.get(model.provider) === model.api &&
          (model.api === "openai-responses" || model.api === "openai-codex-responses"),
      );
      const level =
        command === "thinking" && argument
          ? argument
          : levels.length > 0
            ? await selectItem(
                ctx,
                `Thinking Level · ${model.id}`,
                levels.map((value) => ({ value, label: value })),
                pi.getThinkingLevel(),
                undefined,
                command === "model" ? "back" : "cancel",
              )
            : undefined;
      if (version !== revision) return;
      if (levels.length > 0 && level === undefined) {
        if (command === "model") continue;
        return;
      }
      const nativeLevel = levels.find((value) => value === level);
      if (level !== undefined && nativeLevel === undefined) {
        ctx.ui.notify("This model does not support that thinking level.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the response to finish, then try again.", "warning");
        return;
      }
      if (!(await pi.setModel(model)) || version !== revision) return;
      if (nativeLevel !== undefined) pi.setThinkingLevel(nativeLevel);
      ctx.ui.notify(`${model.id}${level ? ` · ${level}` : ""}`, "info");
      return;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    revision++;
    busy = false;
    unsubscribe?.();
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: current.triggerCharacters,
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const match =
          lines.length === 1 && cursorCol === line.length
            ? /^[ \t]*\/model[ \t]+(refresh[ \t]*)$/.exec(line)
            : null;
        if (match) {
          return {
            prefix: match[1]!,
            items: [{ value: "refresh", label: "refresh", description: "Refresh model catalogs" }],
          };
        }
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion: (...args) => current.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) =>
        current.shouldTriggerFileCompletion?.(...args) ?? true,
    }));
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || !getKeybindings().matches(data, "tui.input.submit")) return;
      const match = /^\/(model|thinking)(?:[ \t]+([^\r\n]*))?$/.exec(ctx.ui.getEditorText().trim());
      if (!match) return;
      if (busy) {
        ctx.ui.notify("A model operation is already in progress.", "warning");
        return { consume: true };
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the response to finish, then try again.", "warning");
        return { consume: true };
      }
      busy = true;
      const version = revision;
      ctx.ui.setEditorText("");
      void select(ctx, match[1]!, match[2]?.trim() ?? "", version)
        .catch(() => {
          if (version === revision)
            ctx.ui.notify("Could not apply the model settings. Please try again.", "error");
        })
        .finally(() => {
          if (version === revision) busy = false;
        });
      return { consume: true };
    });
  });
  pi.on("session_shutdown", () => {
    revision++;
    unsubscribe?.();
  });
}
