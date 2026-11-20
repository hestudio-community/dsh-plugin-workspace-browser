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

The client requests browser lifecycle changes through the Host API; it has no direct Docker, runner-control, or Chrome DevTools Protocol endpoint. Web POSTs and all display WebSocket upgrades require a matching loopback Origin and DSH browser-owner admission. Desktop forwards same-origin requests from its main window to its owned Host, removes the renderer Origin and Sec-Fetch-Site headers, and applies its own DSH owner authentication. The Host allows this originless path only for marked JSON POSTs reaching a loopback address and authority, with neither header present and the same DSH browser-owner admission. The marker is not a credential; the Host does not grant CORS access or accept the marker on a WebSocket upgrade.

The renderer opens the display socket through DSH Client Connection so Desktop uses its owned Host instead of the renderer's custom-scheme origin. The socket carries one short-lived, single-use ticket bound to the browser run, generation, workspace, and DSH Session before binary display traffic. The Host uses a separate text control message to tell the elected view to request framebuffer resizes. DSH treats its authenticated browser tabs as the same owner; workspaces are not distinct users or access-control roles, and resize ownership coordinates cooperating clients rather than authenticating them. Never deploy this plugin behind a proxy or share the DSH browser-owner credentials with an untrusted party.

## Browser Lifecycle

Open or create a Session in a registered DSH workspace. An empty Session works without sending any messages; the home screen without a selected Session has no browser entry. Expand the native right sidebar, open its tool guide with **+** if needed, then select **Open workspace browser**. Chromium opens in a native sidebar tab alongside tools such as Files and Terminal. DSH owns docking and fullscreen behavior. There is no workspace picker: the Host resolves the workspace from the Session identifier submitted to `POST /dsh-browser/v2/view`. Unknown or ambiguous membership is rejected. Update the Host, Web client, and runner image together when installing this bundle.

Sessions in the same workspace share one running Chromium instance and persistent profile; different workspaces share neither. **Restart** replaces Chromium without deleting the profile, keeps the bound sidebar tabs open, and reconnects visible views when ready. If the replacement fails to start, retry with **Restart**. **Close**, Chromium exit, or Host retirement ends that browser run and removes its bound Chromium sidebar tabs, including hidden ones. These events do not end DSH conversations or close other sidebar tools.

A hidden or closed tab releases its display connection. A hidden tab remains bound to its browser run and checks its lifecycle without holding a runner seat. Returning to a visible tab rejoins that run with a new one-time ticket; losing only the display connection does not terminate the run. Reopening the browser explicitly after retirement starts or joins a new run. `POST /dsh-browser/v2/browser/status` reports the bound run's state, and the `/browser/restart` and `/browser/close` requests include the generation to reject stale controls.

The sidebar display fills its available area without a fixed aspect ratio. The first connected visible view requests Xtigervnc framebuffer resizes through noVNC; publishing a new size also changes the maximized Chromium window. Other views scale the shared framebuffer to fit, and the next connected view takes over resize when the current owner leaves. Xtigervnc runs without TCP listeners and uses a private Unix socket with mode `0600`; clipboard exchange remains disabled.

The Host starts one runner on demand per workspace, with a separate Chromium profile volume and display. The runner has no published ports, Docker socket, or mounted user/project directory. Chromium runs headfully with namespace and seccomp sandboxing. The runner refuses to advertise readiness if its isolation or display checks fail. Public HTTP(S) traffic passes through a private broker: the Host checks every A record and dials a validated numeric IPv4 address without resolving it a second time. The broker is not a content filter, and operators must keep the local engine and network routing under their control. Never give the runner privileged mode, host networking, unrestricted seccomp, or the Chromium `--no-sandbox` flag.

The runtime retires after approximately two minutes without any connected workspace views. Removing a workspace registration retires its runtime but does not delete its profile volume. The Docker volume contains browsing data such as cookies and history; do not share or export it as a diagnostic. A new DSH workspace registration has a new identity, even when its path is reused. Keep `profileNamespace` stable, and set it to a distinct value for each DSH profile sharing the same Docker engine before opening a browser. Keep Chromium and the container base current by rebuilding the image when deploying updates.

Each profile volume has a fixed runner container name. Docker atomically grants that name to at most one runner, even across Host processes. The Host also refuses to start if an active container already mounts the volume, including a pre-upgrade runner with a random name. Stop all old plugin instances before upgrading; concurrently running old and new versions against the same volume or mounting a managed volume manually is unsupported. An attempt that does not own a container must never stop or replace it. If a container remains registered under the fixed name, investigate it before retrying; the plugin does not forcibly reclaim it.

On its first launch after an interrupted shutdown or upgrade, the runner clears only Chromium’s three top-level singleton symlinks; it does not remove their targets or reset the profile. An unexpected entry type or filesystem error fails startup with a profile-recovery message. Profile contention, recovery, generic startup, and failed isolation checks are reported separately. To repair an affected installation, stop the old plugin instances, install the complete new bundle, then reopen the same registered workspace with the same `profileNamespace`. Do not remove the volume or re-register the workspace.

## Browser Use Authorization

`agentEnabled` defaults to `true` for each plugin instance in a DSH Host, covering all workspaces and Sessions it serves. It makes the plugin's own `browser` tool available for registration; it does not authorize any Session. Set it to `false` to disable the integration without affecting manual browsing. Only the agent integration waits for DSH's general `tools` registry. If another plugin already registered a tool named `browser`, disable the conflicting plugin and reload this integration. Losing the registry revokes active grants and cancels in-flight tool calls without closing manual views. The plugin implements Browser Use in its own Host and Chromium runner, without DSH's built-in Browser Use or Computer Use. It does not expose raw CDP, scripts, shell commands, filesystem operations, or unrestricted pointer/keyboard automation to the model.

Turn on **Agent access** in the current Session's Chromium toolbar. The switch defaults to off and becomes available when the provider is active and a browser is starting, restarting, or ready. It does not require a display connection. An authorized tool call made before Chromium is ready fails with a retryable error; calls are not queued. Hidden views and display disconnects do not revoke access or delay normal idle retirement.

The grant is held in memory for this Session and browser generation. It covers all supported web tabs, including background tabs and signed-in sites, with no per-site or per-action approval. Other Sessions sharing the browser need their own grants. Turning the switch off, a startup failure, browser restart or retirement, loss of workspace membership, or provider shutdown clears the grant and cancels in-flight calls. An action already delivered to a page cannot be undone.

Use `list` to find tabs and `navigate` with a tab ID and an absolute HTTP(S) URL, including from a blank or new tab. Cross-site navigation follows the browser's existing network policy. `inspect` returns bounded page text and document and element references for subsequent actions; stale references are rejected. Chromium internal pages are not inspectable. Page content is untrusted and may include sensitive information visible to the signed-in browser.

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

1. Create a new Session in a registered workspace without sending a message. In the right sidebar's tool guide, select **Open workspace browser**. Verify the real Chromium address bar, tabs, keyboard and pointer input, and navigation to `https://example.com`. Verify Files and Terminal still work, including after closing the Chromium tab. Check narrow, wide, docked, and fullscreen layouts: Chromium itself should resize and remain usable, not merely scale a fixed-size screenshot. Check `Shift+Escape` and reconnect after a display-only failure. Verify there is no plugin launcher in the conversation header, left sidebar, or home screen without a Session.
2. In two Sessions of one workspace, verify the same Chromium state is available after switching or reopening. With two simultaneous views, confirm only one controls the size and the second takes over once the first disconnects. In a second workspace, open the same public test site with distinct state and verify separation. From the first workspace, verify **Restart** preserves the profile and its sidebar tabs, and **Close** removes both visible and hidden Chromium tabs without affecting DSH conversations, other tools, or the second workspace. Verify the same terminal behavior after quitting Chromium and after idle retirement. Confirm that removing the Session's workspace prevents access to its old runner.
3. Confirm ordinary public HTTPS loads and that loopback, private addresses, and IPv6-only destinations fail. Confirm that Docker publishes no runner ports and that an unavailable runner or incompatible sandbox reports a startup error.
4. Verify that **Agent access** is initially off in two Sessions sharing a browser. Turn it on in one Session during launch without waiting for the display. Once ready, navigate from a blank tab across two public test sites, inspect a background tab, and click a harmless control without an approval prompt. Verify stale references are rejected and the other Session cannot use the tool without its own grant. Check that display disconnect and reconnect preserve access, switch-off and restart clear it, and failed startup and provider shutdown clear any grant. Confirm disabling the plugin releases the sidebar and tears down its runners.
5. In both supported locales, confirm the Plugin Manager metadata and icon, and check the sidebar in light and dark themes. Record results separately from build success.

### Profile restart regression

1. Use a disposable registered workspace in a test DSH profile with a distinct `profileNamespace`. Open its browser and save a test bookmark. Close the browser tab, wait for the runner to stop after the idle interval, then reopen the browser and verify the bookmark remains.
2. While the browser is open, identify the disposable workspace’s exact running container in Docker. Run `docker kill <test-container-id>` against only that container, and confirm the bound Chromium sidebar tabs close. Explicitly reopen Chromium in the same workspace, and verify that it reaches readiness and the bookmark remains. Do not remove the profile volume between launches.
3. Verify that a concurrent launch from a second Host targeting the same test workspace ID and namespace reports profile contention without interrupting the first runner. Confirm a different workspace can still start. Repeat the visible browser checks in both Desktop and local Web.
4. On a disposable runner, omit the required `no-new-privileges` option to verify that the runner emits `runner_isolation_failed` and never emits `ready`. Do not change the live plugin’s configuration.
