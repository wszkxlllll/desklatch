#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { findChromiumExecutable } from "../backends/browser/local.js";
import { installOcrSetup } from "../setup/install-ocr.js";
import { checkOptionalSetup } from "../setup/optional.js";

const usage = `DeskLatch setup
  desklatch-setup                         Choose a route and optional features
  desklatch-setup mcp [--install] [--output desklatch.mcp.json]
  desklatch-setup dsh --bundle /path/to/desklatch-dsh.tgz
  Optional E2B: --e2b to check, --install-e2b to install, --env-file to read your existing key.
  Optional OCR: --ocr /path/to/ocr.json to check, --install-ocr to install locally.
  Run from the folder where you installed the DeskLatch tarball.`;

type Route = "mcp" | "dsh";
type OcrOptions = NonNullable<Parameters<typeof checkOptionalSetup>[0]["ocr"]>;
type ExtraChoice = "install" | "existing" | "skip";

function chooseRoute(route: string): Route {
  if (route === "mcp" || route === "dsh") return route;
  throw new Error("Choose mcp or dsh as the installation route.");
}

function enabled(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function chooseExtra(answer: string): ExtraChoice {
  const choice = answer.trim().toLowerCase();
  if (choice === "" || choice === "skip") return "skip";
  if (choice === "existing" || choice === "install") return choice;
  throw new Error("Choose install, existing, or skip for the optional feature.");
}

function moduleInstalled(name: string): boolean {
  try {
    createRequire(import.meta.url).resolve(name);
    return true;
  } catch {
    return false;
  }
}

async function writeMcpConfig(output: string) {
  const config = { mcpServers: { desklatch: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp.js", import.meta.url)), "--demo"],
  } } };
  const text = JSON.stringify(config, null, 2) + "\n";
  try {
    await writeFile(output, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(output, "utf8") !== text) throw error;
  }
  console.log(`MCP configuration is ready at ${output}. Add its desklatch server entry to your client's MCP settings.`);
}

async function readOcrConfig(path: string): Promise<OcrOptions> {
  const source = await readFile(resolve(path), "utf8");
  try {
    const config: unknown = JSON.parse(source);
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return config as OcrOptions;
  } catch {
    throw new Error("OCR configuration must be a JSON object with Python and local model paths.");
  }
}

async function main() {
  const parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" },
    install: { type: "boolean" },
    output: { type: "string" },
    bundle: { type: "string" },
    e2b: { type: "boolean" },
    "install-e2b": { type: "boolean" },
    "env-file": { type: "string" },
    ocr: { type: "string" },
    "install-ocr": { type: "boolean" },
    python: { type: "string" },
  } });
  if (parsed.values.help) { console.log(usage); return; }
  if (parsed.positionals.length > 1) throw new Error(usage);
  const interactive = parsed.positionals.length === 0 && stdin.isTTY;
  if (parsed.positionals.length === 0 && !interactive) throw new Error(usage);

  let route: Route;
  let bundle = parsed.values.bundle;
  let install = parsed.values.install ?? false;
  let installE2b = parsed.values["install-e2b"] ?? false;
  let e2b = installE2b || parsed.values.e2b === true;
  let envFile = parsed.values["env-file"];
  let installOcr = parsed.values["install-ocr"] ?? false;
  let pythonExecutable = parsed.values.python;
  if (installOcr && parsed.values.ocr) throw new Error("Choose either --install-ocr or --ocr.");
  let ocr = parsed.values.ocr ? await readOcrConfig(parsed.values.ocr) : undefined;
  if (interactive) {
    const input = createInterface({ input: stdin, output: stdout });
    try {
      console.log("Choose dsh for the native DSH bundle and its approval cards, or mcp for other MCP clients.");
      route = chooseRoute((await input.question("Connection method [dsh/mcp] ")).trim().toLowerCase());
      if (route === "dsh" && !bundle) bundle = (await input.question("Path to the desklatch-dsh .tgz bundle ")).trim();
      if (!e2b) {
        const choice = chooseExtra(await input.question("E2B Desktop [install/existing/skip, default skip] "));
        e2b = choice !== "skip";
        installE2b = choice === "install";
      }
      if (e2b && !envFile && !process.env.E2B_API_KEY?.trim()) {
        console.log("Get your key from the E2B dashboard. Use a private .env file with E2B_API_KEY, or configure the process environment later.");
        envFile = (await input.question("Path to existing E2B .env file [Enter to configure later] ")).trim() || undefined;
      }
      if (!ocr && !installOcr) {
        const choice = chooseExtra(await input.question("Local OCR [install/existing/skip, default skip] "));
        installOcr = choice === "install";
        if (choice === "existing") {
          const defaultConfig = ".desklatch/ocr/ocr.json";
          const config = (await input.question("Existing OCR JSON file [Enter to use the project config or enter paths] ")).trim();
          ocr = config || existsSync(defaultConfig) ? await readOcrConfig(config || defaultConfig) : {
            pythonExecutable: (await input.question("Python executable or virtual environment Python ")).trim(),
            detectorModelPath: resolve((await input.question("Detection ONNX file ")).trim()),
            recognizerModelPath: resolve((await input.question("Recognition ONNX file ")).trim()),
            dictionaryPath: resolve((await input.question("Recognition dictionary file ")).trim()),
          };
        }
      }
      if (installOcr && !pythonExecutable) {
        pythonExecutable = (await input.question("Python executable [automatic discovery] ")).trim() || undefined;
      }
      if (!install && route === "mcp") {
        install = enabled(await input.question("Install the MCP and browser packages in this folder [y/N] "));
      }
    } finally { input.close(); }
  } else {
    route = chooseRoute(parsed.positionals[0]!);
  }

  const packages: [string, string, boolean][] = [];
  if (route === "mcp") packages.push(["@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk@1.32.2", install],
    ["playwright-core", "playwright-core@1.65.1", install]);
  if (installE2b) packages.push(["@e2b/desktop", "@e2b/desktop@2.5.0", true]);
  const selectedInstalls = packages.filter(([, , shouldInstall]) => shouldInstall).map(([, spec]) => spec);
  if (selectedInstalls.length) {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run via npm exec -- desklatch-setup to install the selected packages.");
    const installEnvironment = { ...process.env };
    delete installEnvironment.E2B_API_KEY;
    execFileSync(process.execPath, [npm, "install", "--save-exact", "--no-audit", "--no-fund", ...selectedInstalls], {
      cwd: process.cwd(), stdio: "inherit", windowsHide: true, env: installEnvironment,
    });
  }
  const remaining = packages.filter(([name, , shouldInstall]) => !shouldInstall && !moduleInstalled(name)).map(([, spec]) => spec);
  if (remaining.length) {
    console.log(`Install the selected packages here with npm install ${remaining.join(" ")}`);
    process.exitCode = 1;
  }

  if (route === "mcp") {
    await writeMcpConfig(resolve(parsed.values.output ?? "desklatch.mcp.json"));
    if (moduleInstalled("playwright-core")) {
      const { chromium } = await import("playwright-core");
      if (!findChromiumExecutable() && !existsSync(chromium.executablePath())) {
        console.log("Install Chrome or Edge, or run npm exec -- playwright-core install chromium.");
        process.exitCode = 1;
      }
    }
  } else {
    if (!bundle) throw new Error("Pass --bundle with the path to the desklatch-dsh tarball.");
    const path = resolve(bundle);
    if (!path.endsWith(".tgz") || !(await stat(path).catch(() => undefined))?.isFile()) {
      throw new Error("Choose an existing desklatch-dsh .tgz file.");
    }
    console.log(`DSH plugin bundle ${path}`);
    console.log("Use the official DSH plugin installer for the chosen profile. The desktop profile uses dsh plugin --profile desktop add with the bundle path after quitting DSH.");
  }
  if (installOcr) {
    console.log("Preparing a project-local OCR environment and verifying the selected model files.");
    ocr = await installOcrSetup({ rootDirectory: process.cwd(), pythonExecutable });
    console.log(`OCR configuration was saved at ${resolve(".desklatch/ocr/ocr.json")}.`);
  }
  if (e2b && envFile) process.loadEnvFile(resolve(envFile));
  if (e2b || ocr) {
    const optional = await checkOptionalSetup({ rootDirectory: process.cwd(), e2b, ocr });
    for (const report of Object.values(optional.reports)) {
      console.log(`${report.module.toUpperCase()} (${report.code}) ${report.message}`);
      console.log(report.guidance);
    }
    const failed = Object.values(optional.reports).some((report) => !report.available
      && !(installE2b && report.code === "E2B_API_KEY_MISSING"));
    if (failed) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "DeskLatch setup failed.");
  process.exitCode = 1;
});
