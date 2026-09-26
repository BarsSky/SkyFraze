.PHONY: up down logs ps backend-test frontend-test lint build clean help

help:
	@echo "SkyFraze — make targets:"
	@echo "  up              - start postgres + minio via docker compose"
	@echo "  down            - stop docker compose stack"
	@echo "  logs            - tail logs"
	@echo "  ps              - list running services"
	@echo "  backend-test    - run Go tests"
	@echo "  frontend-test   - run frontend tests"
	@echo "  lint            - run linters (backend + frontend)"
	@echo "  build           - build all"
	@echo "  clean           - remove build artifacts"

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

backend-test:
	cd backend && go test ./...

frontend-test:
	cd frontend && npm test -- --run

lint:
	cd backend && go vet ./...
	cd frontend && npm run lint

build:
	cd backend && go build -o bin/server ./cmd/server
	cd frontend && npm run build

clean:
	rm -rf backend/bin
	rm -rf frontend/dist
	rm -rf frontend/node_modules
