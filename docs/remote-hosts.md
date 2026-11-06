# Remote hosts

Fork-only for now (oalhait/pi-gui). Shape it for upstream once it has been used for a while.

## Goal

Work on a server from the pi-gui desktop app. A chat in a remote folder runs Pi on the server,
using the server's files, tools, `~/.pi/agent` settings, extensions, skills and provider
credentials. The run continues when the laptop sleeps, loses network or quits, and the app
catches up when it reconnects.

## Success criteria (first stack)

On the real Electron surface, against a real SSH host:

1. Settings → Remote hosts can add, edit, test and remove a host. A host is an SSH destination
   (an `~/.ssh/config` alias or `user@host[:port]`) plus optional overrides.
2. "Add remote folder" registers a path on a host. It appears in the sidebar under that host,
   with a connection status.
3. In a remote folder: create a chat, send, stream, use tools, stop, queue/steer, switch model and
   thinking level, rename, archive, reopen after app restart.
4. Kill the SSH connection mid-run (or sleep the laptop). The run finishes on the server. On
   reconnect the transcript, status and queue match the server, with no duplicated or lost rows.
5. Quit pi-gui mid-run, reopen: same as 4.
6. Two pi-gui instances connected to one host see the same remote threads.
7. Features not yet supported remotely (terminal, Files, Review, worktrees, checkpoints, open in
   editor, file attachments, extension views, workbench/orchestration/scheduled-task tools) show
   an explicit unavailable state instead of acting on the laptop's disk.
8. Local folders behave exactly as before. `pnpm check` and the existing Core Electron suites pass.

## How Codex does it (reference)

Codex is open source at [openai/codex](https://github.com/openai/codex). The desktop app is not,
but the remote pieces it drives are:

- `codex app-server` is a JSON-RPC server the app and IDE extension talk to. It listens on stdio,
  a Unix socket or a WebSocket.
- [`codex-rs/app-server-daemon`](https://github.com/openai/codex/tree/main/codex-rs/app-server-daemon)
  runs it as a detached, pidfile-backed process for "Codex instances launched over SSH".
  `codex app-server daemon bootstrap|start|stop|restart|version|update` each print one JSON
  object, are idempotent and are serialized by a lock. State lives in
  `CODEX_HOME/app-server-daemon/`. The daemon is not reboot-persistent; the next managed start
  brings it back.
- The control socket is bound in a private directory (owner-only, `0700`) and checked on bind.
- `codex app-server proxy` copies stdio to that socket. So the desktop runs it over SSH and gets
  a byte stream to the daemon without opening ports.
- Clients reconnect and `thread/resume` / `thread/read` to resync. Pending approvals are replayed
  to a capable client that reconnects.
- "Remote control" (reaching the daemon from the phone app through OpenAI's relay) is a separate
  layer. We do not have a relay; Tailscale + SSH covers that need.

We follow the same shape: a detached host daemon on the server, a private Unix socket, a stdio
proxy run over SSH, and resync-by-snapshot on reconnect.

## Design

### Pieces

```text
laptop: pi-gui (Electron main)
  RoutingSessionDriver ── local workspaces ──► PiSdkDriver (in process, unchanged)
                       └─ remote workspaces ─► RemoteSessionDriver
                                                  │ JSONL over stdio
                                       ssh -T <host> node ~/.pi-gui-host/current/host.mjs proxy
                                                  │ Unix socket (~/.pi-gui-host/run/host.sock, dir 0700)
server: pi-gui-host daemon ── PiSdkDriver + RuntimeSupervisor + JsonCatalogStore (server-side)
```

- **`packages/remote-protocol`**: browser-safe, versioned message types and JSONL framing. Split
  records only on `\n` (Node `readline` also splits on U+2028/U+2029, which are valid in JSON
  strings; Pi's RPC docs call this out). Requests/responses correlated by id; server events;
  server→client requests (host UI dialogs, desktop tool callbacks).
- **`packages/pi-gui-host`**: the server program. Runs the existing `PiSdkDriver` unchanged and
  exposes `SessionDriver` + `RuntimeResourceDriver` over the protocol. Commands, each printing one
  JSON object: `daemon start|stop|status|version`, plus `proxy` (stdio ↔ socket).
- **Desktop**: a connection owner per host in Electron main (spawn `ssh`, bootstrap, handshake,
  reconnect with backoff), `RemoteSessionDriver`, and a routing driver that `DesktopAppStore` uses
  instead of `PiSdkDriver` directly.

### Where data lives

- The **server** owns remote workspaces, sessions and transcripts (its own catalog under
  `~/.pi-gui-host/`, Pi sessions under the server's `~/.pi/agent`). That is what lets two laptops
  see the same threads.
- The **laptop** owns host configuration (`remote-hosts.json` in userData) and UI state: drafts,
  selection, workbench layout, unread marks.
- Remote workspace ids are namespaced on the laptop (`remote:<hostId>:<serverWorkspaceId>`) so
  they never collide with local ids. Only the routing driver translates them.
- Provider credentials live on the server. v1 supports API keys and an existing server
  `auth.json`; OAuth login with the redirect forwarded through SSH comes later.

### Host configuration

```json
{
  "id": "devbox",
  "label": "Devbox",
  "ssh": { "destination": "devbox", "port": null, "identityFile": null, "extraArgs": [] },
  "nodePath": null,
  "hostHome": "~/.pi-gui-host"
}
```

`destination` is passed to the system `ssh`, so `~/.ssh/config`, agents, ProxyJump and Tailscale
SSH all work. Settings suggests `Host` entries from `~/.ssh/config`. We always run with
`BatchMode=yes` and `ServerAliveInterval`; interactive auth (passwords, unknown host keys) is
reported as an error asking the user to fix it in a terminal first.

### Install and version

Requirements on the server: Node ≥ 22.19 (Pi's engine requirement) and npm, Linux or macOS.
Connecting runs `ssh <host> sh -s` with a small bootstrap script that:

1. checks Node, reads `~/.pi-gui-host/current/version`;
2. if missing or different from the app's host version, uploads the bundled host tarball (shipped
   inside the app) and installs it into `~/.pi-gui-host/versions/<version>` with
   `npm install --omit=dev`, then repoints `current`;
3. runs `host.mjs daemon start` (idempotent) and prints its JSON.

A version change restarts the daemon only when it is idle, or after the user confirms; it never
silently kills running work.

### Lifecycle and reconnect

- The daemon is detached (`setsid`) and pidfile/lock-backed. It survives SSH disconnects and
  app quit. Not reboot-persistent in v1 (a systemd/launchd user unit is a later option).
- Handshake: protocol version, host version, client id. Incompatible versions fail with a clear
  message.
- On disconnect, remote folders show "Reconnecting…" and their composers are disabled. Local
  folders are unaffected.
- On reconnect: relist workspaces and sessions, resubscribe open sessions, reload their transcripts
  through the existing `reloadTranscriptFromDriver` path, and receive any still-pending host UI
  requests. Resync is by snapshot; we do not replay missed events. Cancelled or answered dialogs
  are first-answer-wins across clients.

### Desktop callbacks for built-in tools

pi-gui's built-in Pi tools (`main.ts` `builtinExtensions`) call straight into the desktop today.
On the server they become server→client requests over the same connection. If no desktop is
connected, the tool returns a clear "pi-gui is not connected" result. The first stack wires only
the chat-title tool; workbench, orchestration and scheduled tasks are disabled for remote
workspaces until later.

### Things that read the local disk

Remote workspaces must never fall through to local disk reads. The first stack gates each of
these by workspace host: terminal, Files/file tabs, workspace images, Review, worktrees, turn
capture/checkpoints (turn capture hook not installed on the server), open in editor, file
attachments (pasted images still work: they are sent inline), `statSelectedTranscriptFile`
(replaced by server-reported session file stats), extension views.

## Stack

Each branch builds on the one below and is reviewable on its own. Fork-only PRs against
`oalhait/pi-gui` `main`.

1. **`omar/remote-hosts-plan`**: this plan.
2. **`omar/remote-protocol`**: `packages/remote-protocol`: message types, JSONL framing,
   handshake, error shapes. Unit tests including U+2028/U+2029 framing, partial chunks, oversized
   records.
3. **`omar/remote-host-daemon`**: `packages/pi-gui-host`: daemon start/stop/status/version, private
   socket, `proxy`, serving `PiSdkDriver` + `RuntimeSupervisor`, server→client requests,
   multi-client fan-out. Integration tests over a local socket with a fake Pi runtime (no SSH).
4. **`omar/remote-driver`**: desktop host config persistence, connection owner (ssh spawn,
   bootstrap, reconnect), `RemoteSessionDriver`, routing driver, namespaced ids, catalog merge,
   gating of local-disk features. Unit tests with an in-process transport.
5. **`omar/remote-hosts-ui`**: Settings → Remote hosts, Add remote folder, sidebar host groups and
   connection status, unavailable states. Core Electron spec using a local-command transport in
   place of `ssh`; then real-host verification below.

Later stacks: remote terminal (node-pty on the server); Files and Review through a host
filesystem/Git capability (move `git-review.ts` behind a command-runner interface); worktrees and
checkpoints on the server; workbench/orchestration/scheduled-task tools via callbacks; OAuth login;
optional systemd/launchd unit.

## Verification

- Unit: protocol framing; routing driver id translation; reconnect resync logic.
- Integration: host daemon over a local Unix socket; two clients; client disconnect mid-run while
  the run completes; pending host UI request replayed to a reconnecting client.
- Core Electron: remote folder via the local-command transport: send, stream, stop, reconnect,
  restart. Existing Core suites unchanged.
- Real host (`ssh localhost`, then the actual server): success criteria 1–7 by hand, recorded in
  the PR with screenshots. Use the [verification skill](../.agents/skills/verify-pi-gui/SKILL.md)
  for the conversation flows.

## Open questions

- Packaging the host tarball inside the app vs. installing from a GitHub release. Start with the
  app-bundled tarball (works offline, matches the app version exactly).
- Whether the server-side catalog should also discover existing Pi sessions created by the `pi`
  CLI on the server (the local driver already does this for local folders via `syncWorkspace`).
  Expected yes, since it reuses the same code.
