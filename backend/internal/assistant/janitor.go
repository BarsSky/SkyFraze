package assistant

// janitor.go — автоочистка бесед по сроку хранения (0.149.0).
//
// Почему фоном, а не «при открытии окна помощника». Срок — свойство проекта, а не
// посещения: если владелец поставил «30 дней», история должна поредеть и тогда, когда в
// проект месяц никто не заходил. И наоборот: удаление не должно происходить в момент,
// когда человек дописывает вопрос, — поэтому не в HTTP-ручке.
//
// Почему раз в час. Срок измеряется днями; чаще незачем, реже — при сроке «7 дней»
// удаление отставало бы заметно. Один DELETE по индексу `project_id, retention_days > 0`
// дешевле любого расписания, которое пришлось бы хранить отдельно.
//
// Чего здесь НЕТ: удаления бесед с флагом `kept` (человек просил оставить) и знаний —
// знания не привязаны к сроку вовсе, в этом весь смысл: беседа стареет, выводы остаются.

import (
	"context"
	"log/slog"
	"time"
)

// Janitor — планировщик очистки. Отдельный тип, а не метод сервиса: его запускают в
// `main` рядом с другими фоновыми задачами, и он должен быть видим там, а не спрятан в
// глубине бизнес-логики.
type Janitor struct {
	svc    *Service
	logger *slog.Logger
	// every — период проверки. Поле, а не константа: тест не должен ждать час.
	every time.Duration
}

// NewJanitor собирает планировщик.
func NewJanitor(svc *Service, logger *slog.Logger) *Janitor {
	return &Janitor{svc: svc, logger: logger, every: time.Hour}
}

// SetInterval меняет период (тесты).
func (j *Janitor) SetInterval(every time.Duration) { j.every = every }

// Run — цикл очистки. Возвращается по отмене контекста (остановка сервера).
//
// Первый проход — через минуту после старта, а не сразу: сразу сервер ещё поднимается,
// а база может быть занята миграциями, и «упало на старте» выглядело бы как поломка
// помощника, хотя это была всего лишь уборка.
func (j *Janitor) Run(ctx context.Context) {
	if j == nil || j.svc == nil {
		return
	}
	every := j.every
	if every <= 0 {
		every = time.Hour
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			j.pass(ctx)
			timer.Reset(every)
		}
	}
}

// pass — одна уборка. Ошибки НЕ роняют сервер: срок хранения — удобство, а не защита, и
// «не удалилось сегодня» не повод останавливать историю, над которой работают.
func (j *Janitor) pass(ctx context.Context) {
	// Контекст без отмены: если сервер останавливают, начатую уборку лучше довести —
	// она короткая и не держит ничего, что мешало бы закрытию.
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	deleted, err := j.svc.CleanupConversations(runCtx)
	if err != nil {
		j.logger.Warn("ai: автоочистка бесед не удалась", "err", err)
		return
	}
	if deleted > 0 {
		j.logger.Info("ai: автоочистка бесед", "deleted", deleted)
	}
}
