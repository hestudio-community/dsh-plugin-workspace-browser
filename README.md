# dsh-plugin-workspace-browser

Open a full, isolated Chromium window from the native right sidebar of a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspace
Session, in DSH Web and DSH Desktop.

Each workspace gets its own Chromium instance, persistent profile, and
containerized display. Sessions in the same workspace share one browser;
different workspaces share neither. Chromium runs in a local Linux container
instead of the DSH Host's desktop, so it uses neither the Host's browser nor its
cookies.

## Features

- A live, resizable Chromium window in a native sidebar tab, alongside tools
  such as Files and Terminal.
- The sidebar tab title follows the active Chromium window title.
- A persistent profile per workspace: cookies, bookmarks, and history survive
  restarts and upgrades.
- The registered workspace directory is mounted read/write at `/workspace`,
  Chromium's download directory.
- **Chromium controls** to restart Chromium (keeping the profile and tabs) or
  close the browser run.
- An idle timeout that retires the browser after its last view disconnects.
- Optional agent access, off by default in each Session. The agent tool can
  list tabs, navigate, inspect, click, fill, and scroll.
- Optional remote Web access through an exact allow-list of trusted origins.

## Requirements

- A local Docker engine with Linux/amd64 container support. Windows requires
  Docker Desktop in Linux-container mode; on Linux, use a local rootful engine
  without user namespace remapping.
- A registered DSH workspace. Use a dedicated workspace if the browser should
  not see other project files.
- The DSH Host must be able to reach the sites you open. Host file transfer,
  host clipboard integration, and audio forwarding are out of scope.

## Website access

Chromium can open HTTP(S) sites reachable from the DSH Host, including LAN and
IPv6 sites, `localhost`, and sites on non-default ports. For example, enter
`http://192.168.31.1` to open a device at that LAN address. `localhost` means the
machine running DSH, not a remote viewer's computer. Chromium security rules,
TLS validation, and the Host's DNS, routing, and firewall still apply.

Websites and authorized agents can make requests to HTTP(S) services on the Host
and its private network. Open only trusted sites when working with sensitive
internal services, and grant agents access only in Sessions you trust. The
**Remote Web access** setting controls where DSH can be opened, not what the
workspace Chromium can reach.

## Install

1. Install the release bundle archive in **Plugin Manager** and enable
   `dsh-plugin-workspace-browser`.
2. Open **Plugins → Installed → dsh-plugin-workspace-browser → Environment
   check** and select **Check environment**. If the Chromium runner image is
   missing or incompatible, use **Build current version**. The image is built
   locally with Docker and can take several minutes.
3. Open or create a Session in a registered workspace, expand the right
   sidebar, and choose **+ → Open workspace browser**.

Opening Chromium only inspects the runner image; it never builds one. After
upgrading the plugin, build the matching image.

## Learn more

Configuration, remote Web access, security boundaries, development commands,
and acceptance checks are documented in the
[development guide](docs/developer/development.md).
