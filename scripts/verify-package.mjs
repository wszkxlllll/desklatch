import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Install the actual tarball into a fresh consumer with only production dependencies.
const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run through npm run verify:package");
const tempParent = await realpath(tmpdir());
const consumer = await mkdtemp(join(tempParent, "desklatch-pack-"));
const run = (args, cwd, online = false) => {
  const env = { ...process.env, npm_config_offline: online ? "false" : "true" };
  delete env.E2B_API_KEY;
  return execFileSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true, env });
};
try {
  const [packed] = JSON.parse(run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", consumer], root));
  assert.equal(basename(packed.filename), packed.filename);
  const files = new Set(packed.files.map(file => file.path));
  for (const path of ["schema/act-input.schema.json", "dist/bin/mcp.js", "dist/bin/setup.js", "dist/demo.js", "dist/reuse.js", "dist/reuse.d.ts", "dist/backends/e2b/chromium_pipe.py",
    "dist/workspace.js", "dist/workspace.d.ts", "dist/backends/e2b/atspi_worker.py", "dist/backends/e2b/x11-recipient.py",
    "dist/backends/windows/dialog-transport.ps1",
    "dist/evidence/rapidocr_worker.py", "dist/integrations/dsh.js", "dist/integrations/langchain-images.js",
    "docs/architecture.md", "examples/frameworks/langgraph.mjs"]) assert.ok(files.has(path), path);
  await writeFile(join(consumer, "package.json"), '{"name":"independent-host","private":true,"type":"module"}', "utf8");
  run([npm, "install", "--offline", "--omit=optional", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", join(consumer, packed.filename)], consumer);
  const probe = `import assert from 'node:assert/strict';
    import { createDeskSession, createDeskTools } from 'desklatch';
    import { createVerifiedStepReuse } from 'desklatch/reuse';
    import { createWorkspace } from 'desklatch/workspace';
    for (const peer of ['playwright-core', '@langchain/core', '@modelcontextprotocol/sdk', '@openai/agents', '@trycua/cua-driver', '@deepseek-ai/dsh-mcp-client']) {
      assert.throws(() => import.meta.resolve(peer), {code:'ERR_MODULE_NOT_FOUND'});
    }
    const field = { id:'id1', role:'Edit', name:'Title', states:['visible','enabled','editable'], actions:['type'], effect:'edit' };
    let value = '';
    const session = createDeskSession({ capabilities:[{kind:'type',targets:['selector']}],
      async observe() { return {scope:'host',complete:true,controls:[{...field,value}]}; },
      async dispatch(input) { value=input.step.text; return {status:'dispatched'}; }, async close() {} });
    const cache = createVerifiedStepReuse({session});
    const tools = createDeskTools({...session,act:cache.act});
    assert.deepEqual(tools.map(t=>t.name), ['observe','act']);
    const request = {steps:[{kind:'type',target:{name:'Title'},text:'ok',expect:{target:{name:'Title'},valueEquals:'ok'}}]};
    const result = await tools[1].invoke(request);
    assert.equal(result.steps[0].status, 'verified'); assert.equal(value,'ok');
    const scope = {context:{app:'consumer',view:'draft'},coverage:'title field'};
    await cache.remember('draft-title',request,result,{...scope,parameters:[{name:'title',paths:['steps.0.text','steps.0.expect.valueEquals']}]});
    const replay = await cache.run('draft-title',{...scope,values:{title:'revised'}});
    assert.equal(replay.result.steps[0].status,'verified'); assert.equal(value,'revised');
    let selected = false;
    const workspace = createWorkspace({applications:[{id:'editor',name:'Editor',session,
      activate:()=>{selected=true;},verifyFront:()=>selected}]});
    assert.deepEqual(workspace.tools.map(t=>t.name), ['observe','act']);
    assert.equal((await workspace.tools[1].invoke({activate:'editor'})).status,'completed');
    assert.equal((await workspace.tools[0].invoke({where:{name:'Title'}})).controls[0].value,'revised');
    await workspace.close();`;
  run(["--input-type=module", "--eval", probe], consumer);
  console.log(`Installed ${packed.name}@${packed.version} from tarball. Independent host verified field replay and the two workspace tools with zero optional peers.`);

  run([npm, "exec", "--", "desklatch-setup", "mcp", "--install"], consumer);
  const mcpProbe = `import assert from 'node:assert/strict';
    import { access, readFile } from 'node:fs/promises';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    assert.throws(() => import.meta.resolve('@e2b/desktop'), {code:'ERR_MODULE_NOT_FOUND'});
    assert.throws(() => import.meta.resolve('@deepseek-ai/dsh-mcp-client'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(access('.desklatch/ocr'), {code:'ENOENT'});
    const config = JSON.parse(await readFile('desklatch.mcp.json', 'utf8')).mcpServers.desklatch;
    const client = new Client({ name: 'clean-install', version: '1.0.0' });
    await client.connect(new StdioClientTransport(config));
    try {
      const inventory = await client.listTools();
      assert.deepEqual(inventory.tools.map(tool => tool.name).sort(), ['act', 'observe']);
      const receipt = await client.callTool({ name: 'act', arguments: { steps: [{ kind: 'type',
        target: { name: 'Title' }, text: 'Fresh consumer',
        expect: { target: { name: 'Title' }, valueEquals: 'Fresh consumer' },
      }] } });
      assert.equal(JSON.parse(receipt.content[0].text).steps[0].status, 'verified');
    } finally { await client.close(); }`;
  run(["--input-type=module", "--eval", mcpProbe], consumer);
  console.log("The setup-generated MCP configuration opened a browser and verified a field write in the clean consumer.");

  if (process.argv.includes("--with-e2b")) {
    const sampleValue = "setup-validation-only";
    await writeFile(join(consumer, "check.env"), `E2B_API_KEY=${sampleValue}\n`, { encoding: "utf8", mode: 0o600 });
    const installedE2B = run([npm, "exec", "--", "desklatch-setup", "mcp", "--install-e2b"], consumer, true);
    assert.match(installedE2B, /E2B \(E2B_API_KEY_MISSING\)/u);
    const withE2B = run([npm, "exec", "--", "desklatch-setup", "mcp", "--e2b", "--env-file", "check.env"], consumer);
    assert.match(withE2B, /E2B \(ready\)/u);
    assert.ok(!withE2B.includes(sampleValue));
    console.log("Selecting E2B installed the SDK and verified its local credential configuration without a sandbox.");
  }
} finally {
  const createdPath = await realpath(consumer);
  if (dirname(createdPath) === tempParent && basename(createdPath).startsWith("desklatch-pack-")) {
    await rm(createdPath, { force: true, recursive: true });
  }
}
