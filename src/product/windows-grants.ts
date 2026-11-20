import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

export interface WindowsProductAppGrant {
  readonly id: string;
  readonly name: string;
}

export interface WindowsProductGrants {
  readonly version: 1;
  readonly apps: readonly WindowsProductAppGrant[];
  readonly allowForegroundInput: boolean;
  readonly allowDesktopCapture: boolean;
  /** Permit OCR from the exact authorized window without delivering pixels to the model. */
  readonly allowLocalWindowEvidence?: boolean;
}

export const emptyWindowsProductGrants: WindowsProductGrants = Object.freeze({
  version: 1,
  apps: Object.freeze([]),
  allowForegroundInput: false,
  allowDesktopCapture: false,
});

const exec = promisify(execFile);
const registryKey = "HKCU:\\Software\\DeskLatch";
const registryValue = "AuthorizationFile";

export function windowsProductGrantsFile(installRoot: string): string {
  return assertAbsolutePath(join(installRoot, ".desklatch", "windows", "grants.json"));
}

function assertAbsolutePath(file: string): string {
  if (!file || !isAbsolute(file) || /[\u0000\r\n]/u.test(file)) throw new Error("windows_authorization_path_invalid");
  return normalize(file);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseWindowsProductGrants(value: unknown): WindowsProductGrants {
  const data = asRecord(value);
  if (data?.version !== 1 || !Array.isArray(data.apps) ||
      typeof data.allowForegroundInput !== "boolean" || typeof data.allowDesktopCapture !== "boolean" ||
      (data.allowLocalWindowEvidence !== undefined && typeof data.allowLocalWindowEvidence !== "boolean")) {
    throw new Error("windows_authorization_invalid");
  }
  const apps = new Map<string, WindowsProductAppGrant>();
  for (const item of data.apps as unknown[]) {
    const app = asRecord(item);
    if (typeof app?.id !== "string" || !/^app-[a-f0-9]{24}$/u.test(app.id) ||
        typeof app.name !== "string" || !app.name.trim() || app.name.length > 256 ||
        /[\u0000-\u001f]/u.test(app.name) || apps.has(app.id)) {
      throw new Error("windows_authorization_app_invalid");
    }
    apps.set(app.id, Object.freeze({ id: app.id, name: app.name.trim() }));
  }
  return Object.freeze({
    version: 1,
    apps: Object.freeze([...apps.values()]),
    allowForegroundInput: data.allowForegroundInput,
    allowDesktopCapture: data.allowDesktopCapture,
    ...(data.allowLocalWindowEvidence === undefined ? {} : { allowLocalWindowEvidence: data.allowLocalWindowEvidence }),
  });
}

export async function readWindowsProductGrants(file: string): Promise<WindowsProductGrants> {
  try {
    return parseWindowsProductGrants(JSON.parse(await readFile(assertAbsolutePath(file), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWindowsProductGrants;
    throw error;
  }
}

export async function writeWindowsProductGrants(file: string, grants: WindowsProductGrants): Promise<void> {
  const path = assertAbsolutePath(file);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, "grants-" + randomUUID() + ".tmp");
  try {
    const serialized = JSON.stringify(parseWindowsProductGrants(grants), null, 2) + "\n";
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (await readFile(temporary, "utf8") !== serialized) throw new Error("windows_authorization_write_failed");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function productPowerShell(script: string, input?: string) {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from('$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + script, "utf16le").toString("base64");
  return exec(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    env: { ...process.env, DESKLATCH_WINDOWS_PRODUCT_ARGUMENT: input ?? "" },
    windowsHide: true, encoding: "utf8", timeout: 8000, maxBuffer: 128 * 1024,
  });
}

/** Everything beyond the current-user registry pointer lives in the chosen installation directory. */
export async function registerWindowsAuthorizationPath(file: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("windows_authorization_unavailable");
  const path = assertAbsolutePath(file);
  await productPowerShell(
    `New-Item -Path '${registryKey}' -Force | Out-Null; Set-ItemProperty -LiteralPath '${registryKey}' -Name '${registryValue}' -Value $env:DESKLATCH_WINDOWS_PRODUCT_ARGUMENT`,
    path,
  );
}

export async function readWindowsAuthorizationPath(): Promise<string> {
  const overridden = process.env.DESKLATCH_WINDOWS_GRANTS_FILE;
  if (overridden) return assertAbsolutePath(overridden);
  if (process.platform !== "win32") throw new Error("windows_authorization_unavailable");
  const { stdout } = await productPowerShell(
    `$v = Get-ItemPropertyValue -LiteralPath '${registryKey}' -Name '${registryValue}' -ErrorAction SilentlyContinue; if ($v) { [Console]::Write($v) }`,
  );
  if (!stdout.trim()) throw new Error("DeskLatch Windows setup is required before loading the native plugin.");
  return assertAbsolutePath(stdout.trim());
}

/** A protected directory prevents another Windows account from writing app grants. */
export async function prepareWindowsAuthorizationFile(file: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("windows_authorization_unavailable");
  const directory = dirname(assertAbsolutePath(file));
  await productPowerShell([
    '$dir = [IO.Directory]::CreateDirectory($env:DESKLATCH_WINDOWS_PRODUCT_ARGUMENT)',
    'if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Authorization directory cannot be a link" }',
    '$acl = [Security.AccessControl.DirectorySecurity]::new()',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$inheritance = [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"',
    'foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new("S-1-5-18"))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", $inheritance, "None", "Allow")) }',
    '$dir.SetAccessControl($acl)',
  ].join("; "), directory);
}
