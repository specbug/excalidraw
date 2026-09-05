# Integration manifest

Everything the hosting framework needs to know about this app. Nothing here is
applied by this repo: the app declares, the infra disposes.

The machine-readable form of this document is `deploy.yml` at the repo root,
which hostd reads. This file is the prose explanation; `deploy.yml` is what
actually takes effect, so keep them in agreement. The contract they both
follow is `SPEC.md` in the hostd repo.

## Identity

|                 |                                         |
| --------------- | --------------------------------------- |
| App name        | `draw`                                  |
| Compose project | `draw` (root `compose.yml`)             |
| Repo            | `git@github.com:specbug/excalidraw.git` |
| Deploy branch   | `master`                                |
| Public hostname | `draw.sixeleven.in`                     |

## Containers

| Service | Port (host:container) | Notes |
| --- | --- | --- |
| `api` | `8100:8100` | scene store; the health target |
| `web` | `3100:80` | static app + `/api/` proxy to `api:8100` |
| `cloudflared` | — | needs `CLOUDFLARE_TUNNEL_TOKEN` |

Ports were picked to avoid odyssey's `8000` / `3000`.

## Health

```
GET http://localhost:8100/health  ->  200 {"status":"ok"}
```

`api` already declares a compose `healthcheck` against it (30s interval, 3 retries, 20s start period), and its image ships `curl` for that.

## Secrets

Root `.env`, gitignored. See `.env.example`.

| Var | Source |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | Zero Trust -> Networks -> Tunnels -> tunnel `draw` |

## Cloudflare

- Tunnel ingress: `https://draw.sixeleven.in` -> `http://web:80`
- **Access application required on that hostname.** The app has no authentication of its own. Do not publish the hostname without it, and do not expose port `3100` beyond the LAN.

## State to back up

One named volume, declared globally (`name: draw-data`, no project prefix) so another compose project can mount it:

| Path in volume | Contents | Suggested job |
| --- | --- | --- |
| `scenes/` | one `.excalidraw` file per drawing | `sync` |
| `files/` | pasted-image blobs, content-addressed | `sync` |
| `meta/` | listing cache, derived | skip — rebuilt on miss |

Mount read-only. Nothing here is a database, so no hot-backup step is needed; a directory mirror is sufficient and complete.

## Build cost

The image builds from source: yarn install + vite build, several minutes, and it must fit the podman VM's memory (see `CLAUDE.md` on the sourcemap opt-out). Size the deploy timeout accordingly.

## What this repo does NOT do

No LaunchAgent, no watchdog script, no supervisor, no deploy registration.
Those belong to the hosting framework, and under hostd they genuinely do:
onboarding this app required no per-app code anywhere, only `deploy.yml` here
and one line in hostd's registry.
