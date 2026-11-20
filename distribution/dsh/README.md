# DeskLatch native DSH bundle

This Cordis bundle exposes `desklatch_observe` and `desklatch_act` inside
DSH. On Windows x64, its CUA driver operates desktop windows owned by an
application that the user granted in DeskLatch's authorization page. DSH
supplies the agent loop, model, session, and approval service.

On Windows, use the installer to install the bundle and initialize the
authorization page. Then select the allowed applications in
`DeskLatch-Authorize.cmd` before running tasks. The underlying DSH command is:

```text
dsh plugin --profile <profile> add --ignore-scripts /absolute/path/desklatch-dsh-<version>.tgz
dsh --profile <profile>
```

The package declares `dsh.bundle.patch`; no manual profile patch is required.
The bundle carries the DeskLatch runtime and installs its pinned CUA driver
and Windows inspector dependencies. Outside Windows, it opens the isolated
browser demo. The demo can use an installed Chrome or Edge or a Chromium
binary selected through `DESKLATCH_CHROMIUM`.

The Windows installer persists optional OCR and E2B settings with the local
authorization. OCR supplies local evidence for ambiguous actions under the
screen-capture grant. With an E2B key configured, the two DeskLatch tools can
switch to the cloud browser and Writer. The first cloud activation starts the
guest. Approval continues through DSH's normal session cards.
