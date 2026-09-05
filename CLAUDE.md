# CLAUDE.md

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `yarn test:update` before committing
4. **Type Safety**: Use `yarn test:typecheck` to verify TypeScript

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:update     # Run all tests (with snapshot updates)
yarn fix             # Auto-fix formatting and linting issues
```

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration

---

# Self-hosting (draw.sixeleven.in)

This fork is deployed as a personal Excalidraw instance on a Mac mini, following the same pattern as `~/Documents/odyssey`. **`odyssey/CLAUDE.md` §_Reliability & Hosting_ is the canonical server runbook** — host config, launchd, podman gotchas and the recovery procedure all live there and are not repeated here.

## What was added on top of upstream

Upstream's OSS app keeps exactly **one** scene, in the browser, under fixed localStorage keys (`excalidraw-app/app_constants.ts`). There is no drawings list — multi-document is the paid Excalidraw+ product. This fork adds a thin persistence layer so drawings live on the server:

- **One drawing per URL.** `#d=<id>` opens that drawing; a bare root URL mints a new id and starts blank. Both are handled at the top of `initializeScene` (`excalidraw-app/App.tsx`), which takes only _appState_ from localStorage (theme, pen prefs) and never its elements, so a stale local scene can't flash.
- **`excalidraw-app/data/RemoteScenes.ts`** — the server counterpart to `data/LocalData.ts`. Same shape: a debounced `_save`, a `flushSave()`, an `isSavePaused()`. `LocalData` is deliberately left running underneath as a crash buffer and as the fast (IndexedDB) path for image blobs.
- **`excalidraw-app/components/DrawingsDialog.tsx`** — the drawings list.
- **`self-host/api/`** — the scene store. FastAPI, no database.

## Storage layout

Volume `draw-data`, named globally (no compose project prefix) so `backupd` can mount it:

```
/data/scenes/<id>.excalidraw   # one file per drawing, a valid .excalidraw
/data/files/<fileId>.json      # pasted-image blobs, content-addressed
/data/meta/<id>.json           # listing sidecar; derived, rebuilt on miss
```

These paths are inside the podman VM, **not** on the macOS filesystem — a named volume is not Finder-browsable. Reach them with `podman exec draw_api_1 ls /data/scenes`, through the drawings dialog, or via the R2 copy. Switching to a host bind mount (`- /Users/rishitv/Documents/draws:/data`) would put real files on the Mac, at the cost of diverging from the named-volume pattern odyssey and backupd use.

Scene files carry `files: {}` rather than embedding image blobs — otherwise every autosave tick would re-upload every pasted screenshot over the tunnel. `GET /api/scenes/{id}/download` inlines them back into a portable `.excalidraw`.

## Commands

```sh
podman compose up -d --build          # build + start (first build is slow)
podman logs -f draw_api_1
curl -fsS localhost:8100/health
podman exec draw_api_1 ls -la /data/scenes
podman compose down && podman compose up -d   # after a .env change
```

Local dev is unchanged (`yarn start`), except the app expects `/api` to answer. Run `podman compose up -d api` and proxy, or accept that saves fail loudly in the console.

## Ports

`8100` api, `3100` web. Chosen to avoid odyssey's `8000` / `3000`.

## Hosting integration

This repo is **the app**, not the hosting framework. It does not install LaunchAgents, define backup jobs, or register itself for deploys — that is `~/Documents/backupd` / `deployd`'s business.

What the app declares for the framework to consume lives in [`self-host/INTEGRATION.md`](self-host/INTEGRATION.md): app name, ports, health endpoint, required secrets, Cloudflare ingress, and which volume paths hold state worth backing up. Keep that file current when any of those change — it is the contract.

Host-level reliability (FileVault, auto-login, `pmset`, weekly reboot, podman gotchas) is documented in `odyssey/CLAUDE.md` under _Reliability & Hosting_, the canonical server runbook.

## Auth

There is **none in the app**. `draw.sixeleven.in` is gated solely by a Cloudflare Access application. Never expose the hostname without it, and never publish port `3100` beyond the LAN.

## Keeping up with upstream

```sh
git fetch upstream && git merge upstream/master
```

Only these files diverge from upstream; everything else is additive under `self-host/` plus three new files in `excalidraw-app/`:

| File | Change |
| --- | --- |
| `excalidraw-app/App.tsx` | `#d=` scene init, remote save, remote image fallback |
| `excalidraw-app/components/AppMainMenu.tsx` | "New drawing" / "All drawings…" |
| `excalidraw-app/index.html` | Simple Analytics tag removed (hardcoded, not env-gated) |
| `Dockerfile` | one `COPY self-host/nginx.conf` line |
| `.dockerignore` | allowlist entry for that file |
| `docker-compose.yml` | **deleted** — see below |
| `excalidraw-app/vite.config.mts` | `sourcemap` is opt-out via `VITE_APP_DISABLE_SOURCEMAP` |
| `excalidraw-app/package.json` | `build:app:docker` sets that var |
| `packages/excalidraw/components/JSONExportDialog.tsx` | rename field no longer hidden when the File System Access API is available |
| `packages/excalidraw/components/ImageExportDialog.tsx` | same |

Sourcemaps are off in the container build because it gets **OOM-killed** otherwise. The podman VM has 3.9GB and no swap, and also hosts odyssey and backupd; vite's `rendering chunks` step peaked at ~1.9GB RSS and was killed with no error message — a silent `exit 1` right after `✓ modules transformed`. If a future build starts dying there again, check `podman machine ssh 'sudo dmesg | grep -i oom'` before suspecting the code. deployd rebuilds this unattended, so the build has to fit in the VM.

`docker-compose.yml` had to go, not just be superseded. podman-compose reads _every_ default-named compose file in the directory and merges them, so keeping upstream's alongside `compose.yml` started its dev `excalidraw` service too — on port 3000, which odyssey's web container already owns. The watchdog and deployd both run bare `podman compose up -d`, so there has to be exactly one compose file here. Upstream's was a bind-mount dev convenience; local dev is `yarn start`.

The export-dialog pair matters too: upstream shows the project-name field only when `!nativeFileSystemSupported`, i.e. **never in Chrome**, because the OS save picker supplies the filename. Self-hosted, the name is the drawing's identity in the list, so it has to stay editable.

## What stays broken, on purpose

Live collaboration and shareable links both require Firebase (`excalidraw-app/data/firebase.ts`), which is not configured. The menu entries remain and will error if used.
