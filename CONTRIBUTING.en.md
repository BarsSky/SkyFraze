# Contributing to SkyFraze

Thanks for reading this file. SkyFraze is an open platform (Apache-2.0) and contributions are
welcome: fixes, features, documentation and translations.

Русская версия: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licensing of contributions

* Contributions are accepted **under Apache-2.0** (inbound = outbound): by sending a change you
  allow it to be distributed under the project license.
* **The project does not plan to change its license** and ships no paid or closed edition. There is
  no CLA and none is planned — you are not asked to assign exclusive rights.
* Sign off your commits with `-s` (Developer Certificate of Origin): `git commit -s -m "…"`. This
  certifies that you are entitled to submit the code under this license.
* By submitting a contribution you agree that it may be used in the project permanently and without
  compensation.

Project provenance and how authorship is verified — [PROVENANCE.md](PROVENANCE.md).

## What is welcome

* bug fixes — with a test that failed before the fix;
* new features — with the problem statement (what and why), tests and a `CHANGELOG.md` entry;
* documentation and translations — English especially: the interface is Russian for now, but the
  public documents should exist in both languages;
* bug reports — with reproduction steps; for layout problems include the viewport width and a
  screenshot (the interface audit checks exactly that).

## Before opening a pull request

1. **Start the stack** — `docker compose up --build -d` (quick start in [README.en.md](README.en.md)),
   or the no-Docker dev mode described in [docs/run.md](docs/run.md) (Russian).
2. **Run the checks:**
   ```bash
   cd backend  && go vet ./... && go test ./...
   cd frontend && npm run lint && npm test
   cd frontend && npm run e2e          # requires an EMPTY database, see docs/run.md
   ```
3. **Describe the change in `CHANGELOG.md`** — Keep a Changelog format, version in the heading.
4. **Never add secrets** — no `.env`, no keys, no tokens. Deployment files are in `.gitignore`.
5. **New dependencies need a rationale** and a permissive license only (MIT, BSD, Apache-2.0).
   Copyleft in the product runtime requires an explicit decision: the rule and the current inventory
   are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Commit style

```
type(scope): short imperative description
```

`type` is one of `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`. The subject is one line
up to 72 characters, Russian or English. The body explains **why**, not what — the diff shows what.
One change per commit; this project does not squash unrelated work into one.

## Code layout

`backend/` is Go (chi, pgx, Yjs relay), `frontend/` is React + TypeScript + Vite, `docs/` holds
decision records: what was asked, why it was done this way, what was verified (mostly Russian).
The full tree is in [docs/run.md](docs/run.md), data model and invariants in
[docs/architecture.md](docs/architecture.md).

Style: read the neighbouring code — indentation, quotes and naming come from the file you are
editing, not from an external guide. Comments explain **why**, not what the line does.

## Forks and self-hosting

Deploy it, modify it, run your own projects with your own team — the license allows it and the
project exists for exactly that: content created in your installation is yours and is not covered by
the software license. If you distribute a build, keep `LICENSE` and `NOTICE` and do not use the
SkyFraze name or logo as your own (Apache-2.0, §4 and §6).

## Conduct

Discuss ideas and code, not people. Harassment, insults and discrimination are grounds for rejecting
any contribution without further discussion.

## Where to write

* bugs and feature requests — the repository issues;
* vulnerabilities — **not** in issues: report privately to the maintainer (contact in the profile
  <https://github.com/BarsSky>) and allow time for a fix before disclosure.
