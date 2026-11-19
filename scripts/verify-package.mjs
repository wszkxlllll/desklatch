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
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
try {
  const [packed] = JSON.parse(run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", consumer], root));
  assert.equal(basename(packed.filename), packed.filename);
  const files = new Set(packed.files.map(file => file.path));
  for (const path of ["schema/act-input.schema.json", "dist/bin/mcp.js", "dist/reuse.js", "dist/reuse.d.ts", "dist/backends/e2b/chromium_pipe.py",
    "dist/backends/windows/dialog-transport.ps1",
    "dist/evidence/rapidocr_worker.py", "dist/integrations/dsh.js", "dist/integrations/langchain-images.js",
    "docs/architecture.md", "examples/frameworks/langgraph.mjs"]) assert.ok(files.has(path), path);
  await writeFile(join(consumer, "package.json"), '{"name":"independent-host","private":true,"type":"module"}', "utf8");
  run([npm, "install", "--offline", "--omit=optional", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", join(consumer, packed.filename)], consumer);
  const probe = `import assert from 'node:assert/strict';
    import { createDeskSession, createDeskTools } from 'desklatch';
    import { createVerifiedStepReuse } from 'desklatch/reuse';
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
    await session.close();`;
  run(["--input-type=module", "--eval", probe], consumer);
  console.log(`Installed ${packed.name}@${packed.version} from tarball. Independent host verified an action and parameterized replay with zero optional peers.`);
} finally {
  const createdPath = await realpath(consumer);
  if (dirname(createdPath) === tempParent && basename(createdPath).startsWith("desklatch-pack-")) {
    await rm(createdPath, { force: true, recursive: true });
  }
}
