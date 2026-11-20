import { existsSync } from "node:fs";
import { createBrowserBackend } from "./index.js";
import type { BrowserBackend, BrowserBackendOptions } from "./types.js";

export interface LocalBrowserOptions extends BrowserBackendOptions {
  executablePath?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  content?: string;
  initialUrl?: string;
}

/** Launches a temporary, headless context; it never opens a user profile. */
export async function createLocalBrowserBackend(options: LocalBrowserOptions = {}): Promise<BrowserBackend> {
  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? findChromiumExecutable();
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const context = await browser.newContext({ ...(options.viewport ? { viewport: options.viewport } : {}) });
    const page = await context.newPage();
    if (options.content !== undefined) await page.setContent(options.content);
    else if (options.initialUrl) await page.goto(options.initialUrl);
    const backend = createBrowserBackend(page, { ...options, allowBlank: options.allowBlank ?? options.content !== undefined });
    return Object.freeze({
      ...backend,
      close: async () => {
        try { await backend.close(); }
        finally { await browser.close(); }
      },
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Resolve a locally installed Chromium without downloading or using a user profile. */
export function findChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.DESKLATCH_CHROMIUM,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}
