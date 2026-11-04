# Omar’s pi-gui fork

The maintained distribution is [oalhait/pi-gui](https://github.com/oalhait/pi-gui).
Matthew Lam’s [original repository](https://github.com/minghinmatthewlam/pi-gui) remains upstream.
The MIT license and original attribution remain intact.

The fork includes the changes submitted upstream as [#320](https://github.com/minghinmatthewlam/pi-gui/pull/320)
(manual compaction), [#321](https://github.com/minghinmatthewlam/pi-gui/pull/321)
(app navigation), and [#322](https://github.com/minghinmatthewlam/pi-gui/pull/322)
(Mark as unread). Their equivalent local commits are already in this history; merging their
separate feature branches again is unnecessary. Keep those upstream PRs open.

## Browser ownership

Each website appears directly in the workbench’s top-level tab row, alongside Review,
Files and Terminal. Add tab → Browser opens another page; popups open another page there too.
The main process persists pages and the selected page per chat in `browser-tabs.json`.
One saved Browser tool slot supplies all of that chat’s website tabs in the workbench row. Switching to another tool hides the native page without closing it.
Existing browser tabs and their saved website logins are retained.

## Agent side pane controls

The built-in `workbench` tool lets Pi agents open browser pages and Files, Review, Terminal or
extension tabs, inspect/select/close tabs, navigate pages and show/hide the side pane.
It uses pi-gui’s own controllers, so it does not require macOS Accessibility or Screen Recording.

The main process derives the requesting chat from Pi’s session context and accepts responses
only from that chat’s owned app window. The requesting chat must be selected in a pi-gui window; the window does not have to be focused.
Requests for a chat that is not selected in any window fail without switching the user to it. Cancellation is checked before deferred
file opens, and browser navigation retains the exact page ID across delayed replies. Use `list` to
obtain `tab_id` for an existing browser page; without it, navigation targets the selected browser tab.
This tool manages the application’s pane; it does not provide web page DOM automation.

`capture` (optional `tab_id`, default the selected tab) is read-only. For a browser tab it
captures the page’s own contents (`capturePage` on its view, not the window), so it works with
pi-gui in the background or covered, and returns url, title, loading/error state and viewport.
Blank and failed pages return no image and say why; a page the user is not looking at (other tab
selected, pane hidden, overlay open) is still captured and marked `visible_to_user: false`. Files,
Review, Terminal and extension tabs capture only the pane’s rectangle, plus a short description,
and only while selected and visible. Images are downscaled to a 1600px longest edge and kept in
memory; tool details never contain image bytes. Pi does persist the returned image in the
session transcript like any other tool-result image.

`read` (browser tabs only, optional `tab_id`) returns the page’s url, title, visible text (12,000
characters), headings (50), visible links (100) and form fields (50), each item capped. It runs a
script with `executeJavaScriptInIsolatedWorld`, so it shares the DOM but none of the page’s
JavaScript and nothing of pi-gui; main rebuilds the answer with known fields and caps. Password,
file, hidden and credit-card/one-time-code fields never return values. `format: "html"` adds raw
HTML capped at 60,000 characters. The script has a 5-second deadline.

The tool is registered with `exposure: "direct"`, so it is declared from session start and stays
declared when a deferred MCP server (such as Slack) activates `tool_search` or extensions reload;
the unit regression in `tests/unit/workbench-agent.spec.ts` covers this.

## Compatibility and backups

Keep the `com.pi-gui.desktop` app ID, `pi` userData directory, `~/.pi/agent` directory,
and `persist:pi-browser` partition stable. These are what let an existing installation
retain its conversations, settings, provider sign-ins and website logins.
Before replacing an installed build, quit idle pi-gui, back up its full userData and agent
directories, and keep the previous app bundle for rollback. On macOS these default to
`~/Library/Application Support/pi` (or `PI_APP_USER_DATA_DIR` when explicitly overridden) and
`~/.pi/agent`. Backups contain credentials;
never attach them to issues, PRs or releases.

## Releases

Update the root, desktop and website package versions together. Run `pnpm check`, the affected
Electron core specs, and native/package checks before publishing. The fork’s update checker
and packaging destination point to `oalhait/pi-gui`; they do not modify the upstream PR branches.

Run browser and workbench regression checks with:

```sh
pnpm --filter @pi-gui/desktop test:e2e:runner apps/desktop/tests/core/browser-panel.spec.ts apps/desktop/tests/core/workbench-tabs.spec.ts apps/desktop/tests/core/side-panel-tab-shortcuts.spec.ts apps/desktop/tests/core/terminal-focus.spec.ts
```

The [desktop verification skill](../.agents/skills/verify-pi-gui/SKILL.md) describes the
native and packaged verification boundaries. Run affected native and core checks separately;
the workflow’s `pnpm check` and packaged-dependency check do not run them.

The [Personal macOS release workflow](../.github/workflows/fork-release.yml) is manual. It builds a macOS arm64 app, checks the
package dependencies, and stages a draft GitHub release with a ZIP and SHA-256 checksums.
Review the draft’s artifacts and notes before publishing. It does not replace existing releases.
Bump the version for the next release. The inherited signed, cross-platform release workflow
is restricted to the original repository; its signing secrets and Homebrew tap belong upstream.

Personal macOS builds are ad-hoc signed and **not Apple-notarized**. They are suitable for the
existing local installation but do not promise Gatekeeper acceptance on another Mac. A public
notarized distribution requires Omar’s Apple Developer ID and notarization credentials; none
are borrowed from upstream. This initial fork release supplies macOS arm64 only. The website source remains the original
project’s marketing site; the fork does not deploy or advertise it as a fork download page.

Check upstream changes before importing them. Retain upstream commit ancestry where possible,
resolve conflicts against the fork’s behavior, rerun affected checks, and bump the personal
release version. Do not reset the fork to upstream or overwrite its default branch history.
