// Проверка кодов ответа на ошибки помощника (0.104.0).
//
// Зачем отдельный тест: коды в `fail` — это контракт с интерфейсом. «Предложение устарело»
// документ (`docs/ai-assistant.md`) обещает как `409` с объяснением, а до 0.104.0 ошибка
// попадала в общий `400`: интерфейс показывал текст, но отличить «конфликт состояния» от
// «неверного запроса» было нельзя, и это расхождение никто не замечал.
package assistant

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newQuietHandler() *Handler {
	return NewHandler(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestFailMapsStaleProposalToConflict(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{
			name:   "предложение устарело — конфликт состояния",
			err:    ErrProposalStale,
			status: http.StatusConflict,
			// Формулировка не про «кадр»: тем же отказом отвечает правка фрагмента.
			body: "текст изменился",
		},
		{
			// Остальные ошибки предложений остаются в общем `400`: их разбор — отдельное
			// решение, а не побочный эффект этой правки. Тест фиксирует, что мы не начали
			// менять коды «заодно».
			name:   "предложения нет — как было (400)",
			err:    ErrProposalNotFound,
			status: http.StatusBadRequest,
			body:   "предложение не найдено",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			newQuietHandler().fail(w, "test", tc.err)
			if w.Code != tc.status {
				t.Fatalf("код ответа: %d, ожидался %d (тело: %s)", w.Code, tc.status, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), tc.body) {
				t.Fatalf("тело ответа %q не содержит %q", w.Body.String(), tc.body)
			}
		})
	}
}
