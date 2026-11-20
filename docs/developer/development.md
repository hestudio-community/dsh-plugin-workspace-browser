# Development Guide

## Compatibility and Status

The implementation targets local DSH Web and the main DSH Desktop window in DSH 0.2.2-rc.3. Both use a loopback DSH Host and a local Linux/amd64 Docker engine. Windows requires Docker Desktop in Linux-container mode. Building the package does not verify runtime compatibility; complete the acceptance checks below on both surfaces before release. Browsing supports public IPv4 HTTP(S) sites on default ports only. Remote DSH Web, private and development sites, IPv6-only sites, host file transfer, host clipboard integration, and audio forwarding are out of scope.

## Module Boundaries

| Area | Responsibility |
| --- | --- |
| `src/client/` | Native right-sidebar guide entry and tab, Session workspace lookup, noVNC client, and Browser Use approvals. |
| `src/host/` | DSH admission, Session-to-workspace binding, runner lifecycle, and controlled egress. |
| `src/shared/` | Versioned Web contract and platform-independent validation. |
| `runner/` | Chromium, virtual display, and private automation, RFB, and proxy transport. |
| `test/` | Permanent Host and cross-module tests. |

The client has no Docker, runner control, or Chrome DevTools Protocol endpoint. Web POSTs and all display WebSocket upgrades require a matching loopback Origin and DSH browser-owner admission. Desktop forwards same-origin requests from its main window to its owned Host, removes the renderer Origin and Sec-Fetch-Site headers, and applies its own DSH owner authentication. The Host allows this originless path only for marked JSON POSTs reaching a loopback address and authority, with neither header present and the same DSH browser-owner admission. The marker is not a credential; the Host does not grant CORS access or accept the marker on a WebSocket upgrade.

The renderer opens the display socket through DSH Client Connection so Desktop uses its owned Host instead of the renderer's custom-scheme origin. The socket carries one short-lived, single-use, workspace-bound ticket before binary display traffic. DSH treats its authenticated browser tabs as the same owner; workspaces are not distinct users or access-control roles. Never deploy this plugin behind a proxy or share the DSH browser-owner credentials with an untrusted party.

## Browser Lifecycle

Open or create a Session in a registered DSH workspace. An empty Session works without sending any messages; the home screen without a selected Session has no browser entry. Expand the native right sidebar, open its tool guide with **+** if needed, then select **Open workspace browser**. Chromium opens in a native sidebar tab alongside tools such as Files and Terminal. DSH owns docking and fullscreen behavior. There is no workspace picker: the Host resolves the workspace from the Session identifier submitted to `POST /dsh-browser/v1/view`. Unknown or ambiguous membership is rejected. Update the Host and Web client together when installing this bundle.

A hidden or closed tab releases its display connection. Returning to a visible tab obtains a new one-time ticket for its Session. Sessions in the same workspace reuse the workspace's running Chromium instance and persistent profile; Sessions in different workspaces do not share either.

The Host starts one runner on demand per workspace, with a separate Chromium profile volume and display. The runner has no published ports, Docker socket, or mounted user/project directory. Chromium runs headfully with namespace and seccomp sandboxing. The runner refuses to advertise readiness if its isolation or display checks fail. Public HTTP(S) traffic passes through a private broker: the Host checks every A record and dials a validated numeric IPv4 address without resolving it a second time. The broker is not a content filter, and operators must keep the local engine and network routing under their control. Never give the runner privileged mode, host networking, unrestricted seccomp, or the Chromium `--no-sandbox` flag.

Closing the last view revokes Browser Use and leaves the runtime idle for approximately two minutes. Removing a workspace registration retires its runtime but does not delete its profile volume. The Docker volume contains browsing data such as cookies and history; do not share or export it as a diagnostic. A new DSH workspace registration has a new identity, even when its path is reused. Keep `profileNamespace` stable, and set it to a distinct value for each DSH profile sharing the same Docker engine before opening a browser. Keep Chromium and the container base current by rebuilding the image when deploying updates.

Each profile volume has a fixed runner container name. Docker atomically grants that name to at most one runner, even across Host processes. The Host also refuses to start if an active container already mounts the volume, including a pre-upgrade runner with a random name. Stop all old plugin instances before upgrading; concurrently running old and new versions against the same volume or mounting a managed volume manually is unsupported. An attempt that does not own a container must never stop or replace it. If a container remains registered under the fixed name, investigate it before retrying; the plugin does not forcibly reclaim it.

On its first launch after an interrupted shutdown or upgrade, the runner clears only Chromium’s three top-level singleton symlinks; it does not remove their targets or reset the profile. An unexpected entry type or filesystem error fails startup with a profile-recovery message. Profile contention, recovery, generic startup, and failed isolation checks are reported separately. To repair an affected installation, stop the old plugin instances, install the complete new bundle, then reopen the same registered workspace with the same `profileNamespace`. Do not remove the volume or re-register the workspace.

## Browser Use Authorization

`agentEnabled` defaults to `false`. The manual browser does not require the DSH `browserUse` or `tools` services. If `agentEnabled` is on, only the agent integration waits for those services. Losing either service revokes active grants and pending approvals without closing manual views. DSH has one provider slot; disable any competing provider, or the plugin's `browser` tool will remain unavailable. This plugin provides its own bounded tool; it does not attach a stock provider, expose raw CDP, or offer scripts, shell commands, filesystem operations, or unrestricted pointer/keyboard automation to the model.

Open the site in Chromium manually, then authorize an existing Session from that workspace and enter the exact origin (such as `https://example.com`, without a trailing slash). The Host derives the workspace from trusted Session membership and limits access to ten minutes while at least one workspace view remains connected. Only the visible, foreground, same-origin document is eligible for inspection or interaction. The first operation can list same-origin tabs, and `inspect` returns bounded page text and short-lived element references. `navigate`, `click`, and `fill` require individual sidebar approval and reject stale references. `scroll` is also scoped to the authorized document. Revoke the grant before leaving a sensitive site; never authorize pages containing secrets that should not enter the AI conversation, and never enter credentials into approval fields. Page content is untrusted. Approved actions can still cause a site's ordinary page behavior; revocation cannot undo an action already sent to the page.

## Build and Verification Status

The developer, not the agent, runs environment setup and builds. See the [repository instructions](../../AGENTS.md). Maintainers need Node.js 22 or later, npm, DSH 0.2.2-rc.3, and a Linux/amd64 Docker engine. Users need only the complete, trusted bundle and a running, compatible local Docker engine accessible to DSH. Windows uses Docker Desktop in Linux container mode. Configure `dockerExecutable` only if the fixed platform default is unavailable.

By default the Host uses the [bundled seccomp profile](../../src/host/chromium-seccomp.json), based on [Moby's Apache-2.0 profile](https://github.com/moby/profiles/blob/seccomp/v0.1.0/seccomp/default.json) with [its license](../../src/host/chromium-seccomp.LICENSE.txt). The amd64 additions only permit `clone` with Chromium's required namespace flag combinations (user alone, PID alone, or user + PID + network) and `unshare` with exactly the user namespace flag. Other Docker restrictions and the mandatory Chromium sandbox checks remain in force. `seccompProfile` overrides this file only for administrators who have reviewed a local absolute path and its policy. A host kernel or security policy can still reject namespaces; do not disable the sandbox to work around it.

From the repository root:

```sh
npm install
npm test
npm run build
npm run build:runner
npm run bundle:runner
npm pack --dry-run
npm pack
```

`bundle:runner` saves the local Linux/amd64 image by immutable ID, compresses it, and writes `dist/runner-image.tar.gz` and `dist/runner-image.json`. Rebuild and bundle the runner together whenever preparing a release. `prepack` checks for nonempty Client outputs and verifies the archive against its SHA-256 manifest. The package listing must include both Runner artifacts, the Host modules and seccomp policy/license, `dist/client.js` and its notices, patch, locales, icon, and documentation. Before distributing the container image, fulfill the applicable redistribution and corresponding-source obligations for the included third-party software.

In each DSH profile you use, install and enable the generated bundle archive in the Plugin Manager. Reload the local Web page or reopen the main Desktop window as needed to load the new client. Open a Session in a registered workspace, expand the right sidebar and choose **+ → Open workspace browser**. This is distinct from DSH's built-in Browser tool. On the first launch the Host checks the local engine for the bundled image ID. If absent, it verifies and imports the local archive before opening Chromium; no manual Docker command, image pull, or build is needed. Allow a few minutes for the first import. Hosts with a cached copy use the exact same image ID without importing again. A failed attempt can be retried; the plugin does not remove images or profiles on disable.

Do not run a replacement DSH Web server or edit the profile's persistence files directly. For a runtime failure, report the first failing stage (tab, `/view`, display handshake, or established display), HTTP status and error code if available, host platform, and Docker engine version. Do not include tickets, cookies, request payloads, or browsing data.

After installation, run the following UI checks independently in the existing loopback Web application and in the main Desktop window. For first-run image import, repeat the startup check on a clean Docker engine with no copy of the release image ID; do not remove images or volumes from the user's engine to create this condition.

1. Create a new Session in a registered workspace without sending a message. In the right sidebar's tool guide, select **Open workspace browser**. Verify the real Chromium address bar, tabs, keyboard and pointer input, and navigation to `https://example.com`. Verify Files and Terminal still work, including after closing the Chromium tab. Check narrow and docked layouts, `Shift+Escape`, and reconnect after a failure. Verify there is no plugin launcher in the conversation header, left sidebar, or home screen without a Session.
2. In two Sessions of one workspace, verify the same Chromium state is available after switching or reopening. In a second workspace, open the same public test site with distinct state and verify separation. Verify persistence after idle shutdown. Confirm that removing the Session's workspace prevents access to its old runner.
3. Confirm ordinary public HTTPS loads and that loopback, private addresses, and IPv6-only destinations fail. Confirm that Docker publishes no runner ports and that an unavailable runner or incompatible sandbox reports a startup error.
4. In a real Session authorized for the test site, ask Browser Use to inspect a visible tab and click a harmless control after approval. Verify the same tab changes. Check wrong Session, different origin, denied and stale approvals, last-view close, and competing provider behavior. Confirm disabling the plugin releases the sidebar and tears down its runners.
5. In both supported locales, confirm the Plugin Manager metadata and icon, and check the sidebar in light and dark themes. Record results separately from build success.

### Profile restart regression

1. Use a disposable registered workspace in a test DSH profile with a distinct `profileNamespace`. Open its browser and save a test bookmark. Close the browser tab, wait for the runner to stop after the idle interval, then reopen the browser and verify the bookmark remains.
2. While the browser is open, identify the disposable workspace’s exact running container in Docker. Run `docker kill <test-container-id>` against only that container, then reopen the same workspace. Verify that Chromium reaches readiness and the bookmark remains. Do not remove the profile volume between launches.
3. Verify that a concurrent launch from a second Host targeting the same test workspace ID and namespace reports profile contention without interrupting the first runner. Confirm a different workspace can still start. Repeat the visible browser checks in both Desktop and local Web.
4. On a disposable runner, omit the required `no-new-privileges` option to verify that the runner emits `runner_isolation_failed` and never emits `ready`. Do not change the live plugin’s configuration.
