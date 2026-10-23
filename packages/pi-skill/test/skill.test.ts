import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageRenderer,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import piSkill, {
  createSkillAutocompleteProvider,
  expandSkillTokens,
  skillsFromCommands,
  SKILL_MESSAGE_TYPE,
  type SkillRef,
} from "../index.ts";

type InputHandler = (
  event: InputEvent,
  ctx: ExtensionContext,
) => Promise<InputEventResult | undefined>;

let workDir: string;
let notifications: Array<{ message: string; level: string }>;
let sentMessages: Array<{
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}>;
let messageRenderers: Map<string, MessageRenderer>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pi-skill-test-"));
  notifications = [];
  sentMessages = [];
  messageRenderers = new Map();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeSkill(dirName: string, name: string, body: string): Promise<SkillRef> {
  const dir = join(workDir, dirName);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n${body}\n`,
  );
  return { name, filePath, baseDir: dir, description: `Test skill ${name}` };
}

function skillCommand(skill: SkillRef): SlashCommandInfo {
  return {
    name: `skill:${skill.name}`,
    description: `Test skill ${skill.name}`,
    source: "skill",
    sourceInfo: {
      path: skill.filePath,
      source: "test",
      scope: "user",
      origin: "top-level",
      baseDir: skill.baseDir,
    },
  };
}

function createHarness(commands: SlashCommandInfo[]) {
  const handlers = new Map<string, InputHandler[]>();
  const pi = {
    on: (event: string, handler: InputHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getCommands: () => commands,
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
      messageRenderers.set(customType, renderer);
    },
    sendMessage: (
      message: Parameters<ExtensionAPI["sendMessage"]>[0],
      options: Parameters<ExtensionAPI["sendMessage"]>[1],
    ) => {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  piSkill(pi);

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;

  const emit = async (
    text: string,
    streamingBehavior?: InputEvent["streamingBehavior"],
    images?: InputEvent["images"],
  ): Promise<InputEventResult | undefined> => {
    const event: InputEvent = {
      type: "input",
      text,
      source: "interactive",
      streamingBehavior,
      images,
    };
    let result: InputEventResult | undefined;
    for (const handler of handlers.get("input") ?? []) {
      const r = await handler(event, ctx);
      if (r) result = r;
    }
    return result;
  };

  return { emit };
}

describe("skillsFromCommands", () => {
  it("collects skill commands and ignores other sources", async () => {
    const skill = await writeSkill("code-review", "code-review", "Review the code.");
    const commands: SlashCommandInfo[] = [
      skillCommand(skill),
      {
        name: "continue",
        description: "Extension command",
        source: "extension",
        sourceInfo: { path: "/ext/index.ts", source: "test", scope: "user", origin: "top-level" },
      },
      {
        name: "template",
        description: "Prompt template",
        source: "prompt",
        sourceInfo: { path: "/tpl.md", source: "test", scope: "user", origin: "top-level" },
      },
    ];

    const skills = skillsFromCommands(commands);
    assert.equal(skills.size, 1);
    assert.deepEqual(skills.get("code-review"), skill);
  });
});

describe("expandSkillTokens", () => {
  it("expands a leading $skill token", async () => {
    const skill = await writeSkill("code-review", "code-review", "Review the code carefully.");
    const skills = new Map([[skill.name, skill]]);

    const { text, expanded } = await expandSkillTokens("$code-review 最近的改动", skills);

    assert.deepEqual(expanded, ["code-review"]);
    assert.equal(
      text,
      `<skill name="code-review" location="${skill.filePath}">\n` +
        `References are relative to ${skill.baseDir}.\n\n` +
        `Review the code carefully.\n</skill> 最近的改动`,
    );
  });

  it("expands a token mid-sentence", async () => {
    const skill = await writeSkill("reviewer", "code-review", "Do the review.");
    const skills = new Map([[skill.name, skill]]);

    const { text, expanded } = await expandSkillTokens(
      "使用 $code-review 这个 skill review 代码",
      skills,
    );

    assert.deepEqual(expanded, ["code-review"]);
    assert.ok(text?.includes('<skill name="code-review"'));
    assert.match(text, /^使用 <skill[\s\S]+<\/skill> 这个 skill review 代码$/);
  });

  it("expands multiple different skills", async () => {
    const a = await writeSkill("a-skill", "a-skill", "Body A.");
    const b = await writeSkill("b-skill", "b-skill", "Body B.");
    const skills = new Map([
      [a.name, a],
      [b.name, b],
    ]);

    const { text, expanded, blocks } = await expandSkillTokens("先 $a-skill 再 $b-skill", skills);

    assert.deepEqual(expanded, ["a-skill", "b-skill"]);
    assert.deepEqual(
      blocks.map((block) => block.name),
      ["a-skill", "b-skill"],
    );
    assert.ok(text?.includes("Body A."));
    assert.ok(text?.includes("Body B."));
    assert.ok(text.indexOf("Body A.") < text.indexOf("Body B."));
  });

  it("leaves unknown tokens and prices untouched", async () => {
    const skill = await writeSkill("known", "known", "Known.");
    const skills = new Map([[skill.name, skill]]);

    const input = "成本 $9.99，变量 $HOME，未知 $nosuch，已知 $known";
    const { text, expanded } = await expandSkillTokens(input, skills);

    assert.deepEqual(expanded, ["known"]);
    assert.ok(text?.includes("$9.99"));
    assert.ok(text?.includes("$HOME"));
    assert.ok(text?.includes("$nosuch"));
    assert.ok(!text.includes("$known"));
  });

  it("keeps $$name literal as an escape", async () => {
    const skill = await writeSkill("esc", "esc", "Escaped?");
    const skills = new Map([[skill.name, skill]]);

    const { text, expanded } = await expandSkillTokens("字面量 $$esc 不是调用", skills);

    assert.deepEqual(expanded, []);
    assert.equal(text, "字面量 $$esc 不是调用");
  });

  it("does not invoke a loaded prefix of a different identifier or a decimal price", async () => {
    const known = await writeSkill("known", "known", "Known.");
    const numeric = await writeSkill("9", "9", "Numeric skill.");
    const skills = new Map([
      [known.name, known],
      [numeric.name, numeric],
    ]);
    const input = "$known_suffix $knownUPPER $known--other $known- $9.99";

    assert.deepEqual(await expandSkillTokens(input, skills), {
      text: input,
      expanded: [],
      failed: [],
      blocks: [],
    });
    const result = await expandSkillTokens("($known), $known. $9", skills);
    assert.deepEqual(result.expanded, ["known", "9"]);
    assert.equal(result.blocks.length, 2);
  });

  it("reports a missing skill file as failed and leaves the token", async () => {
    const missing: SkillRef = {
      name: "gone",
      filePath: join(workDir, "gone", "SKILL.md"),
      baseDir: join(workDir, "gone"),
    };
    const skills = new Map([[missing.name, missing]]);

    const { text, expanded, failed } = await expandSkillTokens("试试 $gone", skills);

    assert.deepEqual(expanded, []);
    assert.deepEqual(failed, ["gone"]);
    assert.equal(text, "试试 $gone");
  });
});

describe("skill autocomplete provider", () => {
  const fallbackSuggestions: AutocompleteSuggestions = {
    prefix: "x",
    items: [{ value: "x", label: "x" }],
  };

  function fakeCurrent(): AutocompleteProvider {
    return {
      getSuggestions: async () => fallbackSuggestions,
      applyCompletion: () => ({
        lines: ["fallback"],
        cursorLine: 0,
        cursorCol: 8,
      }),
    };
  }

  function skillMap(...names: string[]): Map<string, SkillRef> {
    return new Map(
      names.map((name) => [
        name,
        {
          name,
          filePath: `/skills/${name}/SKILL.md`,
          baseDir: `/skills/${name}`,
          description: `Test skill ${name}`,
        },
      ]),
    );
  }

  const signal = new AbortController().signal;

  it("suggests all skills right after `$`", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () =>
      skillMap("code-review", "tdd"),
    );
    const result = await provider.getSuggestions(["使用 $"], 0, 4, { signal });
    assert.equal(result?.prefix, "$");
    assert.deepEqual(result?.items.map((i) => i.value).sort(), ["$code-review", "$tdd"]);
    assert.ok(result?.items[0]?.description?.includes("Test skill"));
  });

  it("filters by typed prefix", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () =>
      skillMap("code-review", "tdd", "codebase-design"),
    );
    const result = await provider.getSuggestions(["$code"], 0, 5, { signal });
    assert.equal(result?.prefix, "$code");
    assert.deepEqual(result?.items.map((i) => i.value).sort(), [
      "$code-review",
      "$codebase-design",
    ]);
  });

  it("delegates when there is no `$` token or no match", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => skillMap("code-review"));
    // No $ at all
    assert.equal(await provider.getSuggestions(["hello"], 0, 5, { signal }), fallbackSuggestions);
    // $HOME style: not a skill name char after $ → pattern still matches "HOME"? No: [a-z0-9-] excludes uppercase.
    assert.equal(
      await provider.getSuggestions(["echo $HO"], 0, 8, { signal }),
      fallbackSuggestions,
    );
    // Unknown skill name → no items → fallback
    assert.equal(await provider.getSuggestions(["$zz"], 0, 3, { signal }), fallbackSuggestions);
  });

  it("does not complete `$$name` escape", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => skillMap("code-review"));
    assert.equal(await provider.getSuggestions(["$$code"], 0, 6, { signal }), fallbackSuggestions);
    assert.equal(await provider.getSuggestions(["a $$"], 0, 4, { signal }), fallbackSuggestions);
  });

  it("delegates when no skills are loaded", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => new Map());
    assert.equal(await provider.getSuggestions(["$code"], 0, 5, { signal }), fallbackSuggestions);
  });

  it("replaces the $ prefix without adding a second space", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => skillMap("code-review"));
    const lines = ["请用 $cod 检查"];
    const suggestions = await provider.getSuggestions(lines, 0, "请用 $cod".length, { signal });
    const result = provider.applyCompletion(
      lines,
      0,
      "请用 $cod".length,
      suggestions!.items[0]!,
      "$cod",
    );
    assert.equal(result.lines[0], "请用 $code-review 检查");
    assert.equal(result.cursorCol, "请用 ".length + "$code-review".length);
  });

  it("adds a trailing space when the cursor is at end of line", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => skillMap("code-review"));
    const lines = ["$cod"];
    const suggestions = await provider.getSuggestions(lines, 0, 4, { signal });
    const result = provider.applyCompletion(lines, 0, 4, suggestions!.items[0]!, "$cod");
    assert.equal(result.lines[0], "$code-review ");
    assert.equal(result.cursorCol, "$code-review".length + 1);
  });

  it("delegates applyCompletion for non-$ prefixes", async () => {
    const provider = createSkillAutocompleteProvider(fakeCurrent(), () => new Map());
    const result = provider.applyCompletion(
      ["/skil"],
      0,
      5,
      { value: "skill:x", label: "skill:x" },
      "/skil",
    );
    assert.equal(result.lines[0], "fallback");
  });

  it("delegates completion of dollar-prefixed files returned by the wrapped provider", async () => {
    const directory = { value: "$folder/", label: "$folder/" };
    const current = fakeCurrent();
    current.getSuggestions = async () => ({ prefix: "$fo", items: [directory] });
    const provider = createSkillAutocompleteProvider(current, () => skillMap("code-review"));
    const suggestions = await provider.getSuggestions(["$fo"], 0, 3, { signal });
    const result = provider.applyCompletion(
      ["$fo"],
      0,
      3,
      suggestions!.items[0]!,
      suggestions!.prefix,
    );
    assert.equal(result.lines[0], "fallback");
  });
});

describe("input handler", () => {
  it("injects a known skill as its own context message", async () => {
    const skill = await writeSkill("code-review", "code-review", "Review it.");
    const { emit } = createHarness([skillCommand(skill)]);

    const result = await emit("使用 $code-review 这个 skill review 代码");

    assert.deepEqual(result, { action: "continue" });
    assert.equal(sentMessages.length, 1);
    assert.ok(typeof sentMessages[0]?.message.content === "string");
    assert.partialDeepStrictEqual(sentMessages[0]?.message, {
      customType: SKILL_MESSAGE_TYPE,
      display: true,
      details: { name: "code-review" },
    });
    assert.ok(
      sentMessages[0]?.message.content?.includes(
        `<skill name="code-review" location="${skill.filePath}">`,
      ),
    );
    assert.ok(sentMessages[0]?.message.content?.includes("Review it."));
    assert.equal(sentMessages[0]?.options, undefined);
    assert.deepEqual(notifications, []);
  });

  it("injects one message per distinct skill in first-reference order", async () => {
    const a = await writeSkill("a-skill", "a-skill", "Body A.");
    const b = await writeSkill("b-skill", "b-skill", "Body B.");
    const { emit } = createHarness([skillCommand(a), skillCommand(b)]);

    await emit("先 $a-skill，再 $b-skill，最后仍用 $a-skill");

    assert.deepEqual(
      sentMessages.map(({ message }) => message.details),
      [{ name: "a-skill" }, { name: "b-skill" }],
    );
  });

  for (const mode of ["steer", "followUp"] as const) {
    it(`keeps skill instructions and the task in one ${mode} input`, async () => {
      const a = await writeSkill("a-skill", "a-skill", "Body A.");
      const b = await writeSkill("b-skill", "b-skill", "Body B.");
      const { emit } = createHarness([skillCommand(a), skillCommand(b)]);
      const prompt = "Use $a-skill and $b-skill to review this change with $a-skill.";
      const images: InputEvent["images"] = [
        { type: "image", data: "fixture", mimeType: "image/png" },
      ];

      const result = await emit(prompt, mode, images);

      assert.equal(result?.action, "transform");
      assert.ok(result?.action === "transform");
      assert.equal(
        result.text,
        `<skill name="a-skill" location="${a.filePath}">\nReferences are relative to ${a.baseDir}.\n\nBody A.\n</skill>\n\n` +
          `<skill name="b-skill" location="${b.filePath}">\nReferences are relative to ${b.baseDir}.\n\nBody B.\n</skill>\n\n${prompt}`,
      );
      assert.deepEqual(sentMessages, []);
      assert.deepEqual(result.images, images);
    });

    it(`preserves native slash expansion for ${mode} input and warns about mixed references`, async () => {
      const known = await writeSkill("known", "known", "Known.");
      const { emit } = createHarness([skillCommand(known)]);
      for (const prompt of ["/skill:other with $known", "/template $known"]) {
        assert.deepEqual(await emit(prompt, mode), { action: "continue" });
      }
      assert.deepEqual(sentMessages, []);
      assert.equal(notifications.length, 2);
      for (const notification of notifications) {
        assert.equal(notification.level, "warning");
        assert.match(notification.message, /slash commands/);
      }
    });
  }

  it("registers a renderer for standalone skill messages", () => {
    createHarness([]);
    assert.equal(messageRenderers.has(SKILL_MESSAGE_TYPE), true);
  });

  it("renders native skill blocks using the configured output padding", async () => {
    initTheme("dark", false);
    const skill = await writeSkill("known", "known", "Known instructions.");
    const { emit } = createHarness([skillCommand(skill)]);
    await emit("$known");
    const renderer = messageRenderers.get(SKILL_MESSAGE_TYPE)!;
    const message = { ...sentMessages[0]!.message, role: "custom" as const, timestamp: 0 };
    const component = new CustomMessageComponent(message, renderer);
    for (const outputPad of [0, 3]) {
      component.setOutputPad(outputPad);
      const label = component
        .render(80)
        .map(stripVTControlCharacters)
        .find((line) => line.includes("[skill]"));
      assert.ok(label?.startsWith(`${" ".repeat(outputPad)}[skill] known`));
    }
    component.setExpanded(true);
    assert.ok(
      component
        .render(80)
        .map(stripVTControlCharacters)
        .some((line) => line.includes("Known instructions.")),
    );
  });

  it("passes through input without $ or without matching skills", async () => {
    const skill = await writeSkill("known", "known", "Known.");
    const { emit } = createHarness([skillCommand(skill)]);

    assert.equal(await emit("普通消息"), undefined);
    assert.equal(await emit("价格是 $100"), undefined);
    assert.deepEqual(sentMessages, []);
    assert.deepEqual(notifications, []);
  });

  it("does nothing when no skills are loaded", async () => {
    const { emit } = createHarness([]);
    assert.equal(await emit("$code-review 一下"), undefined);
    assert.deepEqual(sentMessages, []);
  });
});
