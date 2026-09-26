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
	mime := normalizeMime(opts.ContentType, opts.Filename)
	if !allowedMime(mime) {
		return nil, ErrBadMime
	}
	kind := detectKind(mime, opts.Filename)

	a := &store.Asset{
		ProjectID: projectID,
		OwnerID:   actorID,
		Filename:  opts.Filename,
		Mime:      mime,
		Size:      opts.Size,
		S3Key:     fmt.Sprintf("%s/%s", projectID.String(), uuid.NewString()+extFromFilename(opts.Filename)),
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

func (s *Service) List(ctx context.Context, actorID, projectID uuid.UUID) ([]store.Asset, error) {
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListAssets(ctx, projectID)
}

// helpers

func normalizeMime(ct, filename string) string {
	ct = strings.TrimSpace(strings.ToLower(ct))
	if ct == "" || ct == "application/octet-stream" {
		if guessed := mime.TypeByExtension(filepath.Ext(filename)); guessed != "" {
			return strings.Split(guessed, ";")[0]
		}
	}
	return strings.Split(ct, ";")[0]
}

func allowedMime(m string) bool {
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

func detectKind(m, filename string) string {
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
