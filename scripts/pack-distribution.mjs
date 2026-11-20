import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDsh = join(root, "distribution", "dsh");
const sourceWindows = join(root, "distribution", "windows");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const npmScript = process.env.npm_execpath;
const npmNode = process.env.npm_node_execpath || process.execPath;

if (!npmScript) {
  throw new Error("Run this command through npm (for example: npm run pack:install -- <outputDir>).");
}

const args = process.argv.slice(2);
const packOnly = args.includes("--pack-only");
const positional = args.filter((arg) => !arg.startsWith("--"));
const outputDir = resolve(positional[0] || join(root, "distribution", "out"));

function npmEnvironment() {
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

async function runNpm(arguments_, cwd, { offline = false } = {}) {
  const environment = npmEnvironment();
  if (offline) environment.npm_config_offline = "true";
  try {
    return await execFile(npmNode, [npmScript, ...arguments_], {
      cwd,
      env: environment,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(`npm ${arguments_.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}${stdout ? `\n${stdout.trim()}` : ""}`, { cause: error });
  }
}

function parsePackResult(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("npm pack did not return JSON metadata");
  const [result] = JSON.parse(stdout.slice(start, end + 1));
  if (!result?.filename || typeof result.filename !== "string") throw new Error("npm pack metadata has no filename");
  return result;
}

async function packProject(cwd, destination) {
  const { stdout } = await runNpm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", destination,
  ], cwd);
  return parsePackResult(stdout);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyBundleSource(stage) {
  for (const name of ["cordis.patch.yml", "plugin.mjs", "README.md"]) {
    await copyFile(join(sourceDsh, name), join(stage, name));
  }
}

async function copyWindowsSetup(destination) {
  for (const name of ["install.cmd", "install.ps1", "node-runtime.ps1", "python-runtime.ps1", "README.md"]) {
    const source = (await readFile(join(sourceWindows, name), "utf8")).replace(/^\uFEFF/u, "");
    if (name.endsWith(".cmd")) {
      assert.match(source, /^[\u0000-\u007F]*$/u, `${name} must load on cmd.exe without a code-page change`);
    }
    const bom = name.endsWith(".ps1") ? "\uFEFF" : "";
    const target = join(destination, name);
    const expected = bom + source.replace(/\r?\n/g, "\r\n");
    await writeFile(target, expected, "utf8");
    assert.equal(await readFile(target, "utf8"), expected, `could not read back ${name} as UTF-8`);
  }
}

async function installedPackageNames(nodeModules) {
  const names = [];
  const entries = await readdir(nodeModules, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = join(nodeModules, entry.name);
      for (const child of await readdir(scopeDir, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        const packageName = `${entry.name}/${child.name}`;
        try {
          const manifest = JSON.parse(await readFile(join(scopeDir, child.name, "package.json"), "utf8"));
          if (manifest.name === packageName) names.push(packageName);
        } catch {
          // Ignore npm's non-package helper directories.
        }
      }
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(nodeModules, entry.name, "package.json"), "utf8"));
      if (typeof manifest.name === "string") names.push(manifest.name);
    } catch {
      // Ignore npm's non-package helper directories.
    }
  }
  return names.sort();
}

async function packageJsonFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".package-lock.json") continue;
    const current = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await packageJsonFiles(current));
    else if (entry.isFile() && entry.name === "package.json") files.push(current);
  }
  return files;
}

async function assertPortablePackage(stage) {
  const machinePath = /(?:\bfile:|(?:^|[\s"'=([{])(?:[A-Za-z]:[\\/])|(?:^|[\s"'=([{])\/(?:Users|home|tmp|Temp)[\\/])/iu;
  for (const path of await packageJsonFiles(stage)) {
    const text = await readFile(path, "utf8");
    assert.equal(machinePath.test(text), false, `machine-specific dependency reference in ${path}`);
  }
}

async function createDshStage(coreTarball, version) {
  const stage = await mkdtemp(join(process.env.TEMP || process.env.TMP || root, "desklatch-dsh-stage-"));
  try {
    await copyBundleSource(stage);

    const playwrightVersion = rootManifest.devDependencies?.["playwright-core"] || "1.65.1";
    const dependencies = { desklatch: `file:${coreTarball.replaceAll("\\", "/")}`, "playwright-core": playwrightVersion };
    const initialManifest = {
      name: "desklatch-dsh",
      version,
      description: "DeskLatch desktop tools and approval cards for DeepSeek Harness",
      type: "module",
      main: "./plugin.mjs",
      exports: {
        ".": "./plugin.mjs",
        "./plugin": "./plugin.mjs",
        "./package.json": "./package.json",
      },
      files: ["cordis.patch.yml", "plugin.mjs", "README.md"],
      repository: rootManifest.repository,
      homepage: rootManifest.homepage,
      bugs: rootManifest.bugs,
      keywords: ["deepseek-harness", "dsh-plugin", "computer-use", "human-in-the-loop"],
      engines: { ...rootManifest.engines, dsh: rootManifest.devDependencies["@deepseek-ai/dsh-tools"] },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
      dependencies,
      bundleDependencies: [],
    };
    await writeJson(join(stage, "package.json"), initialManifest);

    // The official host provides the Cordis context. The plugin has no DSH
    // runtime imports, so the artifact can load from an isolated profile.
    await runNpm([
      "install", "--legacy-peer-deps", "--ignore-scripts", "--omit=optional", "--no-package-lock", "--no-audit", "--no-fund",
    ], stage);

    const bundled = await installedPackageNames(join(stage, "node_modules"));
    assert.ok(bundled.includes("desklatch"), "the DSH bundle must carry its own DeskLatch runtime");
    assert.ok(bundled.includes("playwright-core"), "the DSH bundle must carry pinned playwright-core");
    assert.equal(bundled.some((name) => name.startsWith("@deepseek-ai/") || name === "@e2b/desktop" || /ocr/iu.test(name)), false,
      "the basic DSH bundle must not duplicate DSH, E2B, or OCR plugins");

    const finalManifest = {
      ...initialManifest,
      dependencies: { desklatch: version, "playwright-core": playwrightVersion },
      bundleDependencies: bundled,
    };
    await writeJson(join(stage, "package.json"), finalManifest);
    await assertPortablePackage(stage);
    return stage;
  } catch (error) {
    await removeOwnedTemp(stage, "desklatch-dsh-stage-");
    throw error;
  }
}

async function installProbe(dshTarball) {
  const tempParent = await realpath(process.env.TEMP || process.env.TMP || root);
  const consumer = await mkdtemp(join(tempParent, "desklatch-dsh-install-"));
  try {
    await writeJson(join(consumer, "package.json"), {
      name: "desklatch-portability-check",
      private: true,
      type: "module",
    });
    const relocatedBundle = join(consumer, "desklatch-dsh.tgz");
    await copyFile(dshTarball, relocatedBundle);
    await runNpm([
      "install", "--offline", "--legacy-peer-deps", "--ignore-scripts", "--omit=optional", "--no-package-lock", "--no-audit", "--no-fund",
      "./desklatch-dsh.tgz",
    ], consumer, { offline: true });
    const probe = `import assert from "node:assert/strict";
const core = await import("desklatch");
assert.equal(typeof core.createDeskSession, "function");
assert.equal(typeof (await import("desklatch/demo")).createDemoDeskSession, "function");
const bundle = await import("desklatch-dsh");
assert.equal(bundle.default?.name, "desklatch-dsh");
assert.equal(typeof bundle.default?.apply, "function");
assert.throws(() => import.meta.resolve("@deepseek-ai/dsh-mcp-client"), { code: "ERR_MODULE_NOT_FOUND" });
assert.throws(() => import.meta.resolve("@e2b/desktop"), { code: "ERR_MODULE_NOT_FOUND" });
console.log("portable dsh bundle imports verified");
`;
    const probePath = join(consumer, "node_modules", "desklatch-dsh", "probe.mjs");
    await writeFile(probePath, probe, "utf8");
    const { stdout } = await execFile(npmNode, [probePath], {
      cwd: consumer,
      env: process.env,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    assert.match(stdout, /portable dsh bundle imports verified/u);
  } finally {
    const resolved = await realpath(consumer);
    if (dirname(resolved) === tempParent && basename(resolved).startsWith("desklatch-dsh-install-")) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

async function removeOwnedTemp(directory, prefix) {
  const parent = await realpath(process.env.TEMP || process.env.TMP || root);
  const resolved = await realpath(directory).catch(() => undefined);
  if (resolved !== undefined && dirname(resolved) === parent && basename(resolved).startsWith(prefix)) {
    await rm(resolved, { recursive: true, force: true });
  }
}

await mkdir(outputDir, { recursive: true });
const core = await packProject(root, outputDir);
let coreTarball;
if (core) {
  coreTarball = join(outputDir, basename(core.filename));
  console.log(`Wrote ${basename(coreTarball)}`);
}

const version = rootManifest.version;
const stage = await createDshStage(coreTarball, version);
try {
  const dsh = await packProject(stage, outputDir);
  const dshTarball = join(outputDir, basename(dsh.filename));
  const expected = join(outputDir, `desklatch-dsh-${version}.tgz`);
  if (dshTarball !== expected) {
    // npm derives this filename from the staging package name. Keep the
    // explicit name check here so a future manifest rename fails loudly.
    throw new Error(`unexpected DSH bundle filename ${basename(dshTarball)}; expected ${basename(expected)}`);
  }
  console.log(`Wrote ${basename(dshTarball)}`);
  if (!packOnly) await installProbe(dshTarball);
  await copyWindowsSetup(outputDir);
  console.log(packOnly ? "Distribution packaging complete." : "Relocatable core and DSH installs verified.");
} finally {
  await removeOwnedTemp(stage, "desklatch-dsh-stage-");
}
