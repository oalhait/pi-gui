Omar’s personal pi-gui distribution, based on Matthew Lam’s MIT-licensed pi-gui.

- Browser pages live directly in the workbench tab row, with no nested browser tabs.
- Browser pages persist per chat across restarts. Website logins persist in a shared browser profile.
- App-wide back/forward navigation, responsive manual compaction, and composer focus fixes.
- Connected-provider usage limits in Settings and Mark as unread in chat actions.
- Updated Pi runtime and Electron engine.

The ZIP contains a macOS arm64 application. This personal build is ad-hoc signed, not
Apple-notarized. Existing local chats, settings and provider sign-ins use the same profile
locations. Back up the profile and retain the previous app before replacing an installation.

Upstream: https://github.com/minghinmatthewlam/pi-gui
Fork: https://github.com/oalhait/pi-gui
