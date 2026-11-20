# DeskLatch native DSH bundle

This package is the portable Cordis bundle for DeskLatch's bounded demo. It
mounts the exported native `createDeskDshPlugin` in the official DSH runtime,
opens an isolated headless browser, and exposes the demo form's `observe` and
`act` tools. DSH owns the agent loop, model, session, approval card, and its
Cordis/tools/approval peer singletons.

Install the generated `desklatch-dsh-<version>.tgz` into a DSH profile using the
normal bundle workflow:

```text
dsh plugin --profile <profile> add /absolute/path/desklatch-dsh-<version>.tgz
dsh --profile <profile>
```

The package declares `dsh.bundle.patch`; no manual profile patch is required.
The bundle carries its own DeskLatch runtime and pinned Playwright runtime.
The DSH host supplies its own Cordis context and services.
The bundle does not download a browser or select a user profile. Set
`DESKLATCH_CHROMIUM` (or use an existing Chrome/Edge installation) when DSH
cannot discover a local Chromium executable.
