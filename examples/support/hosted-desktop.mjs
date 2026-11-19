import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/desktop";

// Only the opt-in hosted test owns a sandbox. DeskLatch itself still attaches to a host-provided guest.
// `network` and `allowInternetAccess` are explicit opt-ins for acceptance runs
// that need a real public site; the existing synthetic tests stay offline.
export async function runInHostedDesktop(run, options = {}) {
  if (!process.env.E2B_API_KEY) throw Error("Set E2B_API_KEY for the hosted acceptance run");
  const metadata = { ...options.metadata, project: "desklatch",
    purpose: options.purpose ?? "zhipu-cloud-acceptance", run: randomUUID() };
  const timeoutMs = options.timeoutMs ?? 480_000;
  const started = performance.now();
  const guest = await Sandbox.create({ timeoutMs, requestTimeoutMs: 45_000, metadata,
    allowInternetAccess: options.allowInternetAccess ?? false,
    network: options.network ?? { allowPublicTraffic: false } });
  try {
    const info = await guest.getInfo({ requestTimeoutMs: 15_000 });
    if (info.sandboxId !== guest.sandboxId || info.metadata?.run !== metadata.run) throw Error("unexpected_hosted_guest");
    console.log(JSON.stringify({ event: "hosted-desktop-ready", run: metadata.run, template: "desktop",
      vcpus: info.cpuCount, memoryMiB: info.memoryMB, startupMs: Math.round(performance.now() - started), timeoutMs }));
    await run(guest);
  } finally {
    await guest.kill({ requestTimeoutMs: 15_000 });
    const remaining = await Sandbox.list({ query: { metadata }, limit: 1, requestTimeoutMs: 15_000 }).nextItems();
    if (remaining.some(sandbox => sandbox.sandboxId === guest.sandboxId)) throw Error("hosted_sandbox_cleanup_unconfirmed");
    console.log(JSON.stringify({ event: "hosted-desktop-released", run: metadata.run,
      elapsedMs: Math.round(performance.now() - started), remaining: remaining.length }));
  }
}
