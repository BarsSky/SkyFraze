# SkyFraze Frontend — multi-stage build.
# Builder: node alpine с pnpm/npm ci → vite build → статика в /dist.
# Runtime: nginx alpine раздаёт dist + проксирует /api на backend.
# Это даёт маленький финальный образ (~25MB) и единую точку входа для SPA.

FROM node:22-alpine AS builder

WORKDIR /src

# Кэшируем установку зависимостей отдельно от исходников.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .

# Vite собирает production-бандл в /dist.
# Передаём пустые env, чтобы Vite-клиент знал backend URL; в compose прокси через nginx
# перекрывает это, но оставляем дефолт на случай прямого запроса.
ENV VITE_API_BASE=/api
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Конфиг nginx с SPA-fallback + /api proxy.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Статика из builder.
COPY --from=builder /src/dist /usr/share/nginx/html

# Healthcheck: проверяем что nginx отвечает.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD wget -qO- http://127.0.0.1/health || exit 1

EXPOSE 80
