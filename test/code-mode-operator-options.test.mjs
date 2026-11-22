import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as nativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createDeskSession } from "desklatch";
import { parseCodeModeMaxCallsEnvironment } from "desklatch/code-mode";
import { createDeskDshPlugin } from "desklatch/dsh";
import { resolveDshCodeModeOptions } from "../distribution/dsh/plugin.mjs";

const FIXTURE_HOST = "test/fixtures/framework-host.mjs";

function codeModeEnv(overrides = {}) {
  return { ...getDefaultEnvironment(), DESKLATCH_CODE_MODE: "0", ...overrides };
}

async function listMcpTools(args, env) {
  const client = new Client({ name: "code-mode-budget-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/bin/mcp.js", ...args],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close();
  }
}

async function dshRuntime() {
  const ctx = new Context();
  const prompt = ctx.plugin(SystemPrompt, { includeRuntimeContext: false });
  await prompt.await();
  const tools = ctx.plugin(ToolsService);
  await tools.await();
  const executor = ctx.plugin(nativeExecutor);
  await executor.await();
  return { ctx, prompt, tools, executor };
}

function fixtureSession() {
  return createDeskSession({
    capabilities: [{ kind: "click", targets: ["selector"] }],
    async observe() { return { complete: true, controls: [] }; },
    async dispatch() { return { status: "dispatched" }; },
    async close() {},
  });
}

test("operator Code Mode budget parser validates a strict decimal range", () => {
  assert.equal(parseCodeModeMaxCallsEnvironment(undefined), undefined);
  assert.equal(parseCodeModeMaxCallsEnvironment("1"), 1);
  assert.equal(parseCodeModeMaxCallsEnvironment("48"), 48);
  for (const value of ["", "0", "49", "1.5", "1e3", " 16", "+16", "16 "]) {
    assert.throws(() => parseCodeModeMaxCallsEnvironment(value), error => {
      assert.equal(error.code, "invalid_code_mode_max_calls");
      assert.match(error.message, /DESKLATCH_CODE_MODE_MAX_CALLS/u);
      assert.match(error.message, /1 to 48/u);
      return true;
    });
  }
});

test("MCP stdio applies the operator budget only when Code Mode is independently enabled", async () => {
  const disabled = await listMcpTools([FIXTURE_HOST], codeModeEnv({ DESKLATCH_CODE_MODE_MAX_CALLS: "32" }));
  assert.deepEqual(disabled.tools.map(tool => tool.name), ["observe", "act"]);

  const enabled = await listMcpTools(["--code-mode", FIXTURE_HOST], codeModeEnv({ DESKLATCH_CODE_MODE_MAX_CALLS: "32" }));
  const runCode = enabled.tools.find(tool => tool.name === "run_code");
  assert.ok(runCode);
  assert.match(runCode.description, /maxCalls=32 total calls to desk\.observe and desk\.act combined/u);
});

test("enabled MCP rejects an invalid operator budget before opening its host", () => {
  const result = spawnSync(process.execPath, ["dist/bin/mcp.js", "--code-mode", FIXTURE_HOST], {
    cwd: process.cwd(),
    env: codeModeEnv({ DESKLATCH_CODE_MODE_MAX_CALLS: "49" }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /DESKLATCH_CODE_MODE_MAX_CALLS must be a base-10 integer from 1 to 48/u);
});

test("packaged DSH config registers run_code with the configured shared budget", async () => {
  assert.equal(resolveDshCodeModeOptions({ DESKLATCH_CODE_MODE_MAX_CALLS: "32" }), false);
  assert.deepEqual(resolveDshCodeModeOptions({ DESKLATCH_CODE_MODE: "1", DESKLATCH_CODE_MODE_MAX_CALLS: "32" }), { maxCalls: 32 });
  assert.throws(() => resolveDshCodeModeOptions({ DESKLATCH_CODE_MODE: "1", DESKLATCH_CODE_MODE_MAX_CALLS: "49" }), {
    code: "invalid_code_mode_max_calls",
  });

  const runtime = await dshRuntime();
  const session = fixtureSession();
  const fiber = runtime.ctx.plugin(createDeskDshPlugin(async () => session, {
    codeMode: resolveDshCodeModeOptions({ DESKLATCH_CODE_MODE: "1", DESKLATCH_CODE_MODE_MAX_CALLS: "32" }),
  }));
  await fiber.await();
  try {
    const runCode = runtime.ctx.tools.get("desklatch_run_code");
    assert.ok(runCode);
    assert.match(runCode.description, /maxCalls=32 total calls to desk\.observe and desk\.act combined/u);
  } finally {
    await fiber.dispose();
    await runtime.executor.dispose();
    await runtime.tools.dispose();
    await runtime.prompt.dispose();
  }
});
