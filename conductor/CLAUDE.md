# CLAUDE.md — Conductor scripts for Stealth Render Studio

## What this folder is

`/home/andrii/Documents/stealth-render-studio/conductor` holds the Conductor lifecycle
scripts. It is committed in the app repo (`conductor/`), but Conductor always calls the
scripts from the MAIN checkout by absolute path — the copies inside workspaces are unused.
`.state/` is gitignored by `conductor/.gitignore`.

App: Node 20 (asdf, tracked `.tool-versions`) / Express / Playwright (system Chrome via
`channel: 'chrome'` + Camoufox) / Postgres via `DATABASE_URL`. Config is ENV-only
(`lib/config.js`: `PORT`, `DATABASE_URL`, `PROFILE_FILE`, `UPLOAD_DIR`, `HOST`). Tables are
created by the app itself on startup (`initDb`), so setup only creates an empty DB.

Same shape as `/home/andrii/Documents/taxmate/scripts` (Ruby orchestration + docker-compose +
`.state` index registry); no Redis / MinIO here.

## Hard rules

1. **Never modify the app from the scripts** (tracked files, `.tool-versions`, `package-lock.json` — hence
   `npm ci`, never `npm install`; repo git config — setup only *reminds* about
   `core.hooksPath`).
2. **No git-visible change in a workspace.** Everything goes in as ENV; files written into a
   worktree are app-gitignored only (`node_modules/`, `profile.json`, `uploads/`) — check with
   `git check-ignore` before adding new ones. `setup` asserts `git status --porcelain` is empty.
3. **Scripts never commit or push.**
4. **One shared infra stack** (`stealth-cdt-postgres`, host 5437); isolation per workspace:
   DB `stealth_dev_<slug>`, port, profile.json, uploads/.

## Layout

| File | Role |
|------|------|
| `setup.sh` / `run.sh` / `archive.sh` | Wrappers: cd to workspace, asdf shims, `ASDF_RUBY_VERSION=3.4.8` (global Ruby is 2.5.8), exec the `.rb`. |
| `setup.rb` | asdf Node, compose up, create DB (+ optional seed), `npm ci`, copy main `profile.json`, Chrome/Camoufox check, git-clean check. |
| `run.rb` | Ensure Postgres + DB, run `node server.js` with workspace ENV, supervised (INT/TERM/HUP → TERM). |
| `archive.rb` | Drop the workspace DB (unless `CONDUCTOR_KEEP_DB=1`), release index. Best-effort. |
| `conductor_helpers.rb` | Naming, `.state` index, ports, `app_env`, docker/psql helpers. Derive values ONCE here. |
| `docker-compose.yml` | Shared Postgres 17. |
| `.state/` | `<slug>.port` index registry (gitignored). |

## Verified

2026-10-06, throwaway worktree: setup → DB created, `npm ci`, git-clean; run → `/health`
`db:true`, pool of 3 Chrome contexts ready on the workspace port; TERM → clean shutdown, no
leftover processes; `CONDUCTOR_SEED_FROM` copied presets; archive → DBs dropped, index released.
