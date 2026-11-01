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
