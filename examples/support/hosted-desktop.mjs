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
  let guest;
  const ownedGuests = async () => (await Sandbox.list({ query: { metadata }, limit: 10, requestTimeoutMs: 15_000 }).nextItems())
    .filter(sandbox => sandbox.metadata?.run === metadata.run && sandbox.metadata?.project === metadata.project);
  try {
    guest = await Sandbox.create({ timeoutMs, requestTimeoutMs: 45_000, metadata,
      allowInternetAccess: options.allowInternetAccess ?? false,
      network: options.network ?? { allowPublicTraffic: false } });
    const info = await guest.getInfo({ requestTimeoutMs: 15_000 });
    if (info.sandboxId !== guest.sandboxId || info.metadata?.run !== metadata.run) throw Error("unexpected_hosted_guest");
    console.log(JSON.stringify({ event: "hosted-desktop-ready", run: metadata.run, template: "desktop",
      vcpus: info.cpuCount, memoryMiB: info.memoryMB, startupMs: Math.round(performance.now() - started), timeoutMs }));
    await run(guest);
  } finally {
    // Desktop startup can fail after E2B allocated the VM but before create() returns a handle.
    if (guest) await guest.kill({ requestTimeoutMs: 15_000 }).catch(() => undefined);
    let remaining = await ownedGuests();
    if (remaining.length) {
      for (const sandbox of remaining) await Sandbox.kill(sandbox.sandboxId, { requestTimeoutMs: 15_000 });
      remaining = await ownedGuests();
    }
    if (remaining.length) throw Error("hosted_sandbox_cleanup_unconfirmed");
    console.log(JSON.stringify({ event: "hosted-desktop-released", run: metadata.run,
      elapsedMs: Math.round(performance.now() - started), remaining: remaining.length }));
  }
}
