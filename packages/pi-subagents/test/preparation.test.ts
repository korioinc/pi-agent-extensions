import assert from "node:assert/strict";
import fs, { type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AgentDefinition } from "../src/runtime/agents.ts";
import {
  Preparation,
  PreparationLimitError,
  PreparationSafetyError,
} from "../src/runtime/discovery.ts";
import { LIMITS } from "../src/runtime/limits.ts";
import { resolveSkills } from "../src/runtime/skills.ts";

const preparation = () => new Preparation(new AbortController().signal, Infinity);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-preparation-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "user");
  await fs.mkdir(join(root, "user"), { recursive: true });
  await fs.writeFile(
    join(root, "user", "settings.json"),
    JSON.stringify({ skills: [join(root, "skills")] }),
  );
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function definition(root: string): AgentDefinition {
  return {
    name: "reader",
    description: "Read selected instructions",
    promptMode: "append",
    skills: ["selected"],
    systemPrompt: "",
    filePath: join(root, "reader.md"),
  };
}

async function skill(root: string, name: string, body: string | Buffer) {
  const directory = join(root, "skills", name);
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await fs.writeFile(path, body);
  return path;
}

test("an oversized unselected candidate stops preparation before full content acquisition", async (t) => {
  const root = await fixture(t);
  await skill(
    root,
    "selected",
    "---\nname: selected\ndescription: Selected instructions\n---\nREAD THIS",
  );
  const oversized = await fs.realpath(
    await skill(root, "unrelated", Buffer.alloc(LIMITS.instructionBytes * 2, "x")),
  );
  let acquired = 0;
  let opened: FileHandle | undefined;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === oversized) {
      opened = handle;
      const read = handle.read.bind(handle);
      t.mock.method(
        handle,
        "read",
        async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await read(buffer, offset, length, position);
          acquired += result.bytesRead;
          return result;
        },
      );
    }
    return handle;
  });
  await assert.rejects(
    resolveSkills(definition(root), root, false, preparation()),
    PreparationLimitError,
  );
  assert.equal(acquired, 0, "oversized candidates must fail stat validation before reads");
  assert.ok(opened);
  await assert.rejects(opened.stat(), "the rejected candidate must not retain an open handle");
});

test("no selected skills means no source discovery or content acquisition", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "user", "settings.json"), "INVALID SETTINGS");
  const agent = definition(root);
  agent.skills = [];
  t.mock.method(fs, "open", async () => {
    assert.fail("empty selection must not acquire settings or instructions");
  });
  t.mock.method(fs, "opendir", async () => {
    assert.fail("empty selection must not scan directories");
  });
  await resolveSkills(agent, root, true, preparation());
});

test("changed selected metadata rejects a stale skill selection", async (t) => {
  const root = await fixture(t);
  const path = await fs.realpath(
    await skill(root, "selected", "---\nname: selected\ndescription: Selected\n---\nAUTHORIZED"),
  );
  const owned = preparation();
  const read = owned.readFrontmatter.bind(owned);
  let discovered = false;
  t.mock.method(owned, "readFrontmatter", async (candidate: string) => {
    if (candidate === path && discovered)
      await fs.writeFile(path, "---\nname: replaced\ndescription: Selected\n---\nUNAUTHORIZED");
    const header = await read(candidate);
    if (candidate === path) discovered = true;
    return header;
  });
  await assert.rejects(resolveSkills(definition(root), root, false, owned));
});

test("package manifest exclusions stay effective when child names explicitly select them", async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, "package");
  await fs.mkdir(packageRoot);
  await fs.writeFile(
    join(root, "user", "settings.json"),
    JSON.stringify({ packages: [packageRoot] }),
  );
  await fs.writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      pi: { skills: ["skills", "!skills/blocked"] },
    }),
  );
  await skill(
    packageRoot,
    "blocked",
    "---\nname: selected\ndescription: Blocked\n---\nDO NOT LOAD",
  );
  await assert.rejects(resolveSkills(definition(root), root, false, preparation()));
  await fs.writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      pi: { skills: ["skills", "!skills/blocked", "+skills/blocked"] },
    }),
  );
  await resolveSkills(definition(root), root, false, preparation());
  await fs.writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      pi: { skills: ["skills", "!skills/blocked", "+skills/blocked", "-skills/blocked"] },
    }),
  );
  await assert.rejects(resolveSkills(definition(root), root, false, preparation()));
});

test("manifest overrides cannot introduce undeclared instruction sources", async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, "package");
  await fs.mkdir(join(packageRoot, "private"), { recursive: true });
  await fs.writeFile(
    join(root, "user", "settings.json"),
    JSON.stringify({ packages: [packageRoot] }),
  );
  await fs.writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["skills", "+private"] } }),
  );
  await fs.writeFile(
    join(packageRoot, "private", "SKILL.md"),
    "---\nname: selected\ndescription: Private\n---\nUNDECLARED_INSTRUCTIONS",
  );
  await assert.rejects(resolveSkills(definition(root), root, false, preparation()));
});

test("an expired deadline prevents instruction acquisition", async (t) => {
  const root = await fixture(t);
  const path = join(root, "instructions.md");
  await fs.writeFile(path, "Must not load after expiry");
  const owned = new Preparation(new AbortController().signal, performance.now() - 1);
  await assert.rejects(owned.read(path), PreparationLimitError);
});

test("aggregate acquisition cannot restart its budget for each file", async (t) => {
  const root = await fixture(t);
  const path = join(root, "instructions.md");
  const size = Math.min(LIMITS.instructionBytes, LIMITS.preparationBytes);
  await fs.writeFile(path, Buffer.alloc(size, "x"));
  const owned = preparation();
  for (let bytes = size; bytes <= LIMITS.preparationBytes; bytes += size) await owned.read(path);
  await assert.rejects(owned.read(path), PreparationLimitError);
});

test("skipped entries still consume the shared discovery budget", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "entries");
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, ".ignored"), "");
  const owned = preparation();
  for (let entries = 0; entries < LIMITS.preparationEntries; entries++) {
    for await (const _entry of owned.directory(directory)) {
      /* entry deliberately ignored */
    }
  }
  await assert.rejects(async () => {
    for await (const _entry of owned.directory(directory)) {
      /* entry deliberately ignored */
    }
  }, PreparationLimitError);
});

test("symlink cycles do not exhaust traversal", async (t) => {
  const root = await fixture(t);
  await skill(
    root,
    "selected",
    "---\nname: selected\ndescription: Selected instructions\n---\nCYCLE-SAFE-INSTRUCTION",
  );
  await fs.symlink(join(root, "skills"), join(root, "skills", "loop"), "dir");
  await fs.symlink(join(root, "skills", "selected"), join(root, "skills", "alias"), "dir");
  await resolveSkills(definition(root), root, false, preparation());
});

test("cancelled reads stay owned until their pending read and close both finish", async (t) => {
  const root = await fixture(t);
  const path = join(root, "instructions.md");
  await fs.writeFile(path, "Owned content");
  const reading = gate();
  const readGate = gate();
  const closing = gate();
  const closeGate = gate();
  const open = fs.open;
  let handle: FileHandle | undefined;
  t.after(() => {
    readGate.resolve();
    closeGate.resolve();
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    handle = await open(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(
      handle,
      "read",
      async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        reading.resolve();
        await readGate.promise;
        return read(buffer, offset, length, position);
      },
    );
    t.mock.method(handle, "close", async () => {
      closing.resolve();
      await closeGate.promise;
      await close();
    });
    return handle;
  });
  const controller = new AbortController();
  const pending = new Preparation(controller.signal, Infinity).read(path);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await reading.promise;
  const reason = new Error("Stop requested");
  controller.abort(reason);
  await setImmediate();
  assert.equal(settled, false, "cancellation cannot abandon a pending read");
  readGate.resolve();
  await closing.promise;
  await setImmediate();
  assert.equal(settled, false, "cancellation cannot abandon handle closure");
  closeGate.resolve();
  await assert.rejects(pending, (error) => error === reason);
  assert.ok(handle);
  await assert.rejects(handle.stat());
});

test("a failed close remains unsafe even after enclosing directories close", async (t) => {
  const root = await fixture(t);
  const path = join(root, "instructions.md");
  await fs.writeFile(path, "Owned content");
  const open = fs.open;
  const opendir = fs.opendir;
  let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  let release: (() => Promise<void>) | undefined;
  t.after(async () => {
    await release?.();
  });
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    directory = await opendir(...args);
    return directory;
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    release = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      throw new Error("Injected close failure");
    });
    return handle;
  });
  const owned = preparation();
  const scan = async () => {
    for await (const entry of owned.directory(root)) await owned.read(join(root, entry.name));
  };
  await assert.rejects(scan(), PreparationSafetyError);
  assert.throws(() => owned.check(), PreparationSafetyError);
  assert.ok(directory);
  await assert.rejects(
    directory.read(),
    "enclosing directory must close despite the inner failure",
  );
});
