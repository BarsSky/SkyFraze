# SkyFraze

Веб-платформа для совместной (по приглашениям) разработки сюжетов игр / кино / мультфильмов / книг.

## Что умеет

- Проекты (сюжеты) с владельцем и командой
- Временная линия событий (timeline) с 3D-визуализацией в браузере (Three.js + scroll-scrubbed камера по мотивам scroll-world)
- Скетчи / рисунки / ассеты-файлы (filesystem в MVP, MinIO/S3 в Phase 2)
- Real-time совместное редактирование нарратива через Yjs (CRDT) с авто-сохранением
- Команды с ролями owner / editor / viewer; приглашения по email или invite-токену

## Стек

| Слой | Технология |
|---|---|
| Backend | Go 1.26+ (multi-stage alpine), chi, pgx, JWT |
| Database | PostgreSQL 15 |
| Object storage | Filesystem (Phase 2: MinIO/S3) |
| Real-time | Yjs (CRDT) через WebSocket (gorilla/websocket) |
| Frontend | TypeScript, React 18, Vite, Zustand, ky |
| 3D | Three.js |
| CI/CD | GitHub Actions |
| Container | docker compose (postgres + backend + nginx-served frontend) |

## Быстрый старт через Docker (production-like)

```bash
# 1. Скопировать env-шаблон и заполнить JWT_SECRET
cp .env.example .env
# (на dev можно оставить дефолт, но обязательно 32+ байта в проде)

# 2. Собрать и поднять весь стек
docker compose up --build -d

# 3. Открыть UI
open http://localhost      # macOS
# или xdg-open http://localhost / просто ввести в браузере
```

После `docker compose up`:
- **Frontend** (UI + nginx proxy): http://localhost (port 80)
- **Backend** (Go API): internal :8080 (доступен только через nginx)
- **Postgres**: localhost:5432 (`skyfraze` / `skyfraze_dev` — для локальной отладки)

Health-check:
```bash
docker compose ps            # все 3 сервиса должны быть healthy
curl http://localhost/api/health   # {"status":"ok"}
```

Остановка:
```bash
docker compose down          # остановить
docker compose down -v       # остановить и удалить volumes (ПОТЕРЯ ДАННЫХ)
```

## Запуск без Docker (dev-режим)

```bash
# Postgres (через docker)
docker compose up postgres -d

# Backend
cd backend
export DATABASE_URL="postgres://skyfraze:skyfraze_dev@localhost:5432/skyfraze?sslmode=disable"
export JWT_SECRET="dev-secret"
export CORS_ORIGINS="http://localhost:5173"
export STORAGE_DIR="./storage"
go run ./cmd/server

# Frontend (в другом терминале)
cd frontend
npm install
npm run dev   # Vite поднимет на http://localhost:5173
```

## Архитектура

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

См. `docs/architecture.md` для подробной диаграммы и модели данных.

## Структура репозитория

```
SkyFraze/
├── backend/                      Go API
│   ├── cmd/server/               main.go
│   ├── internal/
│   │   ├── auth/                 JWT + register/login/refresh
│   │   ├── projects/             CRUD + ownership
│   │   ├── teams/                invitations, roles
│   │   ├── assets/               upload/download (filesystem)
│   │   ├── events/               Yjs binary state persistence
│   │   ├── collab/               WebSocket hub
│   │   ├── storage/              ObjectStore interface + LocalStore
│   │   ├── store/                typed pgx queries
│   │   └── platform/              config, logger, db pool, migrate
│   ├── migrations/                SQL schema
│   ├── Dockerfile                multi-stage Go build
│   └── .dockerignore
├── frontend/                     Vite + React + TypeScript
│   ├── src/
│   │   ├── pages/                LoginPage, ProjectsPage, ProjectTimelinePage, ...
│   │   ├── components/            timeline (Three.js), events, teams
│   │   ├── collab/               Yjs provider
│   │   ├── store/                Zustand auth store
│   │   └── api/                  REST + WS clients
│   ├── nginx.conf                 SPA fallback + /api proxy
│   ├── Dockerfile                multi-stage Vite build → nginx serve
│   └── .dockerignore
├── docs/
│   └── architecture.md
├── docker-compose.yml            postgres + backend + frontend
├── .env / .env.example            JWT_SECRET и т.п.
└── vendor/scroll-world-reference/  Референс для 3D-сцены (НЕ импортируется)
```

## Переменные окружения

| Переменная | Назначение | Дефолт в compose |
|---|---|---|
| `JWT_SECRET` | секрет для подписи access/refresh токенов | обязательна (нет дефолта) |
| `DATABASE_URL` | DSN Postgres | `postgres://skyfraze:skyfraze_dev@postgres:5432/skyfraze?sslmode=disable` |
| `CORS_ORIGINS` | comma-separated список origin для CORS | `http://localhost` |
| `STORAGE_DIR` | директория для ассетов (filesystem) | `/app/storage` (volume) |
| `LISTEN` | bind address backend | `:8080` |
| `APP_ENV` | environment marker | `production` |

## Тесты

```bash
# Backend unit + integration (нужна Postgres)
cd backend && go test ./...

# Frontend unit
cd frontend && npm test

# E2E walkthrough (нужны docker + оба сервиса)
cd frontend && npm run e2e
```

## Лицензия

TBD
