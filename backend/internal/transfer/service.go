// Package transfer — перенос проекта между инсталляциями SkyFraze.
//
// Экспорт собирает один ZIP-архив, который потом можно загрузить на другом
// стенде: метаданные проекта, дерево событий, CRDT-снапшот (в нём живут тексты,
// фон кадров и привязки вложений) и сами файлы вложений.
//
// Почему идентификаторы сохраняются как есть: CRDT-снапшот — бинарный Yjs-update,
// и переписать ссылки на события/вложения внутри него без парсера Yjs невозможно.
// Поэтому импорт переносит id один в один, а повторную загрузку того же архива
// распознаёт по уже существующим id и объясняет это пользователю (ErrAlreadyImported).
package transfer

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

// Формат и версия архива. Версия позволяет менять структуру, не ломая старые файлы.
const (
	FormatName    = "skyfraze-project"
	FormatVersion = 1

	manifestName = "manifest.json"
	stateName    = "state.bin"
	assetsDir    = "assets/"

	// MaxBundleSize — потолок размера архива (nginx пускает столько же).
	MaxBundleSize = 200 << 20 // 200 MB
	// maxEntrySize — потолок на один файл внутри архива (совпадает с лимитом ассета).
	maxEntrySize = 50 << 20
	// maxEvents / maxAssets защищают от архива-«бомбы» с миллионом записей.
	maxEvents = 5000
	maxAssets = 500
)

var (
	ErrBadBundle         = errors.New("bad bundle")
	ErrUnsupportedFormat = errors.New("unsupported bundle format")
	ErrTooLarge          = errors.New("bundle too large")
	ErrAlreadyImported   = errors.New("bundle already imported")
	ErrForbidden         = errors.New("forbidden")
	ErrNotFound          = errors.New("not found")
)

// Manifest — содержимое manifest.json.
type Manifest struct {
	Format     string        `json:"format"`
	Version    int           `json:"version"`
	ExportedAt time.Time     `json:"exported_at"`
	App        string        `json:"app"`
	Project    ProjectMeta   `json:"project"`
	Events     []EventRecord `json:"events"`
	Assets     []AssetRecord `json:"assets"`
	HasState   bool          `json:"has_state"`
}

type ProjectMeta struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type EventRecord struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	Position  int        `json:"position"`
	Depth     int16      `json:"depth"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	EventDate *time.Time `json:"event_date,omitempty"`
}

type AssetRecord struct {
	ID       uuid.UUID `json:"id"`
	Filename string    `json:"filename"`
	Mime     string    `json:"mime"`
	Size     int64     `json:"size"`
	Kind     string    `json:"kind"`
	Width    *int      `json:"width,omitempty"`
	Height   *int      `json:"height,omitempty"`
	// File — путь внутри архива (assets/<id>).
	File string `json:"file"`
}

// ExportInfo — что получилось выгрузить (для заголовков ответа и лога).
type ExportInfo struct {
	Title    string
	Events   int
	Assets   int
	HasState bool
	Bytes    int64
	Filename string
}

// Result — итог импорта.
type Result struct {
	Project  *store.Project `json:"project"`
	Events   int            `json:"events"`
	Assets   int            `json:"assets"`
	HasState bool           `json:"has_state"`
}

type Service struct {
	store *store.Store
	obj   storage.ObjectStore
	proj  *projects.Service
}

func New(s *store.Store, obj storage.ObjectStore, proj *projects.Service) *Service {
	return &Service{store: s, obj: obj, proj: proj}
}

// SlugifyFileName — безопасное имя файла из заголовка проекта (кириллица
// отбрасывается, поэтому при пустом результате используется «project»).
func SlugifyFileName(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case r == ' ' || r == '-' || r == '_' || r == '.':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
		if b.Len() >= 40 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "project"
	}
	return out
}

// Export собирает архив проекта в w. Требуется роль viewer+ (читатель и так видит
// всё содержимое проекта, поэтому выгрузка не расширяет его права).
func (s *Service) Export(ctx context.Context, userID, projectID uuid.UUID, w io.Writer) (*ExportInfo, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return nil, ErrForbidden
		}
		return nil, err
	}
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	assets, err := s.store.ListAssets(ctx, projectID)
	if err != nil {
		return nil, err
	}
	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}

	m := Manifest{
		Format:     FormatName,
		Version:    FormatVersion,
		ExportedAt: time.Now().UTC(),
		App:        "SkyFraze",
		Project:    ProjectMeta{Title: p.Title, Description: p.Description},
		Events:     make([]EventRecord, 0, len(evs)),
		Assets:     make([]AssetRecord, 0, len(assets)),
	}
	for _, e := range evs {
		m.Events = append(m.Events, EventRecord{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position, Depth: e.Depth,
			Title: e.Title, Body: e.Body, EventDate: e.EventDate,
		})
	}
	for _, a := range assets {
		m.Assets = append(m.Assets, AssetRecord{
			ID: a.ID, Filename: a.Filename, Mime: a.Mime, Size: a.Size, Kind: a.Kind,
			Width: a.Width, Height: a.Height, File: assetsDir + a.ID.String(),
		})
	}
	var stateBytes []byte
	if state != nil && len(state.YjsState) > 0 {
		m.HasState = true
		stateBytes = state.YjsState
	}

	counter := &countingWriter{w: w}
	zw := zip.NewWriter(counter)

	manifestBytes, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipFile(zw, manifestName, manifestBytes); err != nil {
		return nil, err
	}
	if m.HasState {
		if err := writeZipFile(zw, stateName, state.YjsState); err != nil {
			return nil, err
		}
	}
	for _, a := range assets {
		rc, err := s.obj.Get(ctx, a.S3Key)
		if err != nil {
			// Файла нет в хранилище — не роняем весь экспорт: без него проект
			// всё равно переносится, а в лог попадает причина.
			continue
		}
		if err := writeZipStream(zw, assetsDir+a.ID.String(), rc); err != nil {
			rc.Close()
			return nil, err
		}
		rc.Close()
	}

	// Человекочитаемая версия проекта: та же лента, что отдаёт
	// GET /api/projects/{id}/export.md?assets=1, но ссылки указывают на файлы
	// ЭТОГО архива (assets/<id>). Манифест и раскладку вложений не меняем —
	// старые версии SkyFraze читают файлы по полю file, а новые просто находят
	// рядом со манифестом ещё и story.md со story/. Импорт переноса эти файлы
	// игнорирует (он ходит только по манифесту).
	storyLane, storyFiles := newStory(p, evs, assets, stateBytes).archiveStoryFiles()
	if err := writeZipFile(zw, storyFileName, storyLane); err != nil {
		return nil, err
	}
	for _, f := range storyFiles {
		if err := writeZipFile(zw, f.Name, f.Content); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	return &ExportInfo{
		Title:    p.Title,
		Events:   len(m.Events),
		Assets:   len(m.Assets),
		HasState: m.HasState,
		Bytes:    counter.n,
		Filename: SlugifyFileName(p.Title) + ".skyfraze.zip",
	}, nil
}

// ParsedBundle — разобранный архив, готовый к переносу в базу.
type ParsedBundle struct {
	Manifest Manifest
	State    []byte
	// AssetFiles — содержимое вложений по id (читается лениво из zip.Reader).
	zip *zip.Reader
}

// ParseBundle читает архив и проверяет его структуру. Ничего не пишет.
func ParseBundle(r io.ReaderAt, size int64) (*ParsedBundle, error) {
	if size <= 0 || size > MaxBundleSize {
		return nil, ErrTooLarge
	}
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadBundle, err)
	}

	b := &ParsedBundle{zip: zr}
	var total int64
	for _, f := range zr.File {
		if f.UncompressedSize64 > maxEntrySize {
			return nil, fmt.Errorf("%w: файл %s больше %d МБ", ErrTooLarge, f.Name, maxEntrySize>>20)
		}
		total += int64(f.UncompressedSize64)
		if total > MaxBundleSize*4 {
			return nil, ErrTooLarge
		}
		switch f.Name {
		case manifestName:
			data, err := readZipFile(f, 4<<20)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(data, &b.Manifest); err != nil {
				return nil, fmt.Errorf("%w: manifest.json не разобран: %v", ErrBadBundle, err)
			}
		case stateName:
			data, err := readZipFile(f, MaxBundleSize)
			if err != nil {
				return nil, err
			}
			b.State = data
		}
	}

	m := b.Manifest
	if m.Format != FormatName {
		return nil, fmt.Errorf("%w: это не архив SkyFraze (format=%q)", ErrUnsupportedFormat, m.Format)
	}
	if m.Version <= 0 || m.Version > FormatVersion {
		return nil, fmt.Errorf("%w: версия архива %d не поддерживается", ErrUnsupportedFormat, m.Version)
	}
	if len(m.Events) > maxEvents || len(m.Assets) > maxAssets {
		return nil, fmt.Errorf("%w: в архиве %d событий и %d вложений", ErrTooLarge, len(m.Events), len(m.Assets))
	}
	return b, nil
}

// AssetReader отдаёт файл вложения из архива.
func (b *ParsedBundle) AssetReader(a AssetRecord) (io.ReadCloser, error) {
	name := a.File
	if name == "" {
		name = assetsDir + a.ID.String()
	}
	for _, f := range b.zip.File {
		if f.Name == name {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("%w: файл %s отсутствует в архиве", ErrBadBundle, name)
}

// Import создаёт НОВЫЙ проект у пользователя userID по разобранному архиву.
//
// Импорт никогда не пишет в существующий проект: если id событий/вложений уже
// заняты (повторная загрузка того же архива), возвращается ErrAlreadyImported —
// «перезаписать» чужой проект молча нельзя, а отличить «свой» от «чужого» по
// архиву невозможно.
func (s *Service) Import(ctx context.Context, userID uuid.UUID, b *ParsedBundle) (*Result, error) {
	m := b.Manifest

	// 1. Проверка структуры дерева теми же правилами, что и обычная синхронизация.
	nodes := make([]events.NodeInput, 0, len(m.Events))
	eventIDs := make([]uuid.UUID, 0, len(m.Events))
	seen := make(map[uuid.UUID]bool, len(m.Events))
	for _, e := range m.Events {
		if e.ID == uuid.Nil || seen[e.ID] {
			return nil, fmt.Errorf("%w: некорректный или повторяющийся id события", ErrBadBundle)
		}
		seen[e.ID] = true
		eventIDs = append(eventIDs, e.ID)
		nodes = append(nodes, events.NodeInput{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position,
			Title: e.Title, Body: e.Body, EventDate: e.EventDate,
		})
	}
	normalized, err := events.NormalizeTree(nodes)
	if err != nil {
		return nil, fmt.Errorf("%w: дерево событий невалидно: %v", ErrBadBundle, err)
	}

	// 2. Конфликты id: значит, этот архив уже импортировали в эту базу.
	assetIDs := make([]uuid.UUID, 0, len(m.Assets))
	for _, a := range m.Assets {
		if a.ID == uuid.Nil {
			return nil, fmt.Errorf("%w: у вложения нет id", ErrBadBundle)
		}
		assetIDs = append(assetIDs, a.ID)
	}
	conflictEvents, err := s.store.ExistingEventIDs(ctx, eventIDs)
	if err != nil {
		return nil, err
	}
	conflictAssets, err := s.store.ExistingAssetIDs(ctx, assetIDs)
	if err != nil {
		return nil, err
	}
	if len(conflictEvents) > 0 || len(conflictAssets) > 0 {
		return nil, fmt.Errorf("%w: в этой базе уже есть %d событий и %d вложений из архива",
			ErrAlreadyImported, len(conflictEvents), len(conflictAssets))
	}

	// 3. Новый проект у импортирующего.
	title := strings.TrimSpace(m.Project.Title)
	if title == "" {
		title = "Импортированный проект"
	}
	p, err := s.proj.Create(ctx, userID, title, m.Project.Description)
	if err != nil {
		return nil, err
	}
	// Дальше любая ошибка должна убирать за собой: иначе останутся осиротевшие
	// файлы в хранилище и наполовину импортированный проект.
	written := make([]string, 0, len(m.Assets))
	cleanup := func() {
		for _, key := range written {
			_ = s.obj.Delete(ctx, key)
		}
		_ = s.store.DeleteProject(ctx, p.ID)
	}

	// 4. Вложения: файлы в хранилище + строки в БД (id сохраняем — на них
	//    ссылается CRDT-снапшот).
	for _, a := range m.Assets {
		rc, err := b.AssetReader(a)
		if err != nil {
			cleanup()
			return nil, err
		}
		key := fmt.Sprintf("%s/%s", p.ID.String(), a.ID.String())
		putErr := s.obj.Put(ctx, key, a.Mime, rc, a.Size)
		rc.Close()
		if putErr != nil {
			cleanup()
			return nil, fmt.Errorf("сохранить файл вложения: %w", putErr)
		}
		written = append(written, key)

		asset := &store.Asset{
			ID: a.ID, ProjectID: p.ID, OwnerID: userID, Filename: a.Filename,
			Mime: a.Mime, Size: a.Size, S3Key: key, Kind: a.Kind, Width: a.Width, Height: a.Height,
		}
		if err := s.store.InsertAsset(ctx, asset); err != nil {
			cleanup()
			return nil, err
		}
	}

	// 5. Дерево событий.
	rows := make([]store.Event, 0, len(normalized))
	for _, n := range normalized {
		rows = append(rows, store.Event{
			ID: n.ID, ProjectID: p.ID, ParentID: n.ParentID, Position: n.Position,
			Depth: n.Depth, Title: n.Title, Body: n.Body, EventDate: n.EventDate,
			CreatedBy: &userID, UpdatedBy: &userID,
		})
	}
	if len(rows) > 0 {
		if err := s.store.ReplaceEventTree(ctx, p.ID, userID, rows); err != nil {
			cleanup()
			return nil, err
		}
	}

	// 6. CRDT-снапшот: без него пропадут тексты в CRDT, фон кадров и привязки
	//    вложений (в базе их нет).
	hasState := len(b.State) > 0
	if hasState {
		if _, err := s.store.SaveProjectEventState(ctx, p.ID, userID, b.State, 0); err != nil {
			cleanup()
			return nil, err
		}
	}

	return &Result{Project: p, Events: len(rows), Assets: len(m.Assets), HasState: hasState}, nil
}

// ---------- вспомогательное ----------

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func writeZipFile(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func writeZipStream(zw *zip.Writer, name string, r io.Reader) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, r)
	return err
}

func readZipFile(f *zip.File, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(rc, limit)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
