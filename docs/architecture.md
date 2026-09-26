# SkyFraze — Architecture

## High-level

```
[Browser]                                              [Server]
  React app                                             Go backend
  ├── REST client ──────────────HTTPS────────────► chi router
  │
  ├── Yjs WebSocket client ───WSS (JWT)──────────► collab hub
  │
  ├── Three.js scene (canvas) ◄── GET events/state ───
  │
  └── Asset upload ──POST /api/assets (multipart)──► storage svc ──► filesystem
                                                        └─► postgres assets table
```

## Phase 1 decisions

| Решение | Почему |
|---|---|
| Postgres 15 (вместо 16) | Образ `postgres:15-alpine` доступен локально в этом окружении; `postgres:16-alpine` нет. Семантически одно и то же. |
| Filesystem ObjectStore (вместо MinIO) | Образ `minio/minio` недоступен. `internal/storage.ObjectStore` — единая абстракция; MinIO добавим в Phase 2 без изменения контракта. |
| npm (вместо pnpm) | pnpm не установлен; npm есть. Vite-проект работает идентично. |
| C++ НЕ участвует в Phase 1 | См. план — C++ остаётся в Phase 3 (native renderer). |
| Three.js для 3D | Полноценный WebGL; события = 3D-объекты. |
| Свой Yjs-relay на Go | Меньше языков в стеке; полный контроль над auth/persistence. |

## Domain model (Postgres)

```sql
users              (id, email, password_hash, display_name, created_at)
projects           (id, owner_id, title, description, ...)
team_memberships   (project_id, user_id, role)
invitations        (id, project_id, email, token, role, expires_at, accepted_at)
events             (id, project_id, position, title, body, event_date, yjs_state, ...)
assets             (id, project_id, owner_id, filename, mime, size, s3_key, kind, ...)
event_assets       (event_id, asset_id)  -- M2M
sessions           (id, user_id, refresh_token_hash, expires_at)
```

## Folder boundaries

- `events` — единственная владелица CRDT-документа
- `teams` отделён от `projects`
- `assets` — отдельный сервис, общается с `storage` напрямую
- `collab` — изолированный WebSocket-хаб
- `platform` — config, logger, db pool (общая инфраструктура)
