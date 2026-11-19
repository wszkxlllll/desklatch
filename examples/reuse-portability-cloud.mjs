import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeskSession, createRiskPolicy } from "desklatch";
import { createE2BBrowserBackend } from "desklatch/e2b";
import { createVerifiedStepReuse, MemoryVerifiedStepReuseStore } from "desklatch/reuse";
import { runInHostedDesktop } from "./support/hosted-desktop.mjs";
import { selectedReuseSite } from "./support/reuse-sites.mjs";

const site = selectedReuseSite();
const { origin, searchUrl, target } = site;
const recordPath = process.env.DESKLATCH_REUSE_RECORD_PATH
  ?? resolve("artifacts", site.defaultRecordFile);
const metricsPath = process.env.DESKLATCH_REUSE_CLOUD_METRICS_PATH
  ?? resolve("artifacts", site.defaultCloudMetricsFile);
const replayQuery = process.env.DESKLATCH_REUSE_CLOUD_VALUE ?? site.cloudReplayQuery;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function writeUtf8(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, encoded, { encoding: "utf8" });
  const readBack = readFileSync(path, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("utf8_corrupt");
}

const localPolicy = createRiskPolicy({ reviewer: ({ action, target }) => ({
  classification: action.kind === "click" && target.role === "button" && target.name === site.consentName ? "low" : "unknown",
}) });

export async function runPortableReplay(withDesktop = runInHostedDesktop) {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const target = record.request?.steps?.[0]?.target;
  const metrics = {
    task: site.cloudTask,
    site: site.id,
    origin,
    searchUrl,
    recordPath,
    recordKey: record.key,
    recordDigest: digest(JSON.stringify(record)),
    replayQueryDigest: digest(replayQuery),
    replayQueryLength: replayQuery.length,
    status: "started",
    blockedExternalRequests: 0,
    blockedExternalHosts: [],
    submitted: false,
  };

  let blockedHosts;

  try {
    await withDesktop(async (guest) => {
      let currentPage;
      const prepare = async (page) => {
        currentPage = page;
        blockedHosts = new Set();
        await page.route("**/*", (route) => {
          let url;
          try { url = new URL(route.request().url()); } catch { void route.abort(); return; }
          if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
            void route.continue();
            return;
          }
          metrics.blockedExternalRequests += 1;
          blockedHosts.add(url.host || url.protocol);
          void route.abort();
        });
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(1_500);
      };
      const backend = await createE2BBrowserBackend(guest, {
        prepare,
        headless: false,
        startupTimeoutMs: 45_000,
        processTimeoutMs: 180_000,
        browser: {
          authorizedOrigins: [origin],
          includePublicValues: true,
          allowImages: false,
          searchTimeoutMs: 8_000,
          allowBlank: false,
        },
      });
      const session = createDeskSession({ ...backend, async observe(options) {
        try { return await backend.observe(options); }
        catch (error) {
          (metrics.backendErrors ??= []).push({ code: error?.code, name: error?.name, message: String(error?.message ?? error).slice(0, 240) });
          throw error;
        }
      } }, {
        allowModelImages: false,
        policy: localPolicy,
        timeoutMs: 75_000,
        expectTimeoutMs: 8_000,
      });
      try {
        // A known reusable target needs no general scan of the search page. Only
        // inspect the consent dialog when this site has one, then let act ground
        // the saved field itself.
        const observation = site.consentName
          ? await session.observe({ where: { role: "button", name: site.consentName } })
          : undefined;
        const cookie = observation && site.consentName
          ? observation.controls.find((control) => control.name === site.consentName && control.actions.includes("click"))
          : undefined;
        if (cookie) {
          const consent = await session.act({ steps: [{ kind: "click", target: { name: cookie.name } }] });
          metrics.cookieConsent = { status: consent.status, code: consent.code, steps: consent.steps };
          if (consent.status !== "completed") throw Error(`cookie_consent_failed:${consent.code ?? consent.status}`);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        }
        const replay = createVerifiedStepReuse({
          session,
          store: new MemoryVerifiedStepReuseStore([record]),
        });
        const currentLocation = new URL(currentPage.url());
        metrics.observedScope = { origin: currentLocation.origin, pathname: currentLocation.pathname };
        if (currentLocation.origin !== origin || !site.canonicalPaths.includes(currentLocation.pathname.replace(/\/$/u, ""))) {
          throw Error("unverified_search_scope");
        }
        const runOptions = {
          values: { query: replayQuery },
          context: { origin: currentLocation.origin, page: site.contextPage },
          coverage: { target: site.target, expected: "same selector value readback" },
        };
        let result = await replay.run(record.key, runOptions);
        if (result.result?.code === "target_not_found" && result.result.steps.length === 1 && result.result.steps[0].status === "not_dispatched") {
          metrics.firstUnsentReceipt = result.result.steps;
          const ready = await session.observe({ where: target });
          metrics.retryDiagnostic = {
            complete: ready.complete,
            controls: ready.controls.map((control) => ({
              role: control.role,
              name: control.name,
              actions: [...control.actions],
              states: [...control.states],
            })),
          };
          if (ready.complete && ready.controls.length === 1 && ready.controls[0].actions.includes("setValue")
            && ready.controls[0].states.includes("editable") && ready.controls[0].states.includes("enabled")) {
            result = await replay.run(record.key, runOptions);
          }
        }
        const fresh = await session.observe({ where: target });
        const field = fresh.controls.find((control) => control.name === target.name);
        metrics.replay = {
          status: result.status,
          succeeded: result.status === "completed" && result.succeeded === true,
          receipt: result.result?.steps,
          code: result.result?.code,
          observationComplete: fresh.complete,
          observedValueDigest: typeof field?.value === "string" ? digest(field.value) : undefined,
          observedValueLength: typeof field?.value === "string" ? field.value.length : undefined,
          differentValue: field?.value === replayQuery,
        };
        if (metrics.replay.succeeded !== true || metrics.replay.differentValue !== true) throw Error("cloud_replay_readback_failed");
        metrics.status = "cloud_replay_verified";
      } finally {
        await session.close().catch(() => undefined);
      }
      metrics.blockedExternalHosts = [...blockedHosts];
    }, {
        purpose: site.cloudPurpose,
      metadata: { recordKey: record.key, recordDigest: metrics.recordDigest },
      timeoutMs: 240_000,
      allowInternetAccess: true,
      network: {
        allowOut: site.allowOut,
        denyOut: ({ allTraffic }) => [allTraffic],
        allowPublicTraffic: false,
      },
    });
  } catch (error) {
    metrics.status = "boundary";
    metrics.errorType = error?.name ?? "Error";
    metrics.error = String(error?.message ?? error).slice(0, 280);
    metrics.blockedExternalHosts = [...(blockedHosts ?? [])];
  }

  writeUtf8(metricsPath, metrics);
  return metrics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPortableReplay();
  console.log(JSON.stringify(result));
  if (result.status !== "cloud_replay_verified") process.exitCode = 1;
}
