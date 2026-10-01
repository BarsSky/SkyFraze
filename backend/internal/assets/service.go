package assets

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

var (
	ErrTooLarge = errors.New("file too large")
	ErrBadMime  = errors.New("unsupported mime type")
)

const maxAssetSize = 50 * 1024 * 1024 // 50 MB

// MaxAssetSize — предел размера одного вложения. Экспортирован, потому что его
// обязаны соблюдать все пути, создающие вложения: загрузка из интерфейса и импорт
// проекта (папка md с картинками), иначе импорт создал бы файл, который сервер
// потом отказывается принять.
const MaxAssetSize = maxAssetSize

// ObjectKey — ключ файла в хранилище: каталог проекта плюс случайный идентификатор
// с расширением файла. Одна схема для загрузки из интерфейса и для импорта: файлы
// проекта лежат вместе, а расширение нужно, чтобы отдача по ключу не теряла тип.
func ObjectKey(projectID uuid.UUID, filename string) string {
	return fmt.Sprintf("%s/%s", projectID.String(), uuid.NewString()+extFromFilename(filename))
}

type Service struct {
	store *store.Store
	obj   storage.ObjectStore
	proj  *projects.Service
}

func New(s *store.Store, obj storage.ObjectStore, proj *projects.Service) *Service {
	return &Service{store: s, obj: obj, proj: proj}
}

// UploadOpts — параметры загрузки.
type UploadOpts struct {
	Filename    string
	ContentType string
	Size        int64
	Reader      io.Reader
}

// Upload — загружает файл, сохраняет метаданные.
func (s *Service) Upload(ctx context.Context, actorID, projectID uuid.UUID, opts UploadOpts) (*store.Asset, error) {
	// проверим доступ к проекту
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	if opts.Size > maxAssetSize {
		return nil, ErrTooLarge
	}
	mime := NormalizeMime(opts.ContentType, opts.Filename)
	if !MimeAllowed(mime) {
		return nil, ErrBadMime
	}
	kind := KindOf(mime, opts.Filename)

	a := &store.Asset{
		ProjectID: projectID,
		OwnerID:   actorID,
		Filename:  opts.Filename,
		Mime:      mime,
		Size:      opts.Size,
		S3Key:     ObjectKey(projectID, opts.Filename),
		Kind:      kind,
	}
	if err := s.obj.Put(ctx, a.S3Key, mime, opts.Reader, opts.Size); err != nil {
		return nil, fmt.Errorf("store put: %w", err)
	}
	if err := s.store.CreateAsset(ctx, a); err != nil {
		_ = s.obj.Delete(ctx, a.S3Key)
		return nil, err
	}
	return a, nil
}

// Open — открывает поток для скачивания (после авторизации).
func (s *Service) Open(ctx context.Context, actorID, assetID uuid.UUID) (io.ReadCloser, *store.Asset, error) {
	a, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := s.proj.Get(ctx, actorID, a.ProjectID); err != nil {
		return nil, nil, err
	}
	rc, err := s.obj.Get(ctx, a.S3Key)
	if err != nil {
		return nil, nil, err
	}
	return rc, a, nil
}

// OpenPublic — публичное чтение ассета: доступно без авторизации, но ТОЛЬКО если
// проект, которому принадлежит файл, опубликован (projects.is_public). Это тот же
// контур, что и публичная история: снятие с публикации закрывает и картинки.
func (s *Service) OpenPublic(ctx context.Context, assetID uuid.UUID) (io.ReadCloser, *store.Asset, error) {
	a, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		return nil, nil, err
	}
	p, err := s.store.GetProject(ctx, a.ProjectID)
	if err != nil {
		return nil, nil, err
	}
	if !p.IsPublic {
		return nil, nil, store.ErrNotFound
	}
	rc, err := s.obj.Get(ctx, a.S3Key)
	if err != nil {
		return nil, nil, err
	}
	return rc, a, nil
}

// List — вложения проекта (для списка файлов и для уборки).
func (s *Service) List(ctx context.Context, actorID, projectID uuid.UUID) ([]store.Asset, error) {
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListAssets(ctx, projectID)
}

// ProjectFileKeys — ключи файлов проекта: то, что нужно убрать, когда проект
// удаляют.
//
// Собирать их обязательно ДО удаления строки проекта: строки вложений уходят
// каскадом (`assets.project_id … ON DELETE CASCADE`), и после удаления о файлах
// уже нечего спросить — они остались бы в хранилище навсегда.
func (s *Service) ProjectFileKeys(ctx context.Context, projectID uuid.UUID) ([]string, error) {
	assets, err := s.store.ListAssets(ctx, projectID)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(assets))
	for _, asset := range assets {
		keys = append(keys, asset.S3Key)
	}
	return keys, nil
}

// DeleteFiles убирает файлы по ключам и возвращает число удалённых.
//
// Ошибку на отдельном файле не прерывает уборку: остальные всё равно надо убрать,
// а потерянный объект найдёт уборщик хранилища (maintenance.Sweeper).
func (s *Service) DeleteFiles(ctx context.Context, keys []string) (int, error) {
	removed := 0
	var firstErr error
	for _, key := range keys {
		if err := s.obj.Delete(ctx, key); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		removed++
	}
	return removed, firstErr
}

// helpers

// NormalizeMime — тип файла по заявленному Content-Type и имени: пустой или общий
// `application/octet-stream` заменяется догадкой по расширению, параметры
// (`; charset=…`) срезаются.
func NormalizeMime(ct, filename string) string {
	ct = strings.TrimSpace(strings.ToLower(ct))
	if ct == "" || ct == "application/octet-stream" {
		if guessed := mime.TypeByExtension(filepath.Ext(filename)); guessed != "" {
			return strings.Split(guessed, ";")[0]
		}
	}
	return strings.Split(ct, ";")[0]
}

// MimeOf — тип файла только по имени (для импорта: Content-Type частей multipart
// доверять нельзя, браузер шлёт его по расширению, а из zip его нет вовсе).
func MimeOf(filename string) string {
	return NormalizeMime("", filename)
}

// MimeAllowed — принимает ли проект файлы такого типа. Единый список для загрузки
// из интерфейса и для импорта: то, что нельзя приложить руками, не должно
// появляться и из папки с md.
func MimeAllowed(m string) bool {
	switch {
	case strings.HasPrefix(m, "image/"):
		return true
	case m == "application/pdf":
		return true
	case strings.HasPrefix(m, "audio/"):
		return true
	case strings.HasPrefix(m, "video/"):
		return true
	case m == "application/json" || m == "text/plain" || m == "image/svg+xml":
		return true
	}
	return false
}

// KindOf — вид вложения для списка файлов проекта.
func KindOf(m, filename string) string {
	switch {
	case strings.HasPrefix(m, "image/"):
		if strings.Contains(filename, "sketch") || strings.HasSuffix(strings.ToLower(filename), ".svg") {
			return "sketch"
		}
		return "image"
	case m == "application/pdf":
		return "pdf"
	case strings.HasPrefix(m, "audio/"):
		return "audio"
	case strings.HasPrefix(m, "video/"):
		return "video"
	}
	return "other"
}

func extFromFilename(name string) string {
	ext := filepath.Ext(name)
	if len(ext) > 8 {
		ext = ".bin"
	}
	return ext
}
