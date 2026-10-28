package store

// store_docx_templates.go — шаблоны оформления DOCX (миграция 0036, docs/docx-template.md).
//
// Отличие от вложений: шаблон — НАСТРОЙКА проекта (как роль помощника), а не содержимое книги.
// Поэтому своя таблица, свой ключ в хранилище и своя жизнь: в архив проекта он не едет, в списке
// файлов проекта не показывается, а при удалении строки файл не убирается молча.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DocxTemplate — загруженный шаблон оформления вместе с результатом разбора.
type DocxTemplate struct {
	ID          uuid.UUID  `db:"id" json:"id"`
	ProjectID   uuid.UUID  `db:"project_id" json:"-"`
	Name        string     `db:"name" json:"name"`
	S3Key       string     `db:"s3_key" json:"-"`
	Filename    string     `db:"filename" json:"filename"`
	Size        int64      `db:"size" json:"size"`
	Styles      []byte     `db:"styles" json:"-"`
	Placeholder []byte     `db:"placeholder" json:"-"`
	Page        []byte     `db:"page" json:"-"`
	Report      []byte     `db:"report" json:"-"`
	IsActive    bool       `db:"is_active" json:"is_active"`
	UploadedBy  *uuid.UUID `db:"uploaded_by" json:"uploaded_by,omitempty"`
	UploadedAt  time.Time  `db:"uploaded_at" json:"uploaded_at"`
}

// ErrDocxTemplateExists — шаблон с таким именем уже есть в проекте.
var ErrDocxTemplateExists = errors.New("шаблон с таким названием уже есть в проекте")

const docxTemplateColumns = `id, project_id, name, s3_key, filename, size, styles, placeholder, page, report, is_active, uploaded_by, uploaded_at`

// ListDocxTemplates — шаблоны проекта: активный первым, дальше по названию.
func (s *Store) ListDocxTemplates(ctx context.Context, projectID uuid.UUID) ([]DocxTemplate, error) {
	return qAll[DocxTemplate](ctx, s.Pool,
		`SELECT `+docxTemplateColumns+` FROM project_docx_templates
		  WHERE project_id = $1
		  ORDER BY is_active DESC, lower(name)`, projectID)
}

// DocxTemplateByID — один шаблон проекта.
func (s *Store) DocxTemplateByID(ctx context.Context, projectID, id uuid.UUID) (*DocxTemplate, error) {
	return qOne[DocxTemplate](ctx, s.Pool,
		`SELECT `+docxTemplateColumns+` FROM project_docx_templates
		  WHERE project_id = $1 AND id = $2`, projectID, id)
}

// ActiveDocxTemplate — активный шаблон проекта (nil, если шаблонов нет).
func (s *Store) ActiveDocxTemplate(ctx context.Context, projectID uuid.UUID) (*DocxTemplate, error) {
	tpl, err := qOne[DocxTemplate](ctx, s.Pool,
		`SELECT `+docxTemplateColumns+` FROM project_docx_templates
		  WHERE project_id = $1 AND is_active`, projectID)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return tpl, err
}

// CreateDocxTemplate заводит шаблон. Первый шаблон проекта сразу становится активным: иначе
// человек загрузил бы файл и не понял, почему скачивание не изменилось.
func (s *Store) CreateDocxTemplate(ctx context.Context, t DocxTemplate) (*DocxTemplate, error) {
	row, err := qOne[DocxTemplate](ctx, s.Pool,
		`INSERT INTO project_docx_templates
		   (project_id, name, s3_key, filename, size, styles, placeholder, page, report,
		    is_active, uploaded_by)
		 VALUES ($1, btrim($2), $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
		         NOT EXISTS (SELECT 1 FROM project_docx_templates WHERE project_id = $1),
		         $10)
		 RETURNING `+docxTemplateColumns,
		t.ProjectID, t.Name, t.S3Key, t.Filename, t.Size,
		string(t.Styles), string(t.Placeholder), string(t.Page), string(t.Report), t.UploadedBy)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrDocxTemplateExists
		}
		return nil, err
	}
	return row, nil
}

// ActivateDocxTemplate делает шаблон активным, снимая флаг с остальных, одной транзакцией:
// два активных шаблона сделали бы выгрузку неопределённой.
func (s *Store) ActivateDocxTemplate(ctx context.Context, projectID, id uuid.UUID) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE project_docx_templates SET is_active = false
		  WHERE project_id = $1 AND is_active AND id <> $2`, projectID, id)
	if err != nil {
		return err
	}
	_ = tag
	res, err := tx.Exec(ctx,
		`UPDATE project_docx_templates SET is_active = true
		  WHERE project_id = $1 AND id = $2`, projectID, id)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// DeleteDocxTemplate убирает шаблон; если он был активным, активным становится другой (если есть),
// иначе шаблонов не остаётся и скачивание вернётся к встроенному оформлению.
func (s *Store) DeleteDocxTemplate(ctx context.Context, projectID, id uuid.UUID) (string, error) {
	var key string
	err := s.Pool.QueryRow(ctx,
		`DELETE FROM project_docx_templates WHERE project_id = $1 AND id = $2 RETURNING s3_key`,
		projectID, id).Scan(&key)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	// Другой шаблон становится активным: «шаблонов нет» при непустом списке было бы неправдой.
	if _, err := s.Pool.Exec(ctx,
		`UPDATE project_docx_templates SET is_active = true
		  WHERE project_id = $1 AND NOT EXISTS (
		    SELECT 1 FROM project_docx_templates WHERE project_id = $1 AND is_active)
		  AND id = (SELECT id FROM project_docx_templates WHERE project_id = $1
		             ORDER BY uploaded_at DESC LIMIT 1)`, projectID); err != nil {
		return "", err
	}
	return key, nil
}

// ReplaceDocxTemplateFile заменяет файл и результат разбора у шаблона с тем же именем: человек
// загружает обновлённую версию шаблона и ждёт, что имя и активность останутся прежними.
func (s *Store) ReplaceDocxTemplateFile(
	ctx context.Context, projectID, id uuid.UUID, item DocxTemplate,
) (*DocxTemplate, error) {
	return qOne[DocxTemplate](ctx, s.Pool,
		`UPDATE project_docx_templates
		    SET s3_key = $3, filename = $4, size = $5,
		        styles = $6::jsonb, placeholder = $7::jsonb, page = $8::jsonb, report = $9::jsonb,
		        uploaded_by = $10, uploaded_at = now()
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+docxTemplateColumns,
		projectID, id, item.S3Key, item.Filename, item.Size,
		string(item.Styles), string(item.Placeholder), string(item.Page), string(item.Report),
		item.UploadedBy)
}

// RenameDocxTemplate — переименование (ошибку занятого имени отдаём отдельно).
func (s *Store) RenameDocxTemplate(ctx context.Context, projectID, id uuid.UUID, name string) (*DocxTemplate, error) {
	row, err := qOne[DocxTemplate](ctx, s.Pool,
		`UPDATE project_docx_templates SET name = btrim($3)
		  WHERE project_id = $1 AND id = $2
		  RETURNING `+docxTemplateColumns, projectID, id, strings.TrimSpace(name))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrDocxTemplateExists
		}
		return nil, err
	}
	return row, nil
}
