package assets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
//
// Файл с тем же содержимым второй раз не пишется: хеш считается по содержимому во
// время записи, и если такой файл уже есть (в любом проекте), новая строка вложений
// ссылается на существующий объект хранилища. Метаданные при этом свои: имя файла,
// владелец и проект у каждой строки собственные (миграция 0007).
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

	// Хеш считаем на лету, пока файл пишется: второй раз читать его незачем.
	hasher := sha256.New()
	key := ObjectKey(projectID, opts.Filename)
	if err := s.obj.Put(ctx, key, mime, io.TeeReader(opts.Reader, hasher), opts.Size); err != nil {
		return nil, fmt.Errorf("store put: %w", err)
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	// Такой файл уже есть — свой только что записанный убираем, а строку связываем с
	// существующим объектом. Дешевле потерять одну запись на диск, чем читать файл в
	// память целиком ради хеша до записи (файлы бывают до 50 МБ).
	existing, err := s.store.FindAssetByHash(ctx, hash)
	if err != nil {
		_ = s.obj.Delete(ctx, key)
		return nil, err
	}
	writeOwn := existing == nil
	if existing != nil {
		_ = s.obj.Delete(ctx, key)
		key = existing.S3Key
	}

	a := &store.Asset{
		ProjectID:   projectID,
		OwnerID:     actorID,
		Filename:    opts.Filename,
		Mime:        mime,
		Size:        opts.Size,
		S3Key:       key,
		Kind:        kind,
		ContentHash: &hash,
	}
	if err := s.store.CreateAsset(ctx, a); err != nil {
		if writeOwn {
			_ = s.obj.Delete(ctx, key)
		}
		return nil, err
	}
	return a, nil
}

// StoreFileOptions — готовый файл для записи в проект (импорт папки с md).
type StoreFileOptions struct {
	ProjectID uuid.UUID
	OwnerID   uuid.UUID
	Filename  string
	Mime      string
	Kind      string
	Data      []byte
}

// StoreFile кладёт в проект готовый файл — тем же путём, что и загрузка из
// интерфейса, включая дедупликацию по содержимому: иначе импорт обходил бы её
// стороной, и один и тот же файл лежал бы в хранилище дважды.
func (s *Service) StoreFile(ctx context.Context, opts StoreFileOptions) (*store.Asset, error) {
	if opts.Mime == "" {
		opts.Mime = MimeOf(opts.Filename)
	}
	if opts.Kind == "" {
		opts.Kind = KindOf(opts.Mime, opts.Filename)
	}
	digest := sha256.Sum256(opts.Data)
	hash := hex.EncodeToString(digest[:])

	key := ObjectKey(opts.ProjectID, opts.Filename)
	existing, err := s.store.FindAssetByHash(ctx, hash)
	if err != nil {
		return nil, err
	}
	writeOwn := existing == nil
	if existing != nil {
		// Файл уже есть — второй не пишем, ссылаемся на существующий.
		key = existing.S3Key
	} else if err := s.obj.Put(ctx, key, opts.Mime, bytes.NewReader(opts.Data), int64(len(opts.Data))); err != nil {
		return nil, fmt.Errorf("store put: %w", err)
	}

	asset := &store.Asset{
		ProjectID:   opts.ProjectID,
		OwnerID:     opts.OwnerID,
		Filename:    opts.Filename,
		Mime:        opts.Mime,
		Size:        int64(len(opts.Data)),
		S3Key:       key,
		Kind:        opts.Kind,
		ContentHash: &hash,
	}
	if err := s.store.CreateAsset(ctx, asset); err != nil {
		if writeOwn {
			_ = s.obj.Delete(ctx, key)
		}
		return nil, err
	}
	return asset, nil
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

// DeleteUnreferencedFiles убирает файлы, на которые больше не ссылается ни одна
// строка вложений, и возвращает число удалённых.
//
// Проверка ссылок обязательна после дедупликации: одним файлом могут пользоваться
// несколько проектов, и удаление одного из них не должно уносить картинку у
// остальных. Вызывается ПОСЛЕ удаления строк (проект уносит свои вложения
// каскадом) — тогда «сколько осталось ссылок» и есть ответ на вопрос «нужен ли
// файл ещё кому-нибудь».
//
// Ошибка на отдельном файле не прерывает уборку: остальные всё равно надо убрать,
// а потерянный объект найдёт уборщик хранилища (maintenance.Sweeper).
func (s *Service) DeleteUnreferencedFiles(ctx context.Context, keys []string) (int, error) {
	removed := 0
	var firstErr error
	for _, key := range keys {
		if key == "" {
			continue
		}
		refs, err := s.store.CountAssetsByKey(ctx, key)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if refs > 0 {
			continue
		}
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
