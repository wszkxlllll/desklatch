import { existsSync } from "node:fs";
import { join } from "node:path";

function chromiumPath() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  return [
    process.env.DESKLATCH_CHROMIUM,
    ...roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find((path) => path && existsSync(path));
}

export async function probeBrowserSite({ origin, preferences, signal }) {
  const url = new URL("/", origin).href;
  const { createPublicBrowserWorkspace, createWorkspaceNavigator } = await import("desklatch/browser");
  const executablePath = chromiumPath();
  signal?.throwIfAborted();

  if (preferences.browser.mode === "public") {
    const workspace = await createPublicBrowserWorkspace({ executablePath, timeoutMs: 14_000 });
    try {
      await workspace.navigate(url, signal);
      return { allowed: true, code: "browser_probe_allowed" };
    } finally {
      await workspace.close();
    }
  }

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, chromiumSandbox: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    const navigator = createWorkspaceNavigator(page, { authorizedOrigins: preferences.browser.origins, timeoutMs: 14_000 });
    try {
      await navigator.navigate(url, signal);
      return { allowed: true, code: "browser_probe_allowed" };
    } finally {
      await navigator.close();
    }
  } finally {
    await browser.close();
  }
}
