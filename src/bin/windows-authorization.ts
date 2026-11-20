#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listWindowsAppWindows } from "../product/windows-inventory.js";
import {
  parseWindowsProductGrants,
  readWindowsProductGrants,
  writeWindowsProductGrants,
} from "../product/windows-grants.js";

const exec = promisify(execFile);

async function snapshot(file: string) {
  const [grants, windows] = await Promise.all([readWindowsProductGrants(file), listWindowsAppWindows()]);
  const apps = new Map<string, { id: string; name: string; windows: number }>();
  for (const app of grants.apps) apps.set(app.id, { ...app, windows: 0 });
  for (const window of windows) {
    if (window.ownerHwnd !== undefined) continue;
    const app = apps.get(window.appId);
    if (app) app.windows += 1;
    else apps.set(window.appId, { id: window.appId, name: window.appName, windows: 1 });
  }
  return { grants, applications: [...apps.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new Error("Authorization input too large.");
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function save(file: string) {
  const requested = parseWindowsProductGrants(await readInput());
  const before = await snapshot(file);
  const available = new Map(before.applications.map(app => [app.id, app.name]));
  const apps = requested.apps.map(app => {
    const name = available.get(app.id);
    if (!name) throw new Error("An application is no longer available. Refresh the authorization list.");
    return { id: app.id, name };
  });
  await writeWindowsProductGrants(file, { ...requested, apps });
  return snapshot(file);
}

async function openPage(file: string): Promise<void> {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL("../product/windows-authorization.ps1", import.meta.url));
  const command = [
    '$source = [IO.File]::ReadAllText($env:DESKLATCH_AUTH_PAGE_SCRIPT, [Text.Encoding]::UTF8)',
    '& ([scriptblock]::Create($source)) -NodePath $env:DESKLATCH_AUTH_PAGE_NODE -CliPath $env:DESKLATCH_AUTH_PAGE_CLI -AuthorizationFile $env:DESKLATCH_AUTH_PAGE_FILE',
  ].join("; ");
  await exec(shell, ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    env: {
      ...process.env,
      DESKLATCH_AUTH_PAGE_SCRIPT: script,
      DESKLATCH_AUTH_PAGE_NODE: process.execPath,
      DESKLATCH_AUTH_PAGE_CLI: fileURLToPath(import.meta.url),
      DESKLATCH_AUTH_PAGE_FILE: file,
    },
    windowsHide: false,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
  });
}

async function main(): Promise<void> {
  const [operation, file, extra] = process.argv.slice(2);
  if (process.platform !== "win32" || !file || !isAbsolute(file) || extra !== undefined) throw new Error("Invalid Windows authorization command.");
  if (operation === "--show") return openPage(file);
  const result = operation === "--snapshot" ? await snapshot(file) : operation === "--save" ? await save(file) : undefined;
  if (!result) throw new Error("Invalid Windows authorization command.");
  process.stdout.write(JSON.stringify(result) + "\n", "utf8");
}

main().catch((error: unknown) => {
  // The UI receives a fixed diagnostic rather than the contents of a local file.
  console.error(error instanceof Error && /^(Invalid Windows authorization command\.|Authorization input too large\.|An application is no longer available\.)/u.test(error.message)
    ? error.message : "DeskLatch could not read or update Windows application authorization.");
  process.exitCode = 1;
});
