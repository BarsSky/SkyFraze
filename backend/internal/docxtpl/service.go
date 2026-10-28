package docxtpl

// service.go — шаблоны оформления DOCX в проекте (0.91.0, docs/docx-template.md).
//
// Права: загружать, активировать и удалять шаблон может только владелец — шаблон меняет вид
// ВСЕГО документа, который скачивают все участники. Читать список и отчёт может редактор: ему
// нужно знать, какими стилями шаблона набирать маркеры.
//
// Файл хранится в объектном хранилище по своему ключу (`docx-templates/<project>/<id>.docx`), а в
// базе — строка с результатом разбора. Результат разбора не пересчитывается при выгрузке: иначе
// карта стилей могла бы «поехать» между загрузкой (её видел человек) и скачиванием.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

var (
	// ErrForbidden — шаблон меняет только владелец.
	ErrForbidden = errors.New("шаблон меняет только владелец проекта")
	// ErrNotFound — шаблона нет.
	ErrNotFound = errors.New("шаблон не найден")
	// ErrNameTaken — имя занято другим шаблоном проекта.
	ErrNameTaken = errors.New("шаблон с таким названием уже есть в проекте")
)

// Entry — то, что видит интерфейс и ИИ-помощник: имя, файл и отчёт разбора.
type Entry struct {
	ID          uuid.UUID   `json:"id"`
	Name        string      `json:"name"`
	Filename    string      `json:"filename"`
	Size        int64       `json:"size"`
	IsActive    bool        `json:"is_active"`
	UploadedAt  time.Time   `json:"uploaded_at"`
	Styles      []Style     `json:"styles"`
	Page        Page        `json:"page"`
	Report      Report      `json:"report"`
	Placeholder Placeholder `json:"placeholder"`
}

// ActiveTemplate — то, что нужно выгрузке: сам пакет и разбор.
type ActiveTemplate struct {
	Entry
	Raw []byte
}

// Service — хранение и разбор шаблонов.
type Service struct {
	store *store.Store
	obj   storage.ObjectStore
	proj  *projects.Service
}

// New собирает сервис.
func New(st *store.Store, obj storage.ObjectStore, proj *projects.Service) *Service {
	return &Service{store: st, obj: obj, proj: proj}
}

// List — шаблоны проекта (активный первым).
func (s *Service) List(ctx context.Context, userID, projectID uuid.UUID) ([]Entry, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, mapError(err)
	}
	rows, err := s.store.ListDocxTemplates(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(rows))
	for i := range rows {
		out = append(out, entryOf(&rows[i]))
	}
	return out, nil
}

// Upload принимает файл, разбирает его и сохраняет. Шаблон с тем же именем заменяется: человек
// загружает обновлённую версию и ждёт, что имя и активность останутся.
func (s *Service) Upload(
	ctx context.Context, userID, projectID uuid.UUID, name, filename string, size int64, r io.Reader,
) (*Entry, error) {
	if err := s.requireOwner(ctx, userID, projectID); err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.TrimSuffix(path.Base(filename), path.Ext(filename))
		name = strings.TrimSpace(name)
	}
	if name == "" || len([]rune(name)) > 40 {
		return nil, ErrBadTemplate
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxTemplateSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxTemplateSize {
		return nil, ErrBadTemplate
	}
	parsed, err := Parse(filename, data)
	if err != nil {
		return nil, err
	}
	// Без плейсхолдера шаблон бесполезен: вставлять текст некуда, а применить стили шаблона к
	// собственному (встроенному) пакету нельзя. Честный отказ на загрузке лучше, чем
	// «загрузилось, но скачивание не изменилось».
	if !parsed.Placeholder.Found {
		return nil, fmt.Errorf("%w — добавьте его отдельной строкой и загрузите снова", ErrNoPlaceholder)
	}

	stylesJSON, _ := json.Marshal(parsed.Styles)
	placeholderJSON, _ := json.Marshal(parsed.Placeholder)
	pageJSON, _ := json.Marshal(parsed.Page)
	reportJSON, _ := json.Marshal(parsed.Report)

	key := "docx-templates/" + projectID.String() + "/" + uuid.NewString() + ".docx"
	if err := s.obj.Put(ctx, key, docxMime, bytes.NewReader(data), int64(len(data))); err != nil {
		return nil, err
	}

	row := store.DocxTemplate{
		ProjectID: projectID, Name: name, S3Key: key, Filename: path.Base(filename),
		Size: int64(len(data)), Styles: stylesJSON, Placeholder: placeholderJSON,
		Page: pageJSON, Report: reportJSON, UploadedBy: &userID,
	}
	// Тот же проект, то же имя — заменяем файл у существующей строки (id не меняется).
	existing, err := s.findByName(ctx, projectID, name)
	if err == nil && existing != nil {
		oldKey := existing.S3Key
		updated, replaceErr := s.store.ReplaceDocxTemplateFile(ctx, projectID, existing.ID, row)
		if replaceErr != nil {
			_ = s.obj.Delete(ctx, key)
			if errors.Is(replaceErr, store.ErrDocxTemplateExists) {
				return nil, ErrNameTaken
			}
			return nil, replaceErr
		}
		if oldKey != "" && oldKey != key {
			_ = s.obj.Delete(ctx, oldKey)
		}
		entry := entryOf(updated)
		return &entry, nil
	}
	created, err := s.store.CreateDocxTemplate(ctx, row)
	if err != nil {
		_ = s.obj.Delete(ctx, key)
		if errors.Is(err, store.ErrDocxTemplateExists) {
			return nil, ErrNameTaken
		}
		return nil, err
	}
	entry := entryOf(created)
	return &entry, nil
}

// Activate делает шаблон активным: именно им собирается скачивание.
func (s *Service) Activate(ctx context.Context, userID, projectID, id uuid.UUID) ([]Entry, error) {
	if err := s.requireOwner(ctx, userID, projectID); err != nil {
		return nil, err
	}
	if err := s.store.ActivateDocxTemplate(ctx, projectID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return s.List(ctx, userID, projectID)
}

// Delete убирает шаблон и его файл. Если шаблон был активным, активным становится другой.
func (s *Service) Delete(ctx context.Context, userID, projectID, id uuid.UUID) ([]Entry, error) {
	if err := s.requireOwner(ctx, userID, projectID); err != nil {
		return nil, err
	}
	key, err := s.store.DeleteDocxTemplate(ctx, projectID, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if key != "" {
		_ = s.obj.Delete(ctx, key)
	}
	return s.List(ctx, userID, projectID)
}

// Active — активный шаблон с пакетом файла. nil означает «шаблона нет» — выгрузка соберёт
// документ встроенным оформлением. Права вызывающего уже проверены выше по стеку (экспорт).
func (s *Service) Active(ctx context.Context, projectID uuid.UUID) (*ActiveTemplate, error) {
	row, err := s.store.ActiveDocxTemplate(ctx, projectID)
	if err != nil || row == nil {
		return nil, err
	}
	rc, err := s.obj.Get(ctx, row.S3Key)
	if err != nil {
		// Файл потерян: шаблон «есть», но применить его нельзя. Честнее сказать выгрузке, что
		// шаблона нет, чем отдать 500 на скачивании.
		return nil, nil
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return nil, nil
	}
	entry := entryOf(row)
	return &ActiveTemplate{Entry: entry, Raw: raw}, nil
}

// ParagraphStyles — имена стилей абзаца активного шаблона (0.92.0).
//
// Нужны ИИ-помощнику: он объясняет их модели, чтобы маркер `<!-- sf:style=… -->` ссылался на
// стиль, который в шаблоне есть. Файл шаблона при этом не читается — разбор сохранён в строке
// при загрузке, и пересчитывать его незачем.
func (s *Service) ParagraphStyles(ctx context.Context, projectID uuid.UUID) ([]string, error) {
	row, err := s.store.ActiveDocxTemplate(ctx, projectID)
	if err != nil || row == nil {
		return nil, err
	}
	var styles []Style
	if err := json.Unmarshal(row.Styles, &styles); err != nil {
		// Битый JSON стилей — не повод ронять ответ помощника: он просто не увидит имён.
		return nil, nil
	}
	seen := make(map[string]bool, len(styles))
	out := make([]string, 0, len(styles))
	for _, style := range styles {
		if style.Type != "paragraph" {
			// Стиль знака или таблицы к абзацу не применить: Word молча оставил бы текст как есть.
			continue
		}
		name := strings.TrimSpace(style.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out, nil
}

func (s *Service) requireOwner(ctx context.Context, userID, projectID uuid.UUID) error {
	role, err := s.proj.Role(ctx, userID, projectID)
	if err != nil {
		return mapError(err)
	}
	if role != store.RoleOwner {
		return ErrForbidden
	}
	return nil
}

func (s *Service) findByName(ctx context.Context, projectID uuid.UUID, name string) (*store.DocxTemplate, error) {
	rows, err := s.store.ListDocxTemplates(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		if strings.EqualFold(strings.TrimSpace(rows[i].Name), strings.TrimSpace(name)) {
			return &rows[i], nil
		}
	}
	return nil, nil
}

func entryOf(row *store.DocxTemplate) Entry {
	entry := Entry{
		ID: row.ID, Name: row.Name, Filename: row.Filename, Size: row.Size,
		IsActive: row.IsActive, UploadedAt: row.UploadedAt,
	}
	_ = json.Unmarshal(row.Styles, &entry.Styles)
	_ = json.Unmarshal(row.Placeholder, &entry.Placeholder)
	_ = json.Unmarshal(row.Page, &entry.Page)
	_ = json.Unmarshal(row.Report, &entry.Report)
	if entry.Report.Styles == nil {
		entry.Report.Styles = entry.Styles
	}
	return entry
}

func mapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, projects.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, projects.ErrNotFound), errors.Is(err, store.ErrNotFound):
		return ErrNotFound
	default:
		return err
	}
}

// docxMime — MIME шаблона (тот же, что у готового документа).
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
