# SkyFraze Backend — multi-stage build.
# Builder: golang alpine с CGO=0 (для статической линковки бинаря).
# Runtime: alpine с CA-сертификатами + non-root user.

FROM golang:1.26-alpine AS builder

WORKDIR /src

# Версия и коммит проставляются при сборке (их показывает админка в разделе
# «Обновление» и сравнивает с последним релизом на GitHub).
ARG VERSION=dev
ARG COMMIT=""

# Кэшируем зависимости отдельно от исходников — пересборка только при изменениях go.mod/go.sum.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO=0 → статический бинарь; -trimpath → воспроизводимый билд; -ldflags '-s -w' → меньше.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/server ./cmd/server

# ──────────────────────────────────────────────────────────────────────────────
FROM alpine:3.19 AS runtime

# CA-certs нужны для pgx over TCP к Postgres (TLS) и для Yjs-запросов в проде.
# libheif-tools даёт `heif-convert`: им сервер разбирает HEIC с айфонов. Чистого
# Go-декодера HEVC не существует, а CGO сломал бы статическую сборку, поэтому
# конвертер живёт в образе отдельной утилитой (см. internal/media/heic.go). Если
# пакета в образе нет, сервер честно отказывает на HEIC, а не хранит файл, который
# браузер не покажет.
RUN apk add --no-cache ca-certificates tzdata libheif-tools && \
    addgroup -S skyfraze && adduser -S -G skyfraze skyfraze

WORKDIR /app
COPY --from=builder /out/server /app/server

# Папка для загруженных ассетов (в dev — filesystem; в прод через volume).
RUN mkdir -p /app/storage && chown -R skyfraze:skyfraze /app

USER skyfraze

ENV LISTEN=:8080 \
    STORAGE_DIR=/app/storage \
    APP_ENV=production

EXPOSE 8080

# Healthcheck через простой tcp-check (мы не делали /health на отдельном порту — он общий).
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/server"]
