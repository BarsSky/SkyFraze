# Running and operations

[Русский](run.md) · **English**

> This is the English version of the operations guide. The design notes under `docs/` are in Russian
> (the project's working language); the user-facing documents exist in English: this file and
> [features.en.md](features.en.md).

Everything you need to bring an installation up, set up access, update it and know what lives where.
The short version is in `README.md`; here are the full steps and the caveats.

## Contents

* [Quick start with Docker (production-like)](#quick-start-with-docker-production-like)
* [Running without Docker (dev mode)](#running-without-docker-dev-mode)
* [Administration and registration mode](#administration-and-registration-mode)
* [Public feed](#public-feed)
* [Project trash](#project-trash)
* [Errors in the interface](#errors-in-the-interface)
* [Moving a project between installations](#moving-a-project-between-installations)
* [Deploying on a server](#deploying-on-a-server)
* [Repository structure](#repository-structure)
* [Environment variables](#environment-variables)
* [Tests](#tests)
* [Panel audit](#panel-audit-frontendtestsaudit)
* [Storage on the server](#storage-on-the-server)

## Quick start with Docker (production-like)

```bash
# 1. Clone together with the submodule: deps/scroll-world holds the reference scroll
#    engine (used as a guide to composition, it is not imported into the build)
git clone --recurse-submodules https://github.com/BarsSky/SkyFraze.git
cd SkyFraze

# 2. Copy the env template and fill in JWT_SECRET
cp .env.example .env
# (on dev the default can stay, but in production 32+ bytes are mandatory)

# 3. Build and bring up the whole stack
docker compose up --build -d

# 4. Open the UI
open http://localhost      # macOS
# or xdg-open http://localhost / just type it into the browser
```

If the repository is already cloned without submodules: `git submodule update --init --recursive`.

After `docker compose up`:
- **Frontend** (UI + nginx proxy): http://localhost (port 80)
- **Backend** (Go API): internal :8080 (reachable only through nginx)
- **Postgres**: localhost:5432 (`skyfraze` / `skyfraze_dev` — for local debugging)

Health check:
```bash
docker compose ps            # all 3 services must be healthy
curl http://localhost/api/health   # {"status":"ok"}
```

Stopping:
```bash
docker compose down          # stop
docker compose down -v       # stop and delete volumes (DATA LOSS)
```

## Running without Docker (dev mode)

```bash
# Postgres (via docker)
docker compose up postgres -d

# Backend
cd backend
export DATABASE_URL="postgres://skyfraze:skyfraze_dev@localhost:5432/skyfraze?sslmode=disable"
export JWT_SECRET="dev-secret"
export CORS_ORIGINS="http://localhost:5173"
export STORAGE_DIR="./storage"
go run ./cmd/server

# Frontend (in another terminal)
cd frontend
npm install
npm run dev   # Vite will serve on http://localhost:5173
```

## Administration and registration mode

By default an installation is **closed**: you cannot sign yourself up, access is granted
on request. Open registration is a deliberate decision by the administrator.

### What is set at deployment

```bash
# .env (see .env.example)
ADMIN_EMAILS=you@example.com          # administrators (comma-separated)
REGISTRATION_MODE=request             # request (by request, default) | open (free)
```

| Variable | Meaning |
|---|---|
| `ADMIN_EMAILS` | Who is an administrator. Rights are granted to those already registered **and** to those who register later (checked on login). Empty list → the first registered user becomes the administrator (a warning is written to the log) |
| `REGISTRATION_MODE` | The starting mode until the administrator changes it in the interface. After the admin's first decision the env value no longer applies — otherwise a deployment would override a human decision |

### What the administrator does

`/admin` (the link appears in the header for an administrator):

- switches the mode: **"By request"** («По заявке») ↔ **"Free"** («Свободная»);
- sees requests (pending / approved / rejected), approves and rejects them;
- sees the list of users of the installation.

An administrator **does not get access to the contents of other people's projects** — their remit is
entry into the installation only.

### How a request works

1. A person fills in the form on `/register`: name, email, **password** and why they need access.
2. The password is stored as a hash right away, no account is created — the request gets the status `pending`.
3. Until a decision is made, login returns a clear `403`: "the request has not been approved yet"
   («заявка ещё не одобрена») (a request is found by email and password, so a stranger learns nothing from an email alone).
4. The administrator approves — the account is created and the person logs in **with the password
   they gave when applying** (no email links needed). A rejected request explains the refusal.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/auth/config` | anonymous | current registration mode for the form |
| POST | `/api/auth/registration-requests` | anonymous | submit a request (202) |
| GET | `/api/admin/settings` | admin | mode, counters |
| PATCH | `/api/admin/settings` | admin | `{"registration_mode":"request"\|"open"}` |
| GET | `/api/admin/registrations?status=pending` | admin | list of requests |
| POST | `/api/admin/registrations/{id}/approve` \| `/reject` | admin | decision |
| GET | `/api/admin/users` | admin | users of the installation |

## Public feed

A project appears in the feed **only after an explicit action by its owner**: in the project list
the "Publish" («Опубликовать») button. Until then it is invisible to everyone outside the team — including by link.

```bash
# publishing / unpublishing (project owner only)
curl -X POST http://localhost/api/projects/<id>/publication \
  -H "Authorization: Bearer <access>" -H 'Content-Type: application/json' \
  -d '{"is_public":true}'

# feed and public story — without authorization
curl http://localhost/api/public/feed?sort=new
curl http://localhost/api/public/stories/<slug>
```

| What | How |
|---|---|
| Feed | `GET /api/public/feed?sort=new\|rating\|views` |
| Story | `GET /api/public/stories/{slug}` (+1 view, deduplicated by the `sf_vid` cookie) |
| Rating | `POST /api/public/stories/{slug}/rating` `{"stars":1..5}` (login required) |
| Remove a rating | `DELETE /api/public/stories/{slug}/rating` |
| Public files | `GET /api/public/assets/{id}` — published projects only |
| Publication | `POST /api/projects/{id}/publication` — owner only |

Constraints built into the model: everything is closed by default; unpublishing
also closes the story and its files (404); the `slug` link does not change between publications;
the public endpoints contain not a single operation that writes to story content.

## Project trash

Deleting a project **does not erase the manuscript**. The "Delete" («Удалить») button moves the project to the trash,
where it stays for 30 days: during that time it can be restored with all its contents, and once the term expires
the background cleanup removes it for good (the same process that sweeps orphaned files).

What is worth knowing:

- while a project is in the trash it is **invisible to everyone** — to the owner in the list, to the team by
  direct link, to readers in the public feed. "Deleted" does not mean "hidden from myself,
  left to my co-authors";
- **only the owner can restore it**: the trash is personal, not a shared bin;
- the restore is **complete**: events, attachments and version history were never deleted, and the files in
  storage stay in place until permanent deletion;
- "Delete permanently" («Удалить навсегда») is a **separate button** and only for a project in the trash: an irreversible
  action must not be done by the same click as a reversible one. The files go away together with the
  project (unless another project references them — attachments are deduplicated);
- the trash shows the **weight of the project's files** (how much space will be freed) and a **"Download
  archive"** («Скачать архив») button: you can save a project before irreversible deletion without returning it to the list —
  "you may delete it but not look at it" is not acceptable. The right is the same as for restoring: owner
  only;
- the retention term is a single constant for the server, the interface and the cleanup (`projects.TrashRetention`),
  so that "30 days" cannot drift apart between the three places.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/projects/trash` | login | deleted projects: `id`, `title`, `description`, `deleted_at`, `days_left`, `asset_bytes` and `retention_days` |
| GET | `/api/projects/{id}/export` | owner of the trashed project | project archive, including from the trash (without returning it to the list) |
| DELETE | `/api/projects/{id}` | owner | to the trash (a second click is not an error) |
| POST | `/api/projects/{id}/restore` | owner | restore from the trash (204) |
| DELETE | `/api/projects/{id}/purge` | owner | delete permanently, only from the trash (204; an active project — 404) |

```bash
# what is in the trash and how much longer it can be restored
curl -H "Authorization: Bearer <access>" http://localhost/api/projects/trash

# restore
curl -X POST -H "Authorization: Bearer <access>" \
     http://localhost/api/projects/<id>/restore

# delete for good
curl -X DELETE -H "Authorization: Bearer <access>" \
     http://localhost/api/projects/<id>/purge
```

## Errors in the interface

There are no raw exceptions in the UI: any loading error is shown as a **banner** with a plain-language
explanation, a "Retry" («Повторить») button (for temporary failures) and a link to a reachable
page — "← To the feed" («← В ленту»), "My projects" («Мои проекты»), "To the projects" («К проектам»). Error classification lives in
`frontend/src/lib/apiError.ts` (no connection / timeout / 5xx / 401 / 403 / 404 / 409),
the component is `frontend/src/components/ErrorBanner.tsx`.

Public requests are retried automatically (`retry` in `src/api/feed.ts`), and the story
gets a longer timeout: the response carries a CRDT snapshot, while restarting the container for
a few seconds breaks the connection.

## Moving a project between installations

A project can be moved wholesale from one SkyFraze to another: in the project list the
**"Export"** («Экспорт») button downloads a `*.skyfraze.zip` archive, and the **"Import project"** («Импорт проекта») button on another
installation creates a new project from it. The archive carries all the contents:

| What is inside | What it is for |
|---|---|
| `manifest.json` | format, version, title/description, event tree (id, parent_id, position, depth, title, body, event_date), list of attachments |
| `state.bin` | CRDT snapshot: frame texts, background (tone/image), attachment bindings — what is not in the relational model |
| `assets/<id>` | the attachment files themselves (images, PDF, audio) |

```bash
# download the archive (a token is needed: this is a private project)
curl -H "Authorization: Bearer <access>" -OJ http://localhost/api/projects/<id>/export

# upload on another installation — a new project is created for whoever uploaded it
curl -H "Authorization: Bearer <access>" -F "file=@project.skyfraze.zip" \
     http://other-host/api/projects/import
```

What is worth knowing:

- **an import always creates a new project** for the uploader (who becomes the owner), and
  never writes into an existing one;
- **event and attachment identifiers are kept as they are** — the CRDT snapshot references
  them, and rewriting a binary Yjs update without a Yjs parser is impossible. That is why
  uploading the same archive into the same database again is detected and rejected (`409`
  "this archive has already been imported" («этот архив уже импортирован»)): delete the previously imported project or upload on
  another installation;
- only the project's contents are transferred. Views, ratings and publication are properties of the
  installation, not of the project: on a new installation the project arrives **closed**;
- limits: archive up to 200 MB, a single file up to 50 MB, up to 5000 events and 500 attachments
  (nginx allows 256 MB — see `frontend/nginx.conf`);
- export is available to the `viewer` role and above (a reader already sees the whole project content),
  import is available to anyone logged in.

A project that has no CRDT snapshot (created through the API or arrived from such an archive)
is seeded from the relational tree the first time it is opened in the editor — otherwise the stage
would consider it empty.

## Deploying on a server

For a server there is a separate compose file — it does not publish Postgres to the outside and lets you
set the UI port:

```bash
# on the server, in the project directory
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_EMAILS=you@example.com      # administrator(s) of the installation
REGISTRATION_MODE=request         # by request (default) | open
SKYFRAZE_PORT=80                  # the port the UI is opened on
CORS_ORIGINS=http://<host-address>
EOF

docker compose -f docker-compose.prod.yml up -d --build
```

Why a separate file rather than `docker-compose.yml`: the dev version publishes `5432:5432`, and on
a server that already has a system Postgres (or mailcow) the container simply will not come up
because the port is taken. On a server the database is reachable only by the backend over the internal network.

### First login: how an administrator appears

An installation is closed by default: outsiders register only by request. So that this does not
block a deployment, direct registration is allowed in three cases:

1. the `open` mode — the administrator decided so;
2. **the installation is empty** — whoever registers first creates it and becomes
   the administrator (the registration page says so: "First administrator" («Первый администратор»));
3. the email is in `ADMIN_EMAILS` — an administrator appointed by the deployment creates
   their own account regardless of the mode and gets the rights immediately.

After that everyone else goes through a request: `POST /api/auth/registration-requests`,
the decision is made in `/admin`. The full procedure for the mode and requests is in the section
"Administration and registration mode".

### Managing a deployed installation

```bash
cd /path/to/skyfraze
docker compose -f docker-compose.prod.yml ps        # status
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml up -d --build   # update after copying a new version
docker compose -f docker-compose.prod.yml down      # stop (data stays in volumes)
```

A check that the installation is alive (can be run from any machine that has Node):

```bash
cd frontend && DEPLOY_URL=http://192.168.13.66 npx tsx tests/deployed-smoke.ts

# A check of the mobile scenario on a deployed installation (insecure context,
# event creation, menu and editor buttons). Needs a temporary user:
# open registration is temporarily enabled on the installation, then the user is deleted.
cd frontend && REMOTE_URL=http://192.168.13.66 TEMP_EMAIL=you@example.com npx tsx tests/remote-mobile-check.ts
```

**The HTTPS scenario locally** (`deploy/tls-proxy/Caddyfile`): the same `remote-mobile-check.ts`
against `https://fraza.localtest.me:8443`. It is needed because on `localhost` the browser considers
the context trusted and does not block `ws://` from an `http(s)://localhost` page — the "realtime is silent
because the page is served over HTTPS" defect simply does not reproduce there. The launch commands
are in the comments inside `Caddyfile` (`tls internal`, WebSocket without changes,
`docker network connect skyfraze_skyfraze-net sf-tls`).

### Updating the installation from GitHub

The **"Update"** («Обновление») section in `/admin` shows the current version and the latest release of the repository,
can check for updates and file a request to apply one.

How this works (and why not "a button with docker.sock"):

```
admin UI  ──POST /api/admin/update──►  update-state/request.json   (directory shared with the host)
                                              │
systemd skyfraze-update.path sees the file ───┘
        │
        └─► deploy/skyfraze-update.sh: git fetch → checkout of the tag → docker compose up -d --build
                     │
                     └─► update-state/status.json + update.log ──► the admin UI shows progress
```

The application runs in a container, while the sources and compose live on the host, so the rebuild is
done by the host: the web process does not need `docker.sock` (which would be root on the host).

```bash
# 1. Release source (in .env on the server)
UPDATE_REPO=BarsSky/SkyFraze     # owner/name; empty → the section says the source is not configured
# UPDATE_TOKEN=...               # only for a private repository / API limits
UPDATE_CHANNEL=stable            # stable ignores pre-releases

# 2. Applier: script + systemd units (once, on the host)
sudo bash deploy/install-update-units.sh /path/to/project

# 3. Check manually without waiting for the admin UI
sudo deploy/skyfraze-update.sh            # up to the latest tag
sudo deploy/skyfraze-update.sh v0.2.1     # up to a specific version
tail -f update-state/update.log
```

A requirement for the installation: the project directory must be a **git clone** (`.env` and `update-state/`
are in `.gitignore`, so an update does not touch them). If the installation was deployed by copying
files, initialise the repository once:

```bash
cd /path/to/project
git init -b master && git remote add origin https://github.com/BarsSky/SkyFraze.git
git fetch --tags origin && git checkout -f -B master origin/master
```

## Repository structure

```
SkyFraze/
├── backend/                      Go API
│   ├── cmd/server/               main.go
│   ├── internal/
│   │   ├── auth/                 JWT, register/login/refresh, registration mode, requests
│   │   ├── users/                profile, nicknames, resident bios and specialisations
│   │   ├── admin/                deployment admin UI: settings and requests
│   │   ├── update/               the mechanism that updates the installation from GitHub
│   │   ├── projects/             CRUD + ownership
│   │   ├── projecttemplate/      project template: types, cards, assistant settings
│   │   ├── teams/                invitations, roles
│   │   ├── coauthors/            creative circle: requests, specialisations, read access
│   │   ├── people/               resident directory
│   │   ├── feed/                 public feed: publication, views, ratings
│   │   ├── assets/               upload/download (filesystem or S3) + public serving
│   │   ├── media/                image recompression to WebP (PNG lossless, JPEG lossy)
│   │   ├── maintenance/          storage size report and orphaned file cleanup
│   │   ├── events/               frame tree, Yjs binary state persistence
│   │   ├── versions/             project history snapshots and restore
│   │   ├── comments/             frame discussion: threads, `@nickname`, reactions, anchors
│   │   ├── entities/             world cards: mentions, links, types
│   │   ├── chat/                 the project's shared chat (and Nestor in it)
│   │   ├── notify/               emails: comments and chat messages, with the person's consent
│   │   ├── collab/               WebSocket hub, presence
│   │   ├── storage/              ObjectStore interface + LocalStore
│   │   ├── transfer/             archive and Markdown export/import (including pasting "in place")
│   │   ├── docxtpl/              DOCX formatting template: parsing, style map, example
│   │   ├── ai/                   AI assistant: model providers, keys, consents
│   │   ├── assistant/            the AI assistant inside a project: tools, conversations, limits
│   │   ├── ratelimit/            login and request rate limiters
│   │   ├── store/                typed pgx queries
│   │   └── platform/              config, logger, db pool, migrate
│   ├── migrations/                SQL schema (versioned: schema_migrations, idempotent 0001+)
│   ├── Dockerfile                multi-stage Go build
│   └── .dockerignore
├── frontend/                     Vite + React + TypeScript
│   ├── src/
│   │   ├── pages/                LoginPage, RegisterPage, ProjectsPage, ProjectTimelinePage, FeedPage, PublicStoryPage, AdminPage, ...
│   │   ├── components/timeline/  the stage: TimelineStage, timelineModel, publicDoc, stage/* (Sky/Scene/Copy/Route/Chips/TopBar)
│   │   ├── components/editors/   editors: EditorsPanel, EventEditor, BackgroundPicker
│   │   ├── components/entities/  "Links" («Связи»): cards, graph, matrix, mentions, suggestions
│   │   ├── components/chat/      the project's shared chat window
│   │   ├── components/docx/      DOCX markup and template help
│   │   ├── components/versions/  the "Versions" («Версии») window
│   │   ├── components/assistant/ floating AI assistant: AssistantDock (button + window), AssistantPanel (chat and settings)
│   │   ├── components/           RatingStars — rating of a public story
│   │   ├── styles/               tokens.css (themes), timeline.css, editors.css, feed.css, assistant.css
│   │   ├── lib/                  formatting (views/ratings, Russian declensions)
│   │   ├── collab/               Yjs provider, event tree, mention lookup
│   │   ├── store/                Zustand auth + theme
│   │   └── api/                  REST + WS clients (including api/feed.ts)
│   ├── tests/                    e2e (Playwright), data for the audit (audit/) and live checks — see docs/diagnostics.md
│   ├── nginx.conf                 SPA fallback + /api proxy
│   ├── Dockerfile                multi-stage Vite build → nginx serve
│   └── .dockerignore
├── docs/                         decision write-ups: what was asked, why it is like this, what was verified
│   ├── run.md                    this document: running, deployment, tests, storage
│   ├── features.md               the complete list of platform capabilities
│   ├── architecture.md           data model, invariants, analysis of frequent defects
│   ├── entity-links.md           world cards: mentions, links, matrix, risks
│   ├── entity-types.md           custom card types and presets
│   ├── entity-graph-navigation.md  the link graph: groups, drill-down, search by labels
│   ├── comments.md               frame discussion (threads, `@nickname`, reactions, notes on a fragment)
│   ├── fragment-comments.md      notes on a selected text fragment
│   ├── project-chat.md           the project's shared chat, Nestor in the chat, notifications
│   ├── import-export.md          the format of the md export and import (including attachments)
│   ├── import-export-folders.md  folder import: files on disk → frames and attachments
│   ├── docx-template.md          the DOCX formatting template: placeholders, style map, help
│   ├── realtime-editor.md        phases of realtime editing and their checks
│   ├── versions.md               project version history: when a snapshot is taken, how to restore
│   ├── security.md               the security model: rights, tokens, passkeys
│   ├── webauthn.md               passkeys (WebAuthn): registration, login, recovery
│   ├── storage-compression.md    what takes up space on the server and how to reduce it
│   ├── storage-s3.md             the S3/MinIO plan: what it gives, what it breaks, what it costs
│   ├── backups.md                backups: what is copied, the schedule, restoration
│   ├── ai-assistant.md           the AI assistant plan: tools, providers, keys
│   ├── diagnostics.md            a catalogue of live checks and diagnostic scripts
│   └── screenshots/              images for README.md
├── deps/scroll-world/            git SUBMODULE oso95/scroll-world — a reference for the composition
│                                 of the stage and the scrolling mechanics (not part of the build)
├── deploy/                       scripts and systemd units for the update and backup mechanisms
├── LICENSE                       Apache-2.0: what you may do with the code (see README)
├── NOTICE                        attribution notices that travel with the product
├── THIRD-PARTY-NOTICES.md        third-party component licences and what to include when distributing
├── licenses/                     full texts of third-party licences: EPL-2.0, LGPL-3.0,
│                                 summaries for Go modules and npm packages (see THIRD-PARTY-NOTICES.md)
├── docker-compose.prod.yml       the server configuration (see "Deploying on a server")
├── docker-compose.yml            postgres + backend + frontend (local development)
├── .github/workflows/            ci.yml (5 jobs: backend, frontend, storage-s3, e2e, build) and nightly.yml (audit + flakes)
├── .env / .env.example           JWT_SECRET, ADMIN_EMAILS, REGISTRATION_MODE and so on
└── vendor/scroll-world-reference/  a local copy of the reference (not part of the repository, /vendor/)
```

## Environment variables

| Variable | Purpose | Default in compose |
|---|---|---|
| `JWT_SECRET` | secret for signing access/refresh tokens | required (no default) |
| `ADMIN_EMAILS` | deployment administrators (comma-separated) | empty → admin = the first registered user |
| `REGISTRATION_MODE` | initial registration mode: `request` \| `open` | `request` |
| `DATABASE_URL` | Postgres DSN | `postgres://skyfraze:skyfraze_dev@postgres:5432/skyfraze?sslmode=disable` |
| `CORS_ORIGINS` | comma-separated list of origins for CORS | `http://localhost` |
| `STORAGE_DIR` | directory for assets (filesystem) | `/app/storage` (volume) |
| `ASSET_QUOTA_BYTES` | limit on the total size of a project's attachments (after recompression); 0 — no limit | `10485760` (10 MiB) |
| `AI_ENABLED` | the AI assistant inside a project (see `docs/ai-assistant.md`); off by default | `false` |
| `AI_OLLAMA_URL` | a local model server (Ollama): local models work without a key and without the internet; cloud ones (`:cloud`) are computed on ollama.com and require consent | empty |
| `AI_OLLAMA_NUM_CTX` | an explicit context size for an Ollama-like server; without it llama.cpp falls into an endless model reload loop | `0` (do not set) |
| `AI_OPENAI_COMPAT_URL` | your own OpenAI-compatible server (llama.cpp, vLLM, a gateway). No key is needed unless the server itself requires one | empty |
| `AI_OPENAI_COMPAT_LOCAL` | treat that server as your own (it computes on your machine or in your network): no consent for sending text is asked | `false` |
| `AI_SECRET_KEY` | encryption key for user keys (32 bytes, hex/base64). Empty — user keys are disabled | empty |
| `AI_DEFAULT_MODEL` | the default model in the interface (`provider:model`) | empty |
| `AI_MAX_TOOL_CALLS` | how many tools the model may call for one message | `10` |
| `AI_IMAGE_URL` | an A1111-compatible illustration generator (Automatic1111, Forge, SD.Next); empty — no generation | empty |
| `AI_IMAGE_NEGATIVE` | the INSTALLATION-wide negative prompt: since 0.105.0 a project may have its own, and it takes precedence over this one | empty |
| `AI_IMAGE_MODEL` `AI_IMAGE_STEPS` `AI_IMAGE_AUTOLOAD` | the generator model, the number of steps, whether to load an unloaded model ourselves | empty / `0` / `false` |
| `AI_TIMEOUT_SECONDS` | the limit for a single request to the model | `120` |
| `AI_TOKENS_PER_DAY` | the token budget per person per day (`0` — no limit); usage is always visible in the assistant window | `0` |
| `VERSIONS_INTERVAL_MINUTES` | how often the server takes an automatic snapshot of a project version (`docs/versions.md`) | `5` |
| `VERSIONS_KEEP` | how many versions to keep per project (`0` — no limit on the count) | `100` |
| `VERSIONS_MAX_MB` | limit on the total size of version snapshots per project, MiB (`0` — no limit) | `32` |
| `STORAGE_DRIVER` | where attachments live: `local` (disk) or `s3` (`docs/storage-s3.md` §11) | `local` |
| `S3_ENDPOINT` `S3_BUCKET` `S3_PREFIX` `S3_REGION` `S3_KEY` `S3_SECRET` `S3_USE_SSL` | S3/MinIO access when `STORAGE_DRIVER=s3`; the keys in the bucket are the same as they were on disk | — |
| `AUTH_RATE_PER_MINUTE` | the attempt limit on the public login endpoints per client address (`0` — disable, `docs/security.md`) | `30` |
| `AUTH_LOGIN_PER_EMAIL_PER_MINUTE` | the login attempt limit for a SINGLE account (`0` — disable) | `5` |
| `NOTIFY_SMTP_HOST` `NOTIFY_SMTP_PORT` `NOTIFY_SMTP_USER` `NOTIFY_SMTP_PASS` `NOTIFY_SMTP_TLS` `NOTIFY_FROM` | mail for emails about new comments; empty — mail is off, notifications only in the interface (`docs/comments.md` §5.2) | empty / `587` |
| `NOTIFY_INTERVAL_SECONDS` | how often to walk the outgoing email queue | `60` |
| `APP_BASE_URL` | the installation address for links in emails; empty — an email without a link | empty |
| `LISTEN` | backend bind address | `:8080` |
| `APP_ENV` | environment marker | `production` |

Installation-wide keys for hosted providers are needed only if you yourself pay for the model
for everyone: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`,
`CUSTOM_AI_API_KEY` (for your own gateway from `AI_OPENAI_COMPAT_URL`). Without them the
local model and the users' own keys work — a user's key takes precedence over the installation
key. They are set in `.env` (compose passes them into the container), empty values are harmless.
After editing `.env` you need `docker compose -f docker-compose.prod.yml up -d --force-recreate backend`
(and the same for `postgres` if you changed its variables). Plain `up -d` may answer
"Container … Running" and **not recreate** the container: compose does not always treat a change
of values in `.env` as a reason to recreate, and then the new settings are silently not applied —
verified on `S3_*` and `NOTIFY_*`. The sign that it did not apply: `docker compose exec backend
printenv STORAGE_DRIVER` is empty, and the log has no line about storage. The compose file itself
comes from the repository and is overwritten by an update, while `.env` is not touched by an update,
which is why all installation settings live exactly there.

The model server address does not have to be set in `.env`: every user adds their own
servers right in the assistant window ("Settings" («Настройка») → "Your model servers" («Свои серверы моделей»), up to 5 per person,
`GET/POST/DELETE /api/ai/endpoints`). A user's server becomes an ordinary provider with the
identifier `own:<uuid>`; the key for it (if the server requires one) is stored as ciphertext in
the same record and requires a configured `AI_SECRET_KEY`. The `AI_OLLAMA_URL` /
`AI_OPENAI_COMPAT_URL` variables remain for a server shared by the whole installation. Details and an analysis
of the trade-off with local addresses — `docs/ai-assistant.md` §3.9.

## Tests

```bash
# Backend unit + integration (Postgres is needed; the feed integration tests
# create their own database <TEST_DATABASE_URL>_feed and apply migrations themselves)
cd backend && go test ./...

# Frontend unit
cd frontend && npm test

# Attachment storage: the ObjectStore contract is run against BOTH implementations — on disk
# (always) and against a real S3 (if S3_TEST_ENDPOINT is set; in CI that is a separate job).
# A ready-made docker launch of the server and exactly what is checked — docs/storage-s3.md §12.
cd backend && S3_TEST_ENDPOINT=http://127.0.0.1:9010 S3_TEST_ACCESS_KEY=confkey \
  S3_TEST_SECRET_KEY=confsecret S3_TEST_BUCKET=skyfraze-conformance \
  go test ./internal/storage/ -run Conformance -v

# Browser E2E (Playwright): registration on an empty installation, login,
# protected pages, project upload, scrolling, the assistant. Playwright starts Vite
# itself, and the backend must be running on :8181 (docker compose up or
# go run ./cmd/server) — that is what the proxy in frontend/vite.config.ts points at
cd frontend && npm run e2e

# The scenarios run in two projects: `install` (registration of the first administrator on
# an empty database) is declared first and in CI is NOT allowed to be skipped — the rest log in
# with the account it created. That is why the check "a clean installation has a
# first administrator" really runs instead of reporting "skipped".
#
# Run the same scenarios against an already running installation, without starting your own vite:
cd frontend && E2E_BASE_URL=http://localhost:5173 E2E_NO_SERVER=1 npx playwright test
```

**The registration mode for e2e is `request`, as in CI.** `install.spec.ts` checks exactly the first
registration of the installation owner: on an empty database the page is obliged to show "First administrator".
With `REGISTRATION_MODE=open` it says "Registration" («Регистрация») there, and the scenario fails — not because something
broke, but because the wrong thing was being checked. In `.github/workflows/ci.yml` this is written explicitly
(`REGISTRATION_MODE: request`), and a local run must repeat CI. The flip side: the database
for e2e must be **empty** — if there are already people in it, `install` honestly says "the installation is not
empty" and drags the remaining scenarios down with it.

**What e2e checks and where to get a database for it.** Twenty-eight scenarios: registration
of the first administrator, login, protected pages, file upload, scrolling, the assistant
(creating a chapter and an image), **agent edits with confirmation** (suggestion → apply
→ revert and reject), **deleting a frame by the agent and undoing it** (the frame disappears from the tree and
comes back into place), **search across the project text**, **frame discussion** (a comment
is written, is visible as a counter in the tree, survives a reload and is deleted), **DOCX markers**
(the "DOCX markup" («Разметка DOCX») panel inserts a page break and a table of contents, the text reaches the server — visible in
`export.md` — while the rendered view has no service lines), **mentions in a frame** (one chip per card,
a count of occurrences, "N more" («ещё N»), a second click leads to the next place) and the **email checkbox for
comments** (cleared by default), **version history** (save, preview,
restore), **the book** (downloading EPUB/DOCX with byte checks), **project trash**
(a deleted project disappears from the list, is restored from the trash with its term, is downloaded
as an archive and deleted permanently), **the bell** (visible in the header, no counter, the panel honestly
says "no new comments" («новых замечаний нет»), Esc closes it), **project chat** (a message survives
a reload, a mark is set and cleared, "show earlier" («показать прежние») loads history above),
**card chronology and moving by archive** (a frame with a mention is found and opened, and after
an export and an import the card is still linked to the text), **frame date by confirmation**
(the assistant suggests "date: no date → 2026-03-05", the date field is empty before confirmation, and after
"Apply" («Применить») the date appears in the editor without a reload, "Restore the previous date" («Вернуть прежнюю дату») clears it),
**moving a frame through the tree** (the frame sits nested, the assistant suggests "place: Prologue (Пролог) →
top level", and after "Apply" the frame really changes its level in the tree without a reload,
"Restore to the previous chapter" («Вернуть в прежнюю главу») puts it back),
**editing a fragment from a comment**
(the assistant's suggestion is shown as a "before → after" diff, is applied by a button and reverted by
"Restore the previous fragment" («Вернуть прежний фрагмент»); and if the person has already edited that same paragraph — a refusal in words rather than
a silent application) and **the passkey** (a real
WebAuthn ceremony through Chromium's virtual authenticator: registration in the profile, recovery codes,
login with the key at the second step, deletion).
Locally an empty database and a backend on `:8181` are needed:

```bash
docker exec skyfraze-postgres psql -U skyfraze -d postgres -c "create database skyfraze_e2e"
cd backend && go build -o /tmp/skyfraze-e2e ./cmd/server
DATABASE_URL=postgres://skyfraze:skyfraze_dev@localhost:5432/skyfraze_e2e?sslmode=disable \
JWT_SECRET=e2e-secret STORAGE_DIR=/tmp/skyfraze-e2e-storage LISTEN=:8181 \
CORS_ORIGINS=http://localhost:5173 AI_ENABLED=true AI_OLLAMA_URL=http://127.0.0.1:11490 \
AUTH_RATE_PER_MINUTE=0 AUTH_LOGIN_PER_EMAIL_PER_MINUTE=0 \
APP_BASE_URL=http://localhost:5173 REGISTRATION_MODE=request \
  /tmp/skyfraze-e2e &                       # + stub: node frontend/tests/e2e/stub-ollama.mjs
cd frontend && CI=1 npx playwright test    # CI=1 is mandatory, see below
```

**Why `APP_BASE_URL` is needed here too.** Passkeys (WebAuthn) are enabled only when the public
address is known: the RP ID and origin are taken from it, not from the request header. In e2e
that is the vite address — then the RP ID is `localhost`, and Chromium's virtual authenticator in the
`zz-passkeys.spec.ts` scenario goes through a real ceremony. Without the variable the passkeys section in the profile
is hidden, and the scenario fails on "the backend is not configured" — which is exactly its check.

**Why the login limiter is disabled.** There are more than ten scenarios, and each one logs in **from the same
address and the same IP**. `AUTH_LOGIN_PER_EMAIL_PER_MINUTE` (5 by default) starts answering
`429` to a legitimate login, and the scenarios that fail are not all of them but "random" ones — with "wrong email or
password" in the markup, so the run looks unstable even though it is not. The limiter itself
is verified separately (`internal/ratelimit` and the auth integration tests); in
browser scenarios it is not the subject of a check but an obstacle. The same form is set in CI.

**A local-run trap:** `docker compose` publishes the frontend on `5173`, while Playwright
starts its own vite with `reuseExistingServer: !CI`. Without `CI=1` the scenarios silently go to the
docker frontend — that is, to a live installation: the tests "pass", and the data is written into someone else's database
(and the assistant does not answer from the stub). `CI=1` forces Playwright to start its own server.

**Another one, found on our own runs:** the full set assumes ONE fresh backend and
ONE empty database. If the database is not empty, `install.spec.ts` in CI honestly fails ("the installation is not
empty"), and then everyone who logs in with that account fails after it. If a second server lives next to the e2e backend
(for example from a previous run, or a docker installation on the same port),
the picture becomes random: some scenarios get "the server did not answer in time" («Сервер не ответил вовремя»), while the
markup of a failing one says "Wrong email or password" («Неверный email или пароль») with a correct password. The check before a run:
`curl -s localhost:8181/api/auth/config` must return `"bootstrap":true`, and
`Get-Process skyfraze-e2e` — exactly one process.

**Live checks and diagnostics.** The scripts in `frontend/tests/` are tools for a live installation, not
tests: they create projects, take screenshots and print numbers for a human, so they are not
run in CI (which only runs `go test ./...`, `npm test` and `npm run e2e`). A catalogue of all the scripts — one
sentence per script, saying what it measures and what it needs — is in `docs/diagnostics.md`.
The most used ones:

```bash
# screenshots FOR THE EYE: the "Project links" («Связи проекта») block and the "Login and devices" («Вход и устройства») profile, 1280 and 390 px
cd frontend && npx tsx tests/visual-entities.ts
cd frontend && npx tsx tests/visual-profile.ts

# the list of links in a card and its behaviour under load (20 links, 1280 and 360 px)
cd frontend && npx tsx tests/diag-entity-links.ts
cd frontend && npx tsx tests/diag-entity-links-load.ts

# renaming a card does not lose the links to the text; a measurement of mention recounting
cd frontend && npx tsx tests/diag-entity-rename.ts
cd frontend && npx tsx tests/diag-mentions-perf.ts
```

## Panel audit (`frontend/tests/audit/`)

The audit runner checks the **perception** of the interface and the **working order of every declared capability** on
a live installation: clipped text, elements outside the screen, overlapping/unreachable controls, small tap
targets, images that failed to load, low contrast, clicks intercepted by fixed layers, network errors, and
also the functional matrix (projects, hierarchy, assets, themes, roles/invitations, realtime CRDT).

```bash
cd frontend
npx tsx tests/audit/visual-audit.ts              # visuals + functions
ONLY_SCREENS=1 npx tsx tests/audit/visual-audit.ts    # visuals only
ONLY_FUNCTIONAL=1 npx tsx tests/audit/visual-audit.ts # functions only
```

Since 0.110.0 the runner lives in the project — `frontend/tests/audit/visual-audit.ts`, next to
`seed-project.ts`, which prepares its data. Before that it was in the agent skill directory
(`.dsh/skills/ui-visual-audit/`), where both CI and humans ran it, and the purpose of the file did not
follow from its path; the skill remains an instruction and points at the new path.

The report: `_audit_out/visual-report.md` (+ `.json`) with screenshots and a note of which file
to fix; the exit code is 1 if there are defects. The skill creates and deletes the test projects itself.

**Where to get a project for the audit.** The visual part needs an existing project with content
(the stage, the tree, "Links", the chat): without it the project screens are empty, and a "green" check means nothing.
On a dev installation that is a permanent project (`AUDIT_PROJECT=<id>`), while in CI it is created by
`frontend/tests/audit/seed-project.ts`: an account (in an empty database the first person is the administrator),
a project, a **Markdown import** with a chapter and two frames, two cards with a link, a chat message and
a publication. It prints ready-made `AUDIT_EMAIL`, `AUDIT_PASS`, `AUDIT_PROJECT_ID`:

```bash
cd frontend && npx tsx tests/audit/seed-project.ts | tee /tmp/seed.log
# then — put the script's output into the audit environment
```

**Why a Markdown import rather than `POST /events`.** That endpoint writes only the events table, while the stage
and the tree read the CRDT document: a project with "tabular" events opens as "the timeline is still
empty" («Таймлайн пока пуст»). The import goes the same way as the assistant (`LiveDoc` + `SetEventTextLive`), so the document
and the table agree. The script checks this itself — after an import the tree and the document must be
non-empty, otherwise it fails: the audit would otherwise silently run over empty screens (as happened in the first
nightly run).

## Nightly checks (`.github/workflows/nightly.yml`)

The audit and the flake hunt run **not in the blocking `ci.yml` but on a schedule** (01:00 MSK, that is
22:00 UTC of the previous day) and manually through `workflow_dispatch`. That way a layout failure does not
stop an urgent backend fix, and does not go unnoticed either: two runs in the build status,
the report as an artifact.

**What runs:**

| Job | What it does | Why |
|---|---|---|
| `unit-repeat` | `vitest run` three times | unit tests have one run and no retries: a single flake makes CI red, but the name of the unstable test cannot be seen from one failure |
| `audit` | a fresh Postgres + backend + a model stub + vite, `seed-project.ts`, then `visual-audit.ts`: first the screens (`ONLY_SCREENS=1`), then the functional matrix as a separate step (`ONLY_FUNCTIONAL=1`, the report in `_audit_out-functional`) | visual regressions (clipped text, an element beyond the edge, overlapping controls, contrast, small targets) used to be caught only by hand on a dev installation |
| `e2e-repeat` | two full e2e runs on **different clean databases** (the backend is restarted) | the second run catches randomness in the browser; a repeat on the same database is impossible: `install` checks the first registration, and a passkey hands out recovery codes only when the first key is registered |

The functional matrix has run **every night since 0.109.0**, as a separate step after the screens: before that
it was enabled only manually (`-f functional=true`), that is, in practice it did not run at all.
The steps are separate not for beauty: `visual-audit.ts` clears `AUDIT_OUT` on start, so in a single step the
screens report would disappear — that is why the matrix has its own directory (`_audit_out-functional`, both reports
travel as the `audit-report` artifact). To run everything by hand: `gh workflow run nightly.yml`.
The functional part checks what e2e does not have: the frame hierarchy `01 → 01.1 → 01.1.1`, the upload of
files of two sizes, image frames and full-screen viewing, the background tone, persistence after
a reload, themes, an invitation with the `viewer` role (and a `403` on writing), realtime in a second tab,
the public feed and archive import/export.
Since 0.104.1 it again reaches the end: before that it failed on the first check, because it had been written
before project sections became tabs.

**Why a fresh database and why `REGISTRATION_MODE=open` in `audit`.** The seeding script
registers the first account (in an empty database it becomes the administrator — otherwise there is nothing to open
the `/admin` screen with), creates a project, a chapter, two frames, two cards with a link and a chat message,
then publishes the project so that the audit also has public screens. On a dev installation (registration
closed) the script does not fail: it first tries to log in with an existing `AUDIT_EMAIL` account.

## Storage on the server

What takes up space and what to do about it step by step — `docs/storage-compression.md`.
The S3/MinIO plan (what it gives, what it breaks, why we are not doing it yet) — `docs/storage-s3.md`.
Project version history (snapshots along the way, "put it back as it was an hour ago" («верни как было час назад»)) — `docs/versions.md`.
Backups — `docs/backups.md`; in short:

```bash
bash deploy/backup.sh                 # a copy of the database and attachments into backups/<date>
bash deploy/backup.sh --drill         # verify that the copy restores
sudo bash deploy/install-backup-units.sh   # a daily timer (once, on the host)
bash deploy/install-backup-units.sh --user # the same without root (if sudo asks for a password)
cp deploy/backup.env.example backup.env    # offsite and retention: BACKUP_RSYNC /
                                           # BACKUP_RCLONE / BACKUP_KEEP
```

**Without offsite, copies do not save you from losing the machine:** `BACKUP_RSYNC` or `BACKUP_RCLONE`
must be set, otherwise the copies lie on the same disk as the data (the script writes about
this in the log every time). A timer with no offsite configured is still useful — it covers
"deleted the wrong project" and database corruption, but not a disk failure.

The size report is available in three ways:

- **the `/admin` page in the interface** — the "Storage" («Хранилище») section: the sizes of the database, the snapshots
  (and the heaviest projects by name), the projection text, the attachments and the file directory,
  any discrepancy between the directory and the database, and the "Remove extra files" («Убрать лишние файлы») and "Recompress images" («Пережать картинки»)
  buttons (a dry run first, applying is a separate button). The report is read when the page is
  opened: it only reads;
- an SQL script on the installation host:

```bash
# table sizes, snapshots (raw and TOAST-compressed),
# text duplication, heavy projects, attachment volume
bash deploy/storage-report.sh
```

- the API (the same as the screen does; useful in scripts):

```bash
curl -H "Authorization: Bearer $TOKEN" http://<installation>/api/admin/storage
curl -X POST -H "Authorization: Bearer $TOKEN" http://<installation>/api/admin/storage/sweep
# recompression of already uploaded images: without ?apply=1 — a dry run
curl -X POST -H "Authorization: Bearer $TOKEN" http://<installation>/api/admin/storage/recompress
```

Files are deleted together with the project, and once a day the server sweeps what is left of
deleted projects and interrupted imports (the quarantine is one day: a fresh file with no row in
the database may be the middle of someone else's import).

Identical files are stored once: an attachment has a content hash (SHA-256), and
if such a file is already uploaded in any project, it is not written a second time — the new
attachment row references the existing object. The name, owner and project of each row are
its own, and the file itself is deleted only with the last reference to it.

Images are recompressed to WebP: PNG — lossless (screenshots and diagrams with text must not be
damaged), JPEG — lossy (quality 82) and with the long side trimmed to 2560 pixels.
**HEIC from an iPhone is accepted too**: the server parses it with the `heif-convert` utility
(the `libheif-tools` package in the image) and then treats it as an ordinary JPEG — a 3200×2400
photo arrives as **148 KB instead of 5 MB (×35)**. If the utility is not in the image,
the server honestly refuses HEIC ("save it as JPEG" («сохраните как JPEG»)) rather than storing a file that
the browser will not show. From a phone, a 3200×2400 q92 photo arrives as JPEG at **161 KB
instead of 2 MB (×12.4)**. If recompression does not win or the file does not decode, it
stays as it is — recompression is an improvement, not a condition of acceptance. Already uploaded
images are recompressed in a separate pass:

```bash
# dry run: shows how much it would save, and writes nothing
curl -X POST -H "Authorization: Bearer $TOKEN" http://<installation>/api/admin/storage/recompress
# apply
curl -X POST -H "Authorization: Bearer $TOKEN" 'http://<installation>/api/admin/storage/recompress?apply=1'
```

Originals are not kept in the process: the page shows an image, it does not prepare it for
print. Details and measurements — `docs/storage-compression.md`.

**The per-project quota.** The limit on the total size of attachments is `ASSET_QUOTA_BYTES` (by default
**10 MiB**, `0` — no limit). It is counted by weight **after recompression**: an 8 MB photo from
a phone arrives as 300 KB and takes 300 KB. The editor panel shows
"Project files · 8.4 MB of 10.0 MB" («Файлы проекта · 8.4 МБ из 10.0 МБ»), and on a refusal the server explains it in words:
"9.4 MB of 10.0 MB is in use — a 1.2 MB file does not fit" («занято 9.4 МБ из 10.0 МБ — файл на 1.2 МБ не помещается»). Space is freed by
deleting a file (a button in the same list); a file attached to frames cannot be
deleted — `409` and a request to detach it first: the reference lives in the CRDT document.
