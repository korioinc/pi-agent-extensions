import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { Preparation } from "../src/runtime/discovery.ts";
import { loadMcpServers } from "../src/runtime/mcp.ts";

const preparation = () => new Preparation(new AbortController().signal, Infinity);

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-mcp-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const user = join(root, "user");
  await fs.mkdir(user);
  process.env.PI_CODING_AGENT_DIR = user;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, user, config: join(user, "mcp-sub-agents.json") };
}

test("unselected MCP entries cannot evaluate credentials or change stored configuration", async (t) => {
  const { root, config } = await fixture(t);
  const marker = join(root, "unauthorized-write");
  const source = JSON.stringify({
    mcpServers: {
      selected: { command: "unused-executable" },
      unrelated: {
        command: "unused-executable",
        env: { TOKEN: `!touch ${marker}` },
      },
      broken: { url: "invalid", headers: { Authorization: "${}" } },
    },
  });
  await fs.writeFile(config, source);
  await loadMcpServers(["selected"], root, preparation());
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.equal(await fs.readFile(config, "utf8"), source);
});

test("unselected credentials are not required for an authorized server", async (t) => {
  const { root, config } = await fixture(t);
  const variable = "PI_SUBAGENTS_TEST_UNSELECTED_SECRET";
  const previous = process.env[variable];
  delete process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  await fs.writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        selected: { command: "unused-executable" },
        unrelated: { command: "unused-executable", env: { TOKEN: `\${${variable}}` } },
      },
    }),
  );
  await loadMcpServers(["selected"], root, preparation());
});

test("parent and project configurations cannot grant a subagent an MCP capability", async (t) => {
  const { root, user, config } = await fixture(t);
  const inherited = JSON.stringify({
    mcpServers: { privileged: { command: "unused-executable" } },
  });
  await fs.mkdir(join(root, ".pi"));
  await fs.writeFile(join(user, "mcp.json"), inherited);
  await fs.writeFile(join(root, ".pi", "mcp.json"), inherited);
  await fs.writeFile(join(root, ".pi", "mcp-sub-agents.json"), inherited);
  await assert.rejects(loadMcpServers(["privileged"], root, preparation()));
  await fs.writeFile(config, JSON.stringify({ mcpServers: {} }));
  await assert.rejects(loadMcpServers(["privileged"], root, preparation()));
});

test("MCP validation errors do not disclose configuration or resolved credentials", async (t) => {
  const { root, config } = await fixture(t);
  const secret = "test-private-credential-never-in-errors";
  const variable = "PI_SUBAGENTS_TEST_SELECTED_SECRET";
  const previous = process.env[variable];
  process.env[variable] = `${secret}\r\nInjected: value`;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  const sources = [
    `{"mcpServers":{"selected":{bad:"${secret}"}}}`,
    JSON.stringify({ mcpServers: { selected: { url: `https://user:${secret}@example.com/mcp` } } }),
    JSON.stringify({
      mcpServers: {
        selected: { url: "https://example.com/mcp", headers: { Authorization: `\${${variable}}` } },
      },
    }),
  ];
  for (const source of sources) {
    await fs.writeFile(config, source);
    await assert.rejects(loadMcpServers(["selected"], root, preparation()), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        !inspect(error).includes(secret),
        "credential must not escape through error or cause",
      );
      return true;
    });
  }
});
