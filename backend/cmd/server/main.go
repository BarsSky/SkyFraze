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

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/internal/store"
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

	st := store.New(pool)
	authSvc := auth.New(st, cfg.JWTSecret)
	authH := auth.NewHandler(authSvc, st, logger)

	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Use(corsMiddleware(cfg.CORSOrigins))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})
	r.Get("/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			http.Error(w, "db not ready", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"status":"ready"}`))
	})

	r.Route("/api/auth", func(r chi.Router) {
		r.Post("/register", authH.Register)
		r.Post("/login", authH.Login)
		r.Post("/refresh", authH.Refresh)
		r.Group(func(r chi.Router) {
			r.Use(authSvc.WithUser)
			r.Get("/me", authH.Me)
		})
	})

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// graceful shutdown
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

// corsMiddleware — простой CORS-middleware для dev (allow из env).
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

func randomID() string {
	// простой request id — в проде заменить на UUID; для MVP достаточно
	const hex = "0123456789abcdef"
	b := make([]byte, 16)
	for i := range b {
		b[i] = hex[time.Now().UnixNano()%16]
		time.Sleep(time.Nanosecond)
	}
	return string(b)
}
