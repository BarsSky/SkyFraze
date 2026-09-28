package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/skyfraze/backend/internal/admin"
	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/coauthors"
	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/feed"
	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/teams"
	"github.com/skyfraze/backend/internal/transfer"
	"github.com/skyfraze/backend/internal/update"
	"github.com/skyfraze/backend/migrations"
)

// version и commit проставляются при сборке образа:
//
//	go build -ldflags "-X main.version=v0.2.0 -X main.commit=<sha>"
//
// Они показываются в админке и сравниваются с последним релизом на GitHub.
var (
	version = "dev"
	commit  = ""
)

func main() {
	logger := platform.NewLogger(os.Getenv("APP_ENV"))
	slog.SetDefault(logger)
	// Миграции вшиты в директорию migrations/ (там же, где файлы), поэтому
	// FS-корень — сама директория: см. комментарий в platform.RunMigrations.
	platform.SetMigrationsFS(migrations.FS)

	cfg, err := platform.LoadConfig()
	if err != nil {
		logger.Error("load config", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := platform.NewDBPool(ctx, cfg.DBURL)
	if err != nil {
		logger.Error("db pool", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := platform.RunMigrations(ctx, pool); err != nil {
		logger.Error("migrations", "err", err)
		os.Exit(1)
	}
	logger.Info("migrations applied")

	// --- services ---
	st := store.New(pool)

	authSvc := auth.New(st, cfg.JWTSecret)
	authSvc.SetAdminEmails(cfg.AdminEmailList())
	authH := auth.NewHandler(authSvc, st, logger)

	// Развёртывание задаёт администраторов и стартовый режим регистрации.
	if granted := authSvc.SyncConfiguredAdmins(ctx); granted > 0 {
		logger.Info("admins granted from ADMIN_EMAILS", "count", granted)
	}
	if admins, err := st.CountAdmins(ctx); err == nil && admins == 0 {
		logger.Warn("no administrators yet: первый зарегистрированный пользователь станет администратором")
	}

	// Стартовый режим регистрации из окружения: применяется, пока режим не менял
	// администратор (после этого решение админа приоритетнее env).
	mode := strings.ToLower(strings.TrimSpace(cfg.RegistrationMode))
	if mode != store.RegistrationModeOpen && mode != store.RegistrationModeRequest {
		logger.Warn("REGISTRATION_MODE unknown, using default", "value", cfg.RegistrationMode, "default", store.RegistrationModeRequest)
		mode = store.RegistrationModeRequest
	}
	if changed, err := st.SeedSettingIfUnchanged(ctx, store.SettingRegistrationMode, mode); err != nil {
		logger.Error("seed registration mode", "err", err)
	} else if changed {
		logger.Info("registration mode set from env", "mode", mode)
	}
	// администрирование развёртывания: режим регистрации, заявки и обновление
	adminSvc := admin.New(st, authSvc)
	adminH := admin.NewHandler(adminSvc, logger)

	// Механизм обновления: проверка релизов на GitHub + заявка, которую применяет
	// хост (см. deploy/skyfraze-update.sh и docs/architecture.md).
	updateSvc := update.New(cfg.UpdateRepo, cfg.UpdateToken, cfg.UpdateChannel, version, commit, cfg.UpdateStateDir)
	updateH := update.NewHandler(updateSvc, adminSvc, logger)

	projSvc := projects.New(st)
	projH := projects.NewHandler(projSvc, logger)

	objStore, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		logger.Error("storage init", "err", err)
		os.Exit(1)
	}
	assetsSvc := assets.New(st, objStore, projSvc)
	assetsH := assets.NewHandler(assetsSvc, logger)

	evSvc := events.New(st, projSvc)
	evH := events.NewHandler(evSvc, logger)

	teamsSvc := teams.New(st, projSvc)
	teamsH := teams.NewHandler(teamsSvc, logger)

	// соавторы: творческий круг человека (поиск по нику, заявки, специализации)
	coauthorsSvc := coauthors.New(st)
	coauthorsH := coauthors.NewHandler(coauthorsSvc, logger)

	feedSvc := feed.New(st, projSvc)
	feedH := feed.NewHandler(feedSvc, logger)

	transferSvc := transfer.New(st, objStore, projSvc)
	transferH := transfer.NewHandler(transferSvc, logger)

	collabHub := collab.NewHub(logger, cfg.JWTSecret, evSvc, cfg.CORSOrigins)
	go collabHub.Run(ctx)

	// --- router ---
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Use(corsMiddleware(cfg.CORSOrigins))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cl := r.ContentLength
			method := r.Method
			uri := r.URL.Path
			logger.Info("request", "method", method, "uri", uri, "content-length", cl)
			next.ServeHTTP(w, r)
		})
	})

	// health
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Версия в ответе нужна мониторингу и скрипту обновления: по ней видно,
		// какая ревизия реально работает, не заходя в админку.
		payload := fmt.Sprintf(`{"status":"ok","version":%q,"commit":%q}`, version, commit)
		w.Write([]byte(payload))
	})
	r.Get("/ready", func(w http.ResponseWriter, r *http.Request) {
		pctx, pcancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer pcancel()
		if err := pool.Ping(pctx); err != nil {
			http.Error(w, "db not ready", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"status":"ready"}`))
	})

	// auth
	r.Route("/api/auth", func(r chi.Router) {
		// Публичная конфигурация входа: страница регистрации должна знать,
		// свободная она или по заявке — ещё до отправки формы.
		r.Get("/config", authH.Config)
		r.Post("/register", authH.Register)
		r.Post("/registration-requests", authH.RequestRegistration)
		r.Post("/login", authH.Login)
		r.Post("/refresh", authH.Refresh)
		r.Group(func(r chi.Router) {
			r.Use(authSvc.WithUser)
			r.Get("/me", authH.Me)
			// Профиль: имя и ник (@username), по которому человека находят.
			r.Patch("/me", authH.UpdateProfile)
		})
	})

	// соавторы: поиск людей по нику, заявки, специализации и доступ к закрытым
	// проектам. Общий поиск — отдельным префиксом /api/users.
	r.Mount("/api/coauthors", coauthorsH.Routes(authSvc))
	r.Mount("/api/users", coauthorsH.SearchRoutes(authSvc))

	// администрирование развёртывания: режим регистрации и заявки
	r.Mount("/api/admin", adminH.Routes(authSvc, updateH))

	// Перенос проекта между инсталляциями. Импорт регистрируется СТАТИЧЕСКИМ путём
	// (/api/projects/import) до param-ветки: chi выбирает статический сегмент вперёд
	// параметрического, но проверить это в рантайме дешевле, чем ловить 404 у клиента.
	r.With(authSvc.WithUser).Post("/api/projects/import", transferH.Import)

	// projects
	r.Mount("/api/projects", projH.Routes(authSvc))

	// Публичная лента и публичные файлы. Всё дерево /api/public регистрируется
	// одним Route (а не Mount + отдельным корневым роутом): у chi Mount создаёт
	// wildcard-ветку, и соседний более специфичный путь легко становится
	// недостижимым — ровно так раньше ломался GET /api/projects/{id}.
	//
	// Доступ: чтение — без авторизации (OptionalUser распознаёт вошедшего для
	// «моей оценки»), оценка — только с токеном, запись в содержимое истории
	// недоступна здесь никому.
	r.Route("/api/public", func(r chi.Router) {
		r.Use(authSvc.OptionalUser)
		r.Get("/feed", feedH.Feed)
		r.Get("/stories/{slug}", feedH.Story)
		r.With(authSvc.WithUser).Post("/stories/{slug}/rating", feedH.Rate)
		r.With(authSvc.WithUser).Delete("/stories/{slug}/rating", feedH.Unrate)
		r.Get("/assets/{id}", assetsH.DownloadPublic(authSvc))
	})

	// WebSocket collab endpoint — должен быть смонтирован ОТДЕЛЬНО,
	// потому что chi.Mount + chi.URLParam вместе работают неудобно.
	// Прямой chi.Handle даёт корректный upgrade без auth-конфликтов middleware.
	r.HandleFunc("/api/projects/{projectID}/collab", func(w http.ResponseWriter, r *http.Request) {
		// chi.URLParam уже парсится — WS-handler читает URL.Path через projectIDFromPath
		collabHub.HandleWS(w, r)
	})

	// под-ресурсы проектов: монтируем один общий sub-router с chi.Route
	r.Route("/api/projects/{id}", func(r chi.Router) {
		r.Use(authSvc.WithUser)

		// CRUD самого проекта. ВАЖНО: без этих строк chi выбирает param-ветку
		// /api/projects/{id} (она специфичнее wildcard от Mount выше), а в ней
		// не было обработчика "/" — GET/PUT/DELETE /api/projects/{id} отдавали
		// 404 "page not found". Дублирующие регистрации в projH.Routes() для
		// одиночного проекта недостижимы и оставлены только для List/Create.
		r.Get("/", projH.Get)
		r.Put("/", projH.Update)
		r.Delete("/", projH.Delete)

		r.Get("/members", teamsH.Members(authSvc))
		// Прямое добавление участника (владелец): основной путь — выбрать соавтора
		// из своего круга, не высылая ссылку-приглашение.
		r.Post("/members", teamsH.AddMember(authSvc))
		r.Delete("/members/{userID}", teamsH.RemoveMember(authSvc))
		r.Post("/invitations", teamsH.Invite(authSvc))
		r.Get("/invitations", teamsH.ListInvitations(authSvc))
		r.Get("/events/state", evH.GetState(authSvc))
		r.Post("/events/state", evH.PutState(authSvc))
		r.Put("/events/state", evH.PutState(authSvc))
		r.Get("/events", evH.List(authSvc))

		// Иерархия событий: серверная модель (parent_id/depth/position) с
		// валидацией циклов/глубины и каскадным удалением. Запись — только
		// owner/editor (проверяется в events.Service).
		r.Post("/events", evH.Create(authSvc))
		r.Put("/events/tree", evH.SyncTree(authSvc))
		r.Patch("/events/{eventID}", evH.Update(authSvc))
		r.Put("/events/{eventID}/parent", evH.Move(authSvc))
		r.Delete("/events/{eventID}", evH.Delete(authSvc))

		// Публикация: владелец включает/выключает показ истории в ленте.
		r.Post("/publication", feedH.Publish)

		r.Post("/assets", assetsH.Upload(authSvc))
		r.Get("/assets", assetsH.List(authSvc))

		// Экспорт проекта целиком: архив с деревом, CRDT-снапшотом и вложениями.
		// Чтение — viewer+ (читатель и так видит всё содержимое проекта).
		r.Get("/export", transferH.Export)
	})

	// global invitation acceptance
	r.With(authSvc.WithUser).Post("/api/invitations/{token}/accept", teamsH.Accept())

	// assets download (per-asset id). ВАЖНО: роут живёт в корне роутера, а
	// Download читает пользователя из контекста — без WithUser он всегда отдавал
	// 401, из-за чего картинки ассетов нигде не отображались.
	r.With(authSvc.WithUser).Get("/api/assets/{id}", assetsH.Download(authSvc))

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		logger.Info("server starting", "addr", cfg.Listen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			cancel()
		}
	}()

	<-stop
	logger.Info("shutdown initiated")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "err", err)
	}
	logger.Info("server stopped")
}

// corsMiddleware — dev CORS через env.
func corsMiddleware(origins string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = true
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Request-ID,X-Skyfraze-Base-Revision")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
