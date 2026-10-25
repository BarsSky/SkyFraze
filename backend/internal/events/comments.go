package events

// comments.go — обсуждение кадров (миграция 0018).
//
// Что это и чего здесь нет. Комментарий — разговор о кадре, а не часть кадра: он не
// попадает ни в CRDT-документ, ни в книгу, ни в Markdown-выгрузку. Поэтому путь записи
// простой (обычный SQL), а не «правка документа», и realtime-комнат он не касается.
//
// Кто что может:
//   - читать обсуждение — любой участник проекта, который вообще может его читать
//     (`RequireViewer`): комментарии не секретнее самого текста;
//   - писать и удалять свои — только редактор и владелец (`RequireEditor`): читатель,
//     которому открыли доступ на просмотр, не должен оставлять следов в проекте;
//   - удалить чужой комментарий нельзя никому, включая владельца проекта. Это осознанно:
//     «автор сказал» — факт, а не то, что можно переписать. Владелец всегда может ответить.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// MaxCommentRunes — предел на комментарий. Разговор — не текст главы: 4000 знаков
// хватает на подробное замечание, а простыню под кадром никто не читает.
const MaxCommentRunes = 4000

// ErrEventNotFound — кадра нет в проекте (проекция могла обогнать документ).
var ErrEventNotFound = errors.New("кадр не найден")

// AddComment пишет комментарий к кадру.
//
// Кадр проверяется по проекции: документ комнаты и проекция расходятся не больше чем на
// период сохранения (5 с), а комментарий к несуществующему кадру показать будет негде — он
// останется в таблице сиротой до уборки. Честнее отказать сразу.
func (s *Service) AddComment(
	ctx context.Context, userID, projectID, eventID uuid.UUID, body string,
) (*store.EventComment, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return nil, err
	}
	text := strings.TrimSpace(body)
	if text == "" {
		return nil, fmt.Errorf("%w: комментарий пуст", ErrValidation)
	}
	if utf8.RuneCountInString(text) > MaxCommentRunes {
		return nil, fmt.Errorf("%w: комментарий длиннее %d знаков", ErrValidation, MaxCommentRunes)
	}
	if eventID == uuid.Nil {
		return nil, store.ErrNotFound
	}
	if _, err := s.store.GetEvent(ctx, projectID, eventID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("%w: кадра %s нет в проекте", ErrValidation, eventID)
		}
		return nil, err
	}
	return s.store.CreateEventComment(ctx, projectID, eventID, userID, text)
}

// ListComments — обсуждение одного кадра в порядке написания (viewer+).
func (s *Service) ListComments(
	ctx context.Context, userID, projectID, eventID uuid.UUID, limit int,
) ([]store.EventComment, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListEventComments(ctx, projectID, eventID, limit)
}

// CommentCounts — сколько комментариев у каждого кадра проекта (viewer+).
//
// Нужно дереву: без счётчика комментарий пишется в пустоту — его никто не заметит,
// пока сам не откроет кадр.
func (s *Service) CommentCounts(
	ctx context.Context, userID, projectID uuid.UUID,
) (map[uuid.UUID]int, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.EventCommentCounts(ctx, projectID)
}

// DeleteComment удаляет свой комментарий.
//
// Автор проверяется запросом (`AND user_id=$3`), а не чтением перед ним: между проверкой
// и удалением оставалась бы щель, а удаляется чужой текст.
func (s *Service) DeleteComment(
	ctx context.Context, userID, projectID, commentID uuid.UUID,
) error {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.DeleteEventComment(ctx, projectID, commentID, userID)
}

// UnseenComments — сколько новых замечаний у кадров проекта (viewer+).
//
// «Новое» — написанное после того, как человек в последний раз открывал обсуждение этого
// кадра, и не его собственное. Без этого единственный способ узнать о замечании — открыть
// каждый кадр подряд.
func (s *Service) UnseenComments(
	ctx context.Context, userID, projectID uuid.UUID,
) ([]store.CommentUnread, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.EventCommentsUnread(ctx, projectID, userID)
}

// UnseenCommentsByProject — в каких моих проектах есть непрочитанные замечания.
//
// Нужно списку проектов: «сюда стоит заглянуть» должно быть видно, не открывая проект.
func (s *Service) UnseenCommentsByProject(
	ctx context.Context, userID uuid.UUID,
) ([]store.ProjectCommentUnread, error) {
	return s.store.ProjectsCommentsUnread(ctx, userID)
}

// MarkCommentsSeen отмечает обсуждение кадра прочитанным (viewer+).
//
// Отметка ставится, когда обсуждение действительно показано, а не при открытии проекта:
// иначе счётчики обнулялись бы сами, и «новое» никто бы не увидел.
func (s *Service) MarkCommentsSeen(
	ctx context.Context, userID, projectID, eventID uuid.UUID,
) error {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.MarkCommentsSeen(ctx, projectID, eventID, userID)
}
