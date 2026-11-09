# Clearpage

**Live app:** https://page.thiepn.dev/

A quiet, distraction-free writing app. This repository hosts **Clearpage v1.1** as a single static HTML file; no build step, accounts, analytics, network APIs, or server-side storage are required.

## Use

Open the production URL, or download `index.html` and open it locally.

- Write immediately; add and switch between pages from the sidebar.
- Search titles and page contents with **Ctrl/Cmd + K**; use arrow keys and Enter to select a page.
- Create a page with **Ctrl/Cmd + Alt + N**, or cycle pages with **Ctrl/Cmd + Alt + Left/Right**.
- Recently deleted pages can be restored from Trash; immediate deletion also has Undo.
- Use Settings/Backup for JSON backup export and import.

## Storage and migration

Writing is stored **only in the current browser on the current origin**. Clearpage prefers IndexedDB, with recovery snapshots and emergency drafts, and explicitly reports reduced/failed persistence modes. Local backups remain important: clearing browser data, private browsing, quota eviction, or device failure may remove notes. The app does not sync between devices, browsers, or its downloaded file and hosted URL.

If migrating from a local `Clearpage.html`, **export a JSON backup in the old app** and import that backup into the hosted site. The hosted URL is a different browser storage origin.

## Deployment

Vercel Git integration builds the `main` branch as a static site. Serve `index.html` from the repository root without a framework or build command.

## Release

v1.1 adds robust local persistence and backup recovery, undo/recently deleted pages, instant page search, and keyboard-first page navigation while preserving the original minimalist editor.
