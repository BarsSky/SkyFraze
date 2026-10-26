package events

// comments_reactions_handler.go — HTTP-ручки реакций на замечания (миграция 0025).
//
// Отдельный файл: ручки обсуждения уже занимают полсотни строк, а реакции — самостоятельная
// часть с собственным ответом (счётчики после изменения, а не «ок»).

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// SetCommentReaction — PUT/DELETE /comments/{cid}/reactions/{kind}: поставить или снять
// реакцию. Ответ — счётчики замечания после изменения, чтобы интерфейс не пересчитывал их
// сам (и не разошёлся с сервером).
func (h *Handler) SetCommentReaction(on bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, pid, ok := h.identity(w, r)
		if !ok {
			return
		}
		commentID, err := uuid.Parse(chi.URLParam(r, "cid"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad comment id")
			return
		}
		kind, valid := store.ParseReactionKind(chi.URLParam(r, "kind"))
		if !valid {
			writeErr(w, http.StatusBadRequest, "реакция бывает «agree» или «done»")
			return
		}
		reactions, err := h.svc.SetCommentReaction(r.Context(), uid, pid, commentID, kind, on)
		if err != nil {
			if errors.Is(err, ErrValidation) {
				writeErr(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), ErrValidation.Error()+": "))
				return
			}
			h.fail(w, err, "comment reaction")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"reactions": reactions})
	}
}
