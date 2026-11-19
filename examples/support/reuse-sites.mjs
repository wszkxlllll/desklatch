const RIKSMUSEUM = Object.freeze({
  id: "rijksmuseum",
  origin: "https://www.rijksmuseum.nl",
  searchUrl: "https://www.rijksmuseum.nl/en/search",
  searchName: "Search the collection, library catalogue and visitor stories",
  target: { role: "textbox", name: "Search the collection, library catalogue and visitor stories" },
  canonicalPaths: ["/en/search", "/en/collection/search"],
  contextPage: "collection-search",
  recordKey: "rijksmuseum-search-field",
  defaultRecordFile: "reuse-rijksmuseum-record.json",
  defaultLocalMetricsFile: "reuse-rijksmuseum-portability-local.json",
  defaultCloudMetricsFile: "reuse-rijksmuseum-cloud.json",
  localTask: "local-rijksmuseum-reuse-capture",
  cloudTask: "cloud-rijksmuseum-reuse-portability",
  cloudPurpose: "reuse-rijksmuseum-portability",
  captureQuery: "desklatch-verified-capture",
  localReplayQuery: "desklatch-verified-replay",
  cloudReplayQuery: "desklatch-cloud-replay",
  consentName: "No, rather not",
  allowOut: ["www.rijksmuseum.nl"],
});

const PYTHON = Object.freeze({
  id: "python",
  origin: "https://docs.python.org",
  searchUrl: "https://docs.python.org/3/search.html",
  searchName: "Search",
  target: { role: "textbox", name: "Search" },
  canonicalPaths: ["/3/search.html"],
  contextPage: "python-docs-search",
  recordKey: "python-docs-search-field",
  defaultRecordFile: "python-record.json",
  defaultLocalMetricsFile: "python-local.json",
  defaultCloudMetricsFile: "python-cloud.json",
  localTask: "local-python-docs-reuse-capture",
  cloudTask: "cloud-python-docs-reuse-portability",
  cloudPurpose: "reuse-python-docs-portability",
  captureQuery: "pathlib",
  localReplayQuery: "datetime",
  cloudReplayQuery: "datetime",
  consentName: undefined,
  allowOut: ["docs.python.org"],
});

export const REUSE_SITES = Object.freeze({ rijksmuseum: RIKSMUSEUM, python: PYTHON });

export function selectedReuseSite(value = process.env.DESKLATCH_REUSE_SITE) {
  const id = String(value ?? "rijksmuseum").trim().toLocaleLowerCase();
  const site = REUSE_SITES[id];
  if (!site) throw Error(`unknown_reuse_site:${id}`);
  return site;
}
