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
	"regexp"
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

// AddComment пишет комментарий к кадру. parentID != nil — ответ на замечание (0023).
//
// Кадр проверяется по проекции: документ комнаты и проекция расходятся не больше чем на
// период сохранения (5 с), а комментарий к несуществующему кадру показать будет негде — он
// останется в таблице сиротой до уборки. Честнее отказать сразу.
//
// Ветка ровно одного уровня, и это решение, а не недоделка: ответ на ответ в узкой панели
// под кадром превращается в лесенку отступов, где на телефоне остаётся по 12 знаков на
// строку. «Замечание — ответы на него» покрывает разговор двух-трёх человек; глубже
// начинается форум, а не обсуждение кадра. Поэтому у ответа родитель обязан быть корневым.
func (s *Service) AddComment(
	ctx context.Context, userID, projectID, eventID uuid.UUID, body string, parentID *uuid.UUID,
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
	if parentID != nil {
		if err := s.checkReplyParent(ctx, projectID, eventID, *parentID); err != nil {
			return nil, err
		}
	}
	comment, err := s.store.CreateEventComment(ctx, projectID, eventID, userID, text, parentID)
	if err != nil {
		return nil, err
	} // Письма о новом замечании — в очередь, а не в момент ответа (миграция 0020).
	// Сбой очереди не отменяет комментарий: он уже записан, и «письмо не ушло» — не повод
	// отвечать автору ошибкой. Поэтому здесь только журнал.
	if queued, queueErr := s.store.EnqueueCommentNotifications(
		ctx, projectID, eventID, comment.ID, userID); queueErr != nil {
		s.logger.Warn("events: уведомления о замечании не поставлены в очередь",
			"project", projectID, "comment", comment.ID, "err", queueErr)
	} else if queued > 0 {
		s.logger.Info("events: замечание в очереди на уведомление",
			"project", projectID, "comment", comment.ID, "recipients", queued)
	}
	// Упоминания — после записи комментария, и их сбой не отменяет комментарий: текст уже
	// сохранён, а «никого не позвали» — не повод отвечать автору ошибкой.
	s.saveMentions(ctx, projectID, comment, userID)
	return comment, nil
}

// mentionPattern — `@ник` в тексте.
//
// Правила подогнаны под то, какие ники в проекте вообще бывают (`store.NormalizeUsername`:
// латиница, цифры, `.`, `-`, `_`, от 3 до 32 знаков, без точки/дефиса/подчёркивания по
// краям). Поэтому:
//   - перед `@` не должно быть буквы, цифры или ещё одной собаки — иначе `editor@example.com`
//     из текста превратился бы в «упоминание example.com»;
//   - ник не заканчивается на `.`, `-`, `_` — `@editor.` в конце фразы это ник `editor`,
//     а не `editor.`;
//   - кириллица в ник не входит: `@Серёжа` остаётся текстом, и подсветка в интерфейсе это
//     честно показывает (ник в проекте латинский).
var mentionPattern = regexp.MustCompile(`(?:^|[^\w@])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]{1,30}[A-Za-z0-9_])?)`)

// mentionMinLen — с какого возраста строка после `@` считается ником. Три — тот же минимум,
// что у самого ника: `@я` и `@ok` не упоминания, а «это никто».
const mentionMinLen = 3

// saveMentions находит в тексте упоминания участников проекта и сохраняет их.
//
// Почему только участники. Упоминание человека вне проекта — это и «уведомление в закрытую
// дверь», и утечка: сам факт «тебя упомянули в проекте X» сообщает о существовании X.
// Поэтому ник, которого нет среди участников, остаётся просто текстом в комментарии: автор
// увидит свой текст, адресат — ничего. Ошибкой это не считаем: опечатка в нике не должна
// отменять замечание, а список участников автору и так известен (подсказка в интерфейсе).
//
// Себя не сохраняем: `@свой ник` — это подпись, а не просьба обратить внимание.
func (s *Service) saveMentions(
	ctx context.Context, projectID uuid.UUID, comment *store.EventComment, authorID uuid.UUID,
) {
	handles := ParseMentions(comment.Body)
	if len(handles) == 0 {
		return
	}
	candidates, err := s.store.ProjectMentionCandidates(ctx, projectID)
	if err != nil {
		s.logger.Warn("events: участники для упоминаний не прочитаны",
			"project", projectID, "comment", comment.ID, "err", err)
		return
	}
	byUsername := make(map[string]uuid.UUID, len(candidates))
	for _, candidate := range candidates {
		byUsername[strings.ToLower(candidate.Username)] = candidate.UserID
	}
	seen := make(map[uuid.UUID]bool, len(handles))
	targets := make([]uuid.UUID, 0, len(handles))
	for _, handle := range handles {
		id, ok := byUsername[strings.ToLower(handle)]
		if !ok || id == authorID || seen[id] {
			continue
		}
		seen[id] = true
		targets = append(targets, id)
	}
	if len(targets) == 0 {
		return
	}
	if err := s.store.AddCommentMentions(ctx, comment.ID, targets); err != nil {
		s.logger.Warn("events: упоминания не сохранены",
			"project", projectID, "comment", comment.ID, "err", err)
		return
	}
	s.logger.Info("events: в замечании упомянуты участники",
		"project", projectID, "comment", comment.ID, "mentioned", len(targets))
}

// ParseMentions — ники, упомянутые в тексте, в порядке появления и без повторов.
//
// Экспортируется, потому что тот же разбор нужен тестам и подсветке в интерфейсе: держать
// две регулярки (одну в Go, другую в TypeScript) — значит гарантировать, что они разойдутся.
func ParseMentions(text string) []string {
	matches := mentionPattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		handle := match[1]
		if len(handle) < mentionMinLen {
			continue
		}
		key := strings.ToLower(handle)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, handle)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// checkReplyParent проверяет, что ответ вешают на живое корневое замечание ТОГО ЖЕ кадра.
//
// Все три условия — про одно: ветка не должна связывать разные кадры и не должна расти
// вглубь. Родитель из другого кадра сделал бы ответ невидимым (его читают в обсуждении
// своего кадра), а ответ на удалённое замечание — висящим на пустоте.
func (s *Service) checkReplyParent(
	ctx context.Context, projectID, eventID, parentID uuid.UUID,
) error {
	parent, err := s.store.EventCommentByID(ctx, projectID, parentID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("%w: замечания %s нет в проекте", ErrValidation, parentID)
		}
		return err
	}
	if parent.EventID != eventID {
		return fmt.Errorf("%w: ответ можно писать только на замечание этого кадра", ErrValidation)
	}
	if parent.Deleted {
		return fmt.Errorf("%w: замечание удалено, отвечать не на что", ErrValidation)
	}
	if parent.ParentID != nil {
		return fmt.Errorf("%w: ответы одноуровневые — отвечайте на замечание, а не на ответ", ErrValidation)
	}
	return nil
}

// ListComments — обсуждение одного кадра в порядке написания (viewer+).
//
// Реакции подтягиваются одним запросом на весь список и раскладываются по комментариям здесь:
// отдельный эндпоинт за реакциями означал бы ещё круг на каждый выбор строки дерева.
func (s *Service) ListComments(
	ctx context.Context, userID, projectID, eventID uuid.UUID, limit int,
) ([]store.EventComment, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		return nil, err
	}
	list, err := s.store.ListEventComments(ctx, projectID, eventID, limit)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(list))
	for i := range list {
		ids = append(ids, list[i].ID)
		list[i].Reactions = store.CommentReactions{Mine: []string{}}
	}
	stats, err := s.store.CommentReactionStats(ctx, ids, userID)
	if err != nil {
		// Реакции — не содержимое обсуждения: если их не удалось прочитать, показываем
		// комментарии без счётчиков, а не падаем и не прячем разговор.
		s.logger.Warn("events: реакции не прочитаны", "project", projectID, "err", err)
		return list, nil
	}
	for i := range list {
		if value, ok := stats[list[i].ID]; ok {
			list[i].Reactions = value
		}
	}
	return list, nil
}

// SetCommentReaction ставит или снимает реакцию на замечание (editor+).
//
// Права те же, что у написания: реакция — след в проекте, а читатель следов не оставляет.
// Реакция на удалённое замечание запрещена: тела нет, реагировать не на что.
//
// Уведомлений реакция не создаёт намеренно: иначе одно нажатие «согласен» рассылало бы письма
// и поднимало счётчики — ровно тот шум, ради устранения которого реакции и заведены.
func (s *Service) SetCommentReaction(
	ctx context.Context, userID, projectID, commentID uuid.UUID, kind store.ReactionKind, on bool,
) (store.CommentReactions, error) {
	if err := s.proj.RequireEditor(ctx, userID, projectID); err != nil {
		return store.CommentReactions{}, err
	}
	comment, err := s.store.EventCommentByID(ctx, projectID, commentID)
	if err != nil {
		return store.CommentReactions{}, err
	}
	if comment.Deleted {
		return store.CommentReactions{}, fmt.Errorf("%w: замечание удалено", ErrValidation)
	}
	if on {
		err = s.store.AddCommentReaction(ctx, commentID, userID, kind)
	} else {
		err = s.store.RemoveCommentReaction(ctx, commentID, userID, kind)
	}
	if err != nil {
		return store.CommentReactions{}, err
	}
	stats, err := s.store.CommentReactionStats(ctx, []uuid.UUID{commentID}, userID)
	if err != nil {
		return store.CommentReactions{}, err
	}
	if value, ok := stats[commentID]; ok {
		return value, nil
	}
	return store.CommentReactions{Mine: []string{}}, nil
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
// и удалением оставалась бы щель, а удаляется чужой текст. Удаление мягкое: строка остаётся
// с пустым телом, чтобы ответы на неё не потеряли смысл (миграция 0023).
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

// SetNotifyComments включает/выключает письма о замечаниях (галочка в профиле).
//
// Согласие спрашиваем явно: текст проекта уходит на чужой почтовый сервер, и по умолчанию
// это выключено (как и отправка текста модели — docs/ai-assistant.md).
func (s *Service) SetNotifyComments(ctx context.Context, userID uuid.UUID, enabled bool) error {
	return s.store.SetNotifyComments(ctx, userID, enabled)
}
