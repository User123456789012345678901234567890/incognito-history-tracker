# Incognito History Vault

A Chrome extension (Manifest V3) that keeps a local, searchable history of what you browse in Incognito windows. Nothing leaves your machine; everything is stored in `chrome.storage.local`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open the extension's **Details** and enable **Allow in Incognito**.

## Changelog

### v1.0.2

**Import**

- The dashboard has a new **Import** button next to **Export**. It reads any file the extension exports: JSON (full backup with tab sessions), NDJSON or CSV.
- Imported visits are merged into the vault. Visits already stored are skipped, nothing is deleted, and your settings are not changed.
- Every imported record is checked first. Rows with a missing or non-web URL or a bad timestamp are skipped and counted.
- The entry cap and the retention setting apply right after the import, and a message shows how many visits were added, skipped or removed.
- Version bumped to 1.0.2.

### v1.0.1

**Reopen closed Incognito tabs and windows**

- The extension now remembers Incognito tabs you close, so you can reopen them after the Incognito window is gone.
- Closing a whole window saves all its tabs as one entry. **Restore window** reopens them together.
- Quitting Chrome (Cmd+Q) or a crash saves every open Incognito tab. At the next launch they show up as one **Browser quit** entry, and **Restore all** reopens each window.
- **Reopen last closed** reopens the most recent tab or window. The keyboard shortcut is **Alt+Shift+T** (Option+Shift+T on Mac). You can change it at `chrome://extensions/shortcuts`.
- Click any single tab inside a saved window to reopen just that tab.
- Tabs always reopen in Incognito: in their original window if it is still open, otherwise in another Incognito window or a new one.
- Recently closed respects the existing settings. Nothing is saved while recording is paused, the retention setting and "Clear data" also clear this list, and it keeps the newest 50 entries.

**Popup tab bar**

- The popup has a tab bar at the top: **History** (the same view as before) and **Recently closed** (the new list, with a count badge).

**Other**

- No new permissions.

### v1.0.0

- Initial release: Incognito visit logging, popup, dashboard with search, analytics, retention and export.
