# SkyFraze

Веб-платформа для совместной (по приглашениям) разработки сюжетов игр / кино / мультфильмов / книг.

## Что умеет

- Проекты (сюжеты) с владельцем и командой
- Временная линия событий (timeline)
- Скетчи / рисунки / ассеты-файлы
- Real-time совместное редактирование (CRDT)
- Браузерная 3D-визуализация таймлайна (Three.js, scroll-scrubbed камера)
- Команды с ролями owner / editor / viewer; приглашения по email/invite-link

## Стек

| Слой | Технология |
|---|---|
| Backend | Go 1.22+, chi, pgx, sqlc, JWT |
| Database | PostgreSQL 16 |
| Object storage | MinIO (S3-compatible) |
| Real-time | Yjs (CRDT) через WebSocket |
| Frontend | TypeScript, React 18, Vite |
| 3D | Three.js |
| Tests | Go testing + testify, Vitest, Playwright |

## Структура

```
SkyFraze/
├── backend/                     Go-сервис
├── frontend/                    React + Vite
├── docker-compose.yml           postgres + minio
├── Makefile
└── vendor/
    └── scroll-world-reference/  Изучен для концепции scroll-scrubbed сцен. Код НЕ импортируется.
```

**Reference**: scroll-world (MIT, oso95, github.com/oso95/scroll-world) — изучен для концепции scroll-scrubbed сцен. Код НЕ импортируется. AI-pipeline (Monid/Higgsfield) сознательно НЕ интегрирован — это дорого и блокирует open-source/self-hosted установку.

## Быстрый старт

```bash
make up                  # поднять postgres + minio
cd backend && go run ./cmd/server    # запустить API
cd frontend && npm run dev           # запустить UI
```

UI: http://localhost:5173, API: http://localhost:8080, MinIO Console: http://localhost:9001.

## Тесты

```bash
make backend-test
make frontend-test
```

## Документация

- `docs/architecture.md` — архитектура и ADR
- `docs/api.md` — REST/WS контракт

## Лицензия

TBD
