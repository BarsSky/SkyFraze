# SkyFraze

[Русский](README.md) · **English**

A web platform for invitation-based collaborative story development for games, film, animation and
books: a project is split into chapters and sub-events, every event is shown as a separate "frame" of
a staged timeline, and the finished story can be published publicly — with a feed, views and ratings.

| Staged timeline | Public feed |
|---|---|
| ![Timeline](docs/screenshots/timeline-light.png) | ![Feed](docs/screenshots/feed.png) |

| Administration | On a phone |
|---|---|
| ![Admin](docs/screenshots/admin.png) | ![Mobile view](docs/screenshots/mobile-project.png) |

| Co-authors and specialisations | Read-only for a co-author |
|---|---|
| ![Co-authors](docs/screenshots/coauthors.png) | ![Read-only](docs/screenshots/coauthor-readonly.png) |

| Markdown editor with live preview | Markup inside a timeline frame |
|---|---|
| ![Markdown editor](docs/screenshots/markdown-editor.png) | ![Markup in a frame](docs/screenshots/markdown-frame.png) |

## Features

The essentials; the full list, one item per feature, is in
**[docs/features.en.md](docs/features.en.md)**.

- **Staged timeline**: a fixed stage where scrolling switches frames; a chapter, then its sub-events
  one at a time (numbering 01.1, 01.1.1); event images are frames of their own.
- **Markdown in the text**: headings, lists, tables, formulas (KaTeX) and Mermaid diagrams; edited
  in the panel or in a separate window with live preview; raw HTML is not allowed.
- **"Project links" — character, place and theme cards**: grouped by kind and collapsible, aliases,
  mention counters in the text, chronology, a "who shares a chapter" matrix, an ego graph, links
  between cards and custom kinds.
- **AI agent "Nestor"** — a co-author of the project: chapters and sub-events through tools, its own
  name and its own member record, role and instructions set by the owner, streamed answers, its own
  model server.
- **Project-wide chat** with a "discussion / chat" switch: editing and replies, links to a frame with
  a quote, `@Nestor` (read-only access to the project), notifications and e-mail with consent.
- **Real-time collaborative editing** (Yjs/CRDT) with autosave, presence and "typing…".
- **Version history**: snapshots along the way and by button, restore to any of them with a preview.
- **Frame discussions**: threads, `@nick`, reactions, notes on a selected fragment, a bell.
- **The book as a file**: EPUB for readers and DOCX for editing in Word/LibreOffice — with **your own
  styling template** (style map, warnings, help and a sample template).
- **Export and import**: a project downloads as a `.md` feed or a zip with assets, and imports as a
  folder (folder = project, subdirectories = chapters) or "into place" of an existing project.
- **Teams and roles** (owner / editor / viewer), invitations, **co-authors** with specialisations, a
  **residents** catalogue, a public feed with views and ratings, a 30-day **trash**.
- **Deployment administration**: registration mode (by request by default), requests in `/admin`,
  access keys (WebAuthn), stand updates from GitHub Releases.
- Two themes, phone layout and a "full version" on tall narrow screens, 28 e2e scenarios in CI, a
  nightly visual audit of the panel and a functional matrix.

The interface is currently **Russian only**; English UI localisation is a separate planned project.
Public documents are bilingual.

## Stack

| Layer | Technology |
|---|---|
| Backend | Go 1.26+ (multi-stage alpine), chi, pgx, JWT |
| Database | PostgreSQL 15 |
| Object storage | Filesystem or S3/MinIO behind one interface (`STORAGE_DRIVER`) |
| Real-time | Yjs (CRDT) over WebSocket (gorilla/websocket) |
| Frontend | TypeScript, React 18, Vite, Zustand, ky |
| Stage | illustrations/SVG assets + CSS transitions (fixed stage, no WebGL) |
| CI/CD | GitHub Actions |
| Container | docker compose (postgres + backend + nginx-served frontend) |

## Quick start

```bash
git clone --recurse-submodules https://github.com/BarsSky/SkyFraze.git
cd SkyFraze
cp .env.example .env          # set JWT_SECRET (32+ bytes in production)
docker compose up --build -d
curl http://localhost/api/health   # {"status":"ok"}
```

UI — http://localhost, Postgres — `localhost:5432` (`skyfraze` / `skyfraze_dev`). Stop with
`docker compose down` (adding `-v` also drops the data — that is data loss).

**Next — [docs/run.en.md](docs/run.en.md):** running without Docker (dev mode), registration mode and
the first administrator, server deployment and updates from GitHub, moving a project between stands,
all environment variables, tests and live diagnostics, interface audit, storage and backups. The full
repository tree is there as well.

## Your own team, your own instance

SkyFraze is meant to be self-hosted: anyone can run the platform and work with their own team on
their own projects — no permission and no sign-up with us required.

- **Deploy and invite your people.** Apache-2.0 allows using, modifying and hosting the code,
  including inside your company or team. Registration is by request by default; invitations and roles
  are managed by the instance owner (`docs/run.md`).
- **Your stories are yours.** The license covers the software, not what is created with it: the text,
  frames, cards and attachments of your project stay yours and are not sent anywhere.
- **No telemetry.** There is no analytics and no phone-home in the code: outbound requests go only to
  the model provider you configure yourself (and only when the assistant is enabled).
- **Forks are allowed and expected.** The single condition is attribution: when you **distribute** a
  build, keep `LICENSE` and `NOTICE` and do not present the SkyFraze™ name or logo as your own
  (Apache-2.0, §4 and §6).

## Architecture

```
[Browser]                                              [Container]
  React app                                             frontend (nginx)
  ├── fetch /api → same origin → nginx → proxy  ─────►  /api/* ──► backend:8080
  │                                                                   │
  └── WebSocket /api/.../collab → nginx (Upgrade) ─────►            │
                                                                  Go backend
                                                                  ├── chi router
                                                                  ├── Yjs WS relay
                                                                  └── pgx → postgres:5432
```

The detailed diagram, data model and invariants are in `docs/architecture.md` (Russian).

## Repository layout

```
SkyFraze/
├── backend/                      Go API: cmd/server + internal/<package per area> + migrations/
├── frontend/                     Vite + React + TypeScript: src/ (pages, components, collab, api),
│                                 tests/ (Playwright e2e and live checks), nginx.conf, Dockerfile
├── docs/                         decision records: what was asked, why, what was verified
├── deploy/                       scripts, systemd units and configs: updates, backups, TLS proxy
├── deps/scroll-world/            git SUBMODULE oso95/scroll-world — a reference on stage
│                                 composition and scroll mechanics (not part of the build)
├── docker-compose.yml            postgres + backend + frontend (local development)
├── docker-compose.prod.yml       server configuration
├── .env / .env.example           JWT_SECRET, ADMIN_EMAILS, REGISTRATION_MODE etc.
└── vendor/scroll-world-reference/  local copy of the reference (not in the repository, /vendor/)
```

The full tree — with `backend/internal` packages, `frontend/src/components` directories and every
`docs/` file — is in [docs/run.en.md](docs/run.en.md), section "Repository structure".

## Documentation

The user-facing documents exist in both languages: **[docs/run.en.md](docs/run.en.md)** (running,
deployment, operations) and **[docs/features.en.md](docs/features.en.md)** (the full feature list).
The design notes under `docs/` are written in Russian, the project's working language; the table
below lists those originals.

| Document | About |
|---|---|
| `docs/run.md`, [run.en.md](docs/run.en.md) | running, deployment, updates, environment variables, tests, storage |
| `docs/features.md`, [features.en.md](docs/features.en.md) | the full feature list with links to the design notes |
| `docs/architecture.md` | data model, invariants, common defect analysis |
| `docs/diagnostics.md` | catalogue of live checks and diagnostic scripts |
| `docs/entity-links.md` | world cards: mentions, links, matrix, risks |
| `docs/entity-types.md` | custom card kinds and templates |
| `docs/entity-graph-navigation.md` | link graph: groups, drill-down, label search (option analysis) |
| `docs/comments.md` | frame discussions: threads, `@nick`, reactions |
| `docs/fragment-comments.md` | notes on a selected text fragment |
| `docs/project-chat.md` | project chat, Nestor in chat, notifications |
| `docs/import-export.md` | the md export/import format (including attachments) |
| `docs/import-export-folders.md` | folder import: files on disk → frames and attachments |
| `docs/docx-template.md` | DOCX book styling: placeholder, style map, help |
| `docs/realtime-editor.md` | realtime editing phases and their checks |
| `docs/versions.md` | project version history: when snapshots are taken, how to restore |
| `docs/security.md` | security model: permissions, tokens, access keys |
| `docs/webauthn.md` | access keys (WebAuthn): enrolment, sign-in, recovery |
| `docs/storage-compression.md` | what takes disk space on the server and how to shrink it |
| `docs/storage-s3.md` | the S3/MinIO plan: benefits, risks, cost |
| `docs/backups.md` | backups: what is copied, schedule, restore |
| `docs/ai-assistant.md` | the assistant: tools, model providers, keys |

## License

**Apache License 2.0** — see [LICENSE](LICENSE). In short: you may use, modify, host and sell the
code as part of your product as long as you keep the copyright notices; a patent grant comes with it
(section 3), a trademark grant does not (section 6): the SkyFraze™ name and logo are not covered by
the license.

**The license will not change.** The project plans neither a license change nor a closed or paid
edition, so no CLA is needed or planned: contributions are accepted under Apache-2.0
(inbound = outbound) with a DCO sign-off (`-s`). Details in
[CONTRIBUTING.en.md](CONTRIBUTING.en.md) ([Russian](CONTRIBUTING.md)).

Third-party components and their licenses are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (Russian; the tables are language-neutral). Three
items are easy to lose when building an image: `elkjs` (EPL-2.0) in the client build,
`libheif-tools` (LGPL-3.0) in the backend image and development-only tools under Apache-2.0. Full
texts of the third-party licenses (EPL-2.0, LGPL-3.0, summaries per Go module and npm package) are in
[`licenses/`](licenses/README.md).

**Source and provenance.** The canonical repository is this one; the first public commit is
September 26, 2026, the history and releases are public, and tags are signed with an SSH key. How to
verify authenticity — and what to do if you see a copy claiming to be the original — is in
[PROVENANCE.md](PROVENANCE.md). To cite the project, use [CITATION.cff](CITATION.cff) (the "Cite this
repository" button on GitHub).

Version history — [CHANGELOG.md](CHANGELOG.md).
