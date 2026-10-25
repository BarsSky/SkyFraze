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
	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/assistant"
	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/coauthors"
	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/feed"
	"github.com/skyfraze/backend/internal/maintenance"
	"github.com/skyfraze/backend/internal/notify"
	"github.com/skyfraze/backend/internal/people"
	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/internal/ratelimit"
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

	// Ограничение попыток входа (docs/security.md): по адресу клиента и по аккаунту.
	// Без него единственный фактор входа — пароль — перебирался скриптом без ограничений.
	loginLimiter := ratelimit.New(
		ratelimit.Limit{PerWindow: cfg.AuthRatePerMinute, Window: time.Minute},
		ratelimit.Limit{PerWindow: cfg.AuthLoginPerEmailLimit, Window: time.Minute},
	)
	if cfg.AuthRatePerMinute <= 0 && cfg.AuthLoginPerEmailLimit <= 0 {
		logger.Warn("security: ограничение попыток входа выключено (AUTH_RATE_PER_MINUTE=0 и AUTH_LOGIN_PER_EMAIL_PER_MINUTE=0)")
	} else {
		logger.Info("security: ограничение попыток входа",
			"per_ip_per_minute", cfg.AuthRatePerMinute,
			"per_email_per_minute", cfg.AuthLoginPerEmailLimit)
	}
	// Уборка истёкших окон: карта счётчиков иначе растёт вместе с числом адресов.
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				loginLimiter.Cleanup()
			}
		}
	}()
	authH.UseRateLimit(loginLimiter)

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

	// Хранилище вложений: диск или S3/MinIO (docs/storage-s3.md). Режим выбирается явно
	// (STORAGE_DRIVER), а не «есть S3_ENDPOINT — значит S3»: наполовину настроенный стенд
	// должен падать на старте с понятной ошибкой, а не переключаться молча.
	var objStore storage.ObjectStore
	if strings.EqualFold(cfg.StorageDriver, "s3") {
		s3Store, s3Err := storage.NewS3(storage.S3Config{
			Endpoint: cfg.S3Endpoint, UseSSL: cfg.S3UseSSL, Bucket: cfg.S3Bucket,
			Prefix: cfg.S3Prefix, AccessKey: cfg.S3Key, SecretKey: cfg.S3Secret,
			Region: cfg.S3Region,
		})
		if s3Err != nil {
			logger.Error("storage init: S3", "err", s3Err)
			os.Exit(1)
		}
		objStore = s3Store
		logger.Info("storage: вложения в S3", "endpoint", cfg.S3Endpoint,
			"bucket", cfg.S3Bucket, "prefix", cfg.S3Prefix)
	} else {
		localStore, localErr := storage.NewLocal(cfg.StorageDir)
		if localErr != nil {
			logger.Error("storage init", "err", localErr)
			os.Exit(1)
		}
		objStore = localStore
	}
	assetsSvc := assets.New(st, objStore, projSvc)
	assetsSvc.UseLogger(logger)
	// Квота проекта: вес считается по строкам `assets`, то есть после пережатия.
	assetsSvc.UseQuota(cfg.AssetQuotaBytes)
	// Тот же предел показывает список проектов («весит 8.4 МБ из 10»): берём его у
	// владельца квоты, а не читаем конфиг второй раз.
	projH.UseQuota(assetsSvc.Quota())
	assetsH := assets.NewHandler(assetsSvc, logger)

	// Удаление проекта уносит и его файлы: иначе они оставались бы в хранилище
	// навсегда (уборщик ниже их найдёт, но лучше не оставлять).
	projSvc.UseFiles(assetsSvc)

	// Уборка хранилища: отчёт о размерах после старта и удаление файлов, на
	// которые никто не ссылается (docs/storage-compression.md, шаг 1).
	sweeper := maintenance.New(st, objStore, logger, maintenance.Options{})
	// И пережатие уже загруженных картинок — по требованию из админки: то, что
	// загружено до появления пережатия, осталось в исходном весе.
	sweeper.UseRecompressor(assetsSvc)
	go sweeper.Run(ctx)

	// Уведомления о новых замечаниях по почте (docs/comments.md §5.2). Очередь
	// (миграция 0020) наполняется при создании комментария, а отправляет её этот обход.
	// Без SMTP он не запускается вовсе — и это сказано в журнале, а не скрыто.
	notifyCfg := notify.Config{
		Host: cfg.NotifySMTPHost, Port: cfg.NotifySMTPPort,
		Username: cfg.NotifySMTPUser, Password: cfg.NotifySMTPPass,
		From: cfg.NotifyFrom, ImplicitTLS: cfg.NotifySMTPTLS,
		BaseURL: cfg.AppBaseURL,
		Interval: time.Duration(cfg.NotifyIntervalSeconds) * time.Second,
	}
	if notifyCfg.Enabled() {
		notifySvc := notify.New(st, notify.NewSMTPSender(notifyCfg), notifyCfg, logger)
		go notifySvc.Run(ctx)
		logger.Info("notify: письма о новых замечаниях включены",
			"host", notifyCfg.Host, "from", notifyCfg.From, "interval", notifyCfg.Interval.String())
	} else {
		logger.Info("notify: SMTP не настроен — уведомления о замечаниях только в интерфейсе")
	}

	evSvc := events.New(st, projSvc)
	evSvc.UseLogger(logger)
	// История версий: как часто снимать автоснимки и сколько их держать. Значения из
	// окружения, чтобы на стенде можно было подстроить без пересборки.
	evSvc.UseRevisionPolicy(events.RevisionPolicy{
		Interval: time.Duration(cfg.VersionsIntervalMinutes) * time.Minute,
		Keep:     cfg.VersionsKeep,
		MaxBytes: int64(cfg.VersionsMaxMB) << 20,
	})
	evH := events.NewHandler(evSvc, logger)

	teamsSvc := teams.New(st, projSvc)
	teamsH := teams.NewHandler(teamsSvc, logger)

	// соавторы: творческий круг человека (поиск по нику, заявки, специализации)
	coauthorsSvc := coauthors.New(st)
	coauthorsH := coauthors.NewHandler(coauthorsSvc, logger)

	// люди: каталог зарегистрированных участников и публичные профили
	peopleSvc := people.New(st)
	peopleH := people.NewHandler(peopleSvc, logger)

	feedSvc := feed.New(st, projSvc)
	feedH := feed.NewHandler(feedSvc, logger)

	transferSvc := transfer.New(st, objStore, projSvc)
	transferH := transfer.NewHandler(transferSvc, logger)

	// Импорт папки с md пишет файлы тем же путём, что и загрузка из интерфейса:
	// иначе дедупликация по содержимому (миграция 0007) обходилась бы стороной.
	transferSvc.UseFileStore(assetsSvc)
	// Предпросмотр импорта показывает предел вложений: набор, который не помещается,
	// лучше отклонить до создания проекта, чем на первом же файле.
	transferSvc.UseQuota(assetsSvc)

	// ИИ-помощник (docs/ai-assistant.md). Ключи стенда — по именам переменных,
	// объявленным у провайдеров; у большинства стендов их нет, и это нормально:
	// работает локальная модель и ключи самих пользователей.
	aiSvc := ai.New(st, ai.Config{
		Enabled:           cfg.AIEnabled,
		OllamaURL:         cfg.AIOllamaURL,
		OllamaNumCtx:      cfg.AIOllamaNumCtx,
		OpenAICompatURL:   cfg.AIOpenAICompatURL,
		OpenAICompatLocal: cfg.AIOpenAICompatLocal,
		SecretKey:         cfg.AISecretKey,
		DefaultModel:      cfg.AIDefaultModel,
		MaxToolCalls:      cfg.AIMaxToolCalls,
		TimeoutSeconds:    cfg.AITimeoutSeconds,
		TokensPerDay:      cfg.AITokensPerDay,
		// Генерация изображений — отдельный сервис со своим железом (A1111-совместимый).
		ImageURL:            cfg.AIImageURL,
		ImageTimeoutSeconds: cfg.AIImageTimeoutSeconds,
		ImageSteps:          cfg.AIImageSteps,
		ImageModel:          cfg.AIImageModel,
		ImageAutoLoad:       cfg.AIImageAutoLoad,
		ImageNegative:       cfg.AIImageNegative,
	}, map[string]string{
		"GROQ_API_KEY":       os.Getenv("GROQ_API_KEY"),
		"OPENROUTER_API_KEY": os.Getenv("OPENROUTER_API_KEY"),
		"GOOGLE_API_KEY":     os.Getenv("GOOGLE_API_KEY"),
		"OPENAI_API_KEY":     os.Getenv("OPENAI_API_KEY"),
		"CUSTOM_AI_API_KEY":  os.Getenv("CUSTOM_AI_API_KEY"),
	}, logger)
	aiH := ai.NewHandler(aiSvc, logger)

	// Беседы внутри проекта: контекст, инструменты и выполнение изменений. Помощник
	// создаёт кадры ТЕМ ЖЕ путём, что импорт Markdown «в место» (transfer), поэтому
	// открытые вкладки видят созданное сразу, а не после перезагрузки.
	assistantSvc := assistant.New(st, aiSvc, projSvc, transferSvc, cfg.AIMaxToolCalls, logger)
	// Иллюстрации помощника ложатся вложениями проекта: тот же путь загрузки, что у
	// файлов из интерфейса (квота, пережатие в WebP, дедупликация).
	assistantSvc.UseAssets(assetsSvc)
	// Правка и удаление существующих кадров: агент их ПРЕДЛАГАЕТ, а применяет тот же
	// путь записи в документ, что у импорта и привязки вложений (живая комната впереди,
	// снапшот при её отсутствии). Без этой строки помощник снова умел бы только создавать.
	assistantSvc.UseEditor(transferSvc)
	assistantH := assistant.NewHandler(assistantSvc, logger)

	collabHub := collab.NewHub(logger, cfg.JWTSecret, evSvc, cfg.CORSOrigins)
	go collabHub.Run(ctx)
	// Удаление файла обязано знать, прикреплён ли он к кадрам: ссылки живут в
	// CRDT-документе, и спрашивать о них может только хаб (живая комната) или
	// снапшот базы — см. assets.UsageChecker.
	assetsSvc.UseUsage(collabHub)

	// Импорт «в место» обязан попасть в документ живой комнаты: пока проект кто-то
	// редактирует, источник правды — он, и запись только в снапшот базы затёрлась
	// бы ближайшим сохранением комнаты.
	transferSvc.UseLiveDoc(collabHub)
	// Восстановление версии тоже идёт через живую комнату: правка должна доехать до
	// открытых вкладок обычным апдейтом, а не ждать перезагрузки.
	evSvc.UseLiveRestore(collabHub)

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
		// Ограничение по адресу клиента — на публичных ручках входа; граница по аккаунту
		// живёт в самой ручке (ей нужен email из тела).
		limited := loginLimiter.Middleware
		r.With(limited).Post("/register", authH.Register)
		r.With(limited).Post("/registration-requests", authH.RequestRegistration)
		r.With(limited).Post("/login", authH.Login)
		// Второй шаг входа: пропуск + код 2FA. Токенов до него нет, поэтому ручка публичная
		// и ограничена теми же границами, что и сам вход.
		r.With(limited).Post("/login/2fa", authH.LoginTOTP)
		r.With(limited).Post("/refresh", authH.Refresh)
		r.Group(func(r chi.Router) {
			r.Use(authSvc.WithUser)
			r.Get("/me", authH.Me)
			// Профиль: имя и ник (@username), по которому человека находят.
			r.Patch("/me", authH.UpdateProfile)
			// Второй фактор и активные сеансы (docs/security.md).
			authH.MountTwoFactor(r)
		})
	})

	// соавторы: заявки, специализации и доступ к закрытым проектам человека.
	r.Mount("/api/coauthors", coauthorsH.Routes(authSvc))

	// люди: каталог участников (/api/users), публичный профиль (/api/users/{id})
	// и поиск по нику и имени (/api/users/search). Все три ветки — одно дерево:
	// два chi-роутера на одном префиксе не собрать. Статический /search и
	// параметрический /{id} лежат рядом, и chi выбирает статический раньше —
	// иначе поиск уходил бы в профиль с id="search" (проверено тестом
	// people/handler_test.go).
	r.Mount("/api/users", peopleH.Routes(authSvc, coauthorsH.Search))

	// администрирование развёртывания: режим регистрации и заявки
	r.Mount("/api/admin", adminH.Routes(authSvc, updateH, sweeper))

	// Перенос проекта между инсталляциями. Импорт регистрируется СТАТИЧЕСКИМ путём
	// (/api/projects/import) до param-ветки: chi выбирает статический сегмент вперёд
	// параметрического, но проверить это в рантайме дешевле, чем ловить 404 у клиента.
	r.With(authSvc.WithUser).Post("/api/projects/import", transferH.Import)
	// Импорт папки с md: preview ничего не пишет, второй вызов создаёт проект.
	// Оба пути статические и лежат под уже занятым /api/projects/import.
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown/preview", transferH.MarkdownPreview)
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown", transferH.MarkdownImport)

	// projects
	r.Mount("/api/projects", projH.Routes(authSvc))

	// Непрочитанные замечания по всем моим проектам: список проектов спрашивает это ДО
	// выбора проекта, чтобы показать «сюда стоит заглянуть». Отдельный путь, а не
	// /api/projects/{id}/…: проекта в запросе ещё нет.
	r.With(authSvc.WithUser).Get("/api/comments/unseen", evH.CommentsUnreadAnywhere(authSvc))

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

		// История версий проекта: список, предпросмотр, ручная версия и восстановление.
		// Читают viewer+, меняют editor+ (проверяется в events.Service).
		evH.MountVersions(r)

		// Обсуждение кадров (миграция 0018): чтение viewer+, запись editor+, удаление —
		// только своё. Комментарии — не текст проекта: в документ и в книгу они не идут.
		evH.MountComments(r)

		r.Post("/assets", assetsH.Upload(authSvc))
		r.Get("/assets", assetsH.List(authSvc))
		// Занятое место и предел квоты: интерфейс показывает их рядом со списком
		// файлов, чтобы отказ «не помещается» не был неожиданностью.
		r.Get("/assets/usage", assetsH.Usage(authSvc))
		// Удаление файла нужно вместе с квотой: иначе проект, упёршийся в предел,
		// не может освободить место. Файл, прикреплённый к кадрам, не удаляется —
		// 409 и просьба сначала открепить.
		r.Delete("/assets/{assetID}", assetsH.Delete(authSvc))

		// Экспорт проекта целиком: архив с деревом, CRDT-снапшотом и вложениями.
		// Чтение — viewer+ (читатель и так видит всё содержимое проекта).
		r.Get("/export", transferH.Export)

		// Выгрузка одной лентой Markdown: /export.md (файл) и /export.md?assets=1
		// (zip с картинками). Отдельный статический сегмент рядом с /export —
		// chi различает их по полному сегменту пути, а не по префиксу, поэтому
		// /export не перехватывает /export.md (проверено тестом дерева маршрутов).
		r.Get("/export.md", transferH.ExportMarkdown)

		// Книга файлом: EPUB для читалки и DOCX для редактора. Отдельные сегменты
		// (`/export/epub`), а не параметр формата: браузер скачивает файл по ссылке, и
		// имя файла в заголовке зависит от формата.
		r.Get("/export/epub", transferH.ExportEPUB)
		r.Get("/export/docx", transferH.ExportDOCX)

		// Импорт куска в существующий проект: разобранный набор md вставляется в
		// выбранное место дерева (`parent_id` / `after_id` в форме). Отдельно от
		// /api/projects/import/markdown, который создаёт НОВЫЙ проект.
		r.Post("/import/markdown", transferH.MarkdownImportInto)

		// ИИ-помощник: беседы и создание кадров инструментами. Права проверяет
		// сервис (editor+), согласие на отправку текста провайдеру — тоже он.
		assistantH.Routes(r)
	})

	// global invitation acceptance
	r.With(authSvc.WithUser).Post("/api/invitations/{token}/accept", teamsH.Accept())

	// assets download (per-asset id). ВАЖНО: роут живёт в корне роутера, а
	// Download читает пользователя из контекста — без WithUser он всегда отдавал
	// 401, из-за чего картинки ассетов нигде не отображались.
	r.With(authSvc.WithUser).Get("/api/assets/{id}", assetsH.Download(authSvc))

	// ИИ-помощник: подключение моделей и свои ключи. Беседы и инструменты появятся
	// в этом же поддереве (docs/ai-assistant.md, фазы 2–3).
	r.Route("/api/ai", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		aiH.Routes(r)
	})

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
