package main

import (
	"context"
	"embed"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/teams"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func main() {
	logger := platform.NewLogger(os.Getenv("APP_ENV"))
	slog.SetDefault(logger)
	platform.SetMigrationsFS(migrationsFS)

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
	authH := auth.NewHandler(authSvc, st, logger)

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

	collabHub := collab.NewHub(logger, cfg.JWTSecret, evSvc)
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
		w.Write([]byte(`{"status":"ok"}`))
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
		r.Post("/register", authH.Register)
		r.Post("/login", authH.Login)
		r.Post("/refresh", authH.Refresh)
		r.Group(func(r chi.Router) {
			r.Use(authSvc.WithUser)
			r.Get("/me", authH.Me)
		})
	})

	// projects
	r.Mount("/api/projects", projH.Routes(authSvc))

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
		r.Get("/members", teamsH.Members(authSvc))
		r.Post("/invitations", teamsH.Invite(authSvc))
		r.Get("/invitations", teamsH.ListInvitations(authSvc))
		r.Get("/events/state", evH.GetState(authSvc))
		r.Post("/events/state", evH.PutState(authSvc))
		r.Put("/events/state", evH.PutState(authSvc))
		r.Get("/events", evH.List(authSvc))
		r.Post("/assets", assetsH.Upload(authSvc))
		r.Get("/assets", assetsH.List(authSvc))
	})

	// global invitation acceptance
	r.With(authSvc.WithUser).Post("/api/invitations/{token}/accept", teamsH.Accept())

	// assets download (per-asset id)
	r.Get("/api/assets/{id}", assetsH.Download(authSvc))

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
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Request-ID")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
