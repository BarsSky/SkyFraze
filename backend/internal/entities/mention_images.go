package entities

// mention_images.go — картинка у упоминания карточки в кадре (0.93.0, docs/entity-links.md §3.4.1).
//
// Карточка упоминания уже знает «карточка + кадр + глава»; здесь добавляется «как это выглядит»:
// портрет персонажа, вид места, обложка темы. Хранится только СВЯЗЬ — файл берётся из вложений
// проекта, поэтому квота, пережатие, дедупликация и архив переноса работают как раньше.
//
// Правила, которые живут здесь, а не в обработчике:
//   * одна картинка на пару «карточка × кадр» (уникальный индекс в базе, здесь — замена);
//   * карточка, кадр и файл обязаны принадлежать ЭТОМУ проекту: иначе через чужой идентификатор
//     можно было бы привязать картинку из другого проекта;
//   * привязывать можно только картинку (image/*): pdf или архив в качестве «портрета» — ошибка
//     выбора, а не задумка;
//   * читать может участник (viewer+), менять — редактор и выше: это правка вида карточки.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// ErrMentionImageTarget — карточка, кадр или файл не из этого проекта (или их нет).
var ErrMentionImageTarget = errors.New("карточка, кадр или файл не найдены в проекте")

// ErrNotImage — вложение не картинка: привязывать можно только изображения.
var ErrNotImage = errors.New("привязать можно только картинку")

// MentionImage — картинка упоминания в том виде, в каком её видит интерфейс.
type MentionImage struct {
	EntityID uuid.UUID `json:"entity_id"`
	EventID  uuid.UUID `json:"event_id"`
	AssetID  uuid.UUID `json:"asset_id"`
}

// MentionImages — все привязки проекта (читает любой участник).
//
// Одним списком, а не «дай картинку этой пары»: панель «Связи» показывает карточки всех
// персонажей сразу, и запрос на каждую пару означал бы N обращений ради одного экрана.
func (s *Service) MentionImages(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]MentionImage, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	rows, err := s.store.ListMentionImages(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]MentionImage, 0, len(rows))
	for _, row := range rows {
		out = append(out, MentionImage{EntityID: row.EntityID, EventID: row.EventID, AssetID: row.AssetID})
	}
	return out, nil
}

// SetMentionImage привязывает картинку к паре «карточка × кадр», заменяя прежнюю.
func (s *Service) SetMentionImage(
	ctx context.Context, userID, projectID, entityID, eventID, assetID uuid.UUID,
) (*MentionImage, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	if _, err := s.store.EntityByID(ctx, projectID, entityID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrMentionImageTarget
		}
		return nil, err
	}
	if _, err := s.store.GetEvent(ctx, projectID, eventID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrMentionImageTarget
		}
		return nil, err
	}
	asset, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrMentionImageTarget
		}
		return nil, err
	}
	// Проект файла проверяем отдельно: GetAsset ищет по id, а id чужого вложения угадать нельзя,
	// но «привязал картинку из другого проекта» — это уже утечка, если не проверить.
	if asset.ProjectID != projectID {
		return nil, ErrMentionImageTarget
	}
	if !strings.HasPrefix(asset.Mime, "image/") {
		return nil, fmt.Errorf("%w: «%s» — %s", ErrNotImage, asset.Filename, asset.Mime)
	}
	row, err := s.store.SetMentionImage(ctx, projectID, entityID, eventID, assetID, userID)
	if err != nil {
		return nil, err
	}
	return &MentionImage{EntityID: row.EntityID, EventID: row.EventID, AssetID: row.AssetID}, nil
}

// ClearMentionImage отвязывает картинку. false — привязки не было (повторное «отвязать» из двух
// вкладок — не ошибка).
func (s *Service) ClearMentionImage(
	ctx context.Context, userID, projectID, entityID, eventID uuid.UUID,
) (bool, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return false, err
	}
	return s.store.DeleteMentionImage(ctx, projectID, entityID, eventID)
}
