# Changelog

## 1.0.12

### Mobile Rendering and Layout

- Fixed theme variable scoping in the mirror (`:root` remapped to `:host`) so `--vscode-*` colors/icons render correctly inside Shadow DOM.
- Fixed Tailwind border baseline ordering so `.border` styles are no longer suppressed.
- Fixed oversized reaction controls by constraining thumb/good-bad button containers after context switches.
- Fixed icon-only SVG button fallback behavior so valid Lucide buttons are not replaced by text labels.
- Improved mirror layout by collapsing VS Code full-viewport flex stacks that caused large blank areas on mobile.
- Added placeholder suppression for virtualized message skeleton rows that produced empty scroll gaps.
- Fixed horizontal overflow in the mobile mirror while preserving code-block horizontal scrolling.
- Updated chip-row layout to wrap cleanly on narrow screens.
- Improved auto-scroll targeting to follow real mirror content height instead of blank flex space.

### Mode/Model Control Reliability

- Fixed mode/model chip update timing by reusing the latest snapshot immediately after click-forward events.
- Ensured mode/model chip metadata updates even while the user is scrolling.
- Improved menu panel selection so semantic mode/model matches always win over generic fallback panels.

### New Chips and Content Sheets

- Added `Stop` chip integration (when available from controls metadata) to trigger IDE stop-generation actions.
- Added persistent `Task`, `Walkthrough`, and `Plan` chips in the dock.
- Added a reusable bottom content sheet with title/body/close controls for rendered text content.
- Added markdown rendering for headings, lists, emphasis, inline code, and horizontal rules.
- Added snapshot-based prose extraction for task/walkthrough fallback content.
- Broadened in-snapshot plan detection and added cached fallback behavior.
- Improved 404 diagnostics for task/walkthrough retrieval with searched brain-directory paths.

### Server and Data Endpoints

- Added brain-file discovery sorted by most-recently-modified UUID workspace directories.
- Added `GET /task` endpoint for `task.md.resolved`.
- Added `GET /walkthrough` endpoint for `walkthrough.md.resolved`.
- Added `GET /plan` endpoint with ordered fallback lookup across resolved and non-resolved plan filenames.

### Asset Conversion and Icon Path Fixes

- Fixed local asset path regex matching for multi-character Windows path segments to stop unresolved icon fetches.
- Added normalization for `/C:/...` style Windows paths from VS Code icon URLs before file lookup.

## 1.0.11

- Fix: Resolved `SyntaxError` in snapshot capture script affecting connection.
- Fix: Improved error handling and diagnostics for mobile bridge.
- Fix: Ensure correct discovery of Antigravity UI targets.

## 1.0.10

- Fix: Resilient DOM selectors for message injection (fixes broken chat in Google update).
- Fix: Hide legacy UI elements (Review Changes, Mic, etc.) in mobile client via post-processing.
- Improved diagnostic probing for future rapid fixes.


## 1.0.9

- Correct repository and issue URLs in `package.json` and `CHANGELOG.md`.

## 1.0.8

- Fix: Resolved `EROFS: read-only file system` error on macOS by moving SSL certificate storage to the extension directory.
- Closes [#1](https://github.com/cafeTechne/antigravity-link-extension/issues/1).


- Add README badges and repository links.
- Add contributing note and improve discoverability.

## 1.0.2

- Update README demo image links to public URLs.

## 1.0.1

- Clarify Windows Start Menu launch path and multi-session requirements.
