package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// ctxKey — уникальный тип ключа для request-context.
type ctxKey string

const userIDKey ctxKey = "user_id"

// WithUser — middleware: парсит Authorization: Bearer JWT, кладёт userID в ctx.
func (s *Service) WithUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, ok := s.userFromRequest(r)
		if !ok {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, uid)))
	})
}

// OptionalUser — как WithUser, но отсутствие или невалидность токена не ошибка.
// Нужен публичным ручкам (лента, публичная история): аноним читает их как
// аноним, а вошедший пользователь получает персонализацию (например, свою оценку).
func (s *Service) OptionalUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if uid, ok := s.userFromRequest(r); ok {
			r = r.WithContext(context.WithValue(r.Context(), userIDKey, uid))
		}
		next.ServeHTTP(w, r)
	})
}

// userFromRequest разбирает Bearer-токен. ok=false — заголовка нет, он битый
// или токен невалиден/просрочен.
func (s *Service) userFromRequest(r *http.Request) (uuid.UUID, bool) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return uuid.Nil, false
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return uuid.Nil, false
	}
	claims, err := ParseAccess(s.secret, parts[1])
	if err != nil {
		return uuid.Nil, false
	}
	return claims.UserID, true
}

// UserIDFromCtx — достаёт userID из контекста.
func UserIDFromCtx(ctx context.Context) (uuid.UUID, error) {
	v := ctx.Value(userIDKey)
	id, ok := v.(uuid.UUID)
	if !ok {
		return uuid.Nil, errors.New("user id not in context")
	}
	return id, nil
}

// UserIDFromCtxOptional — userID, если запрос авторизован. Для публичных ручек:
// ошибки нет, когда пользователя нет.
func UserIDFromCtxOptional(ctx context.Context) (uuid.UUID, bool) {
	v := ctx.Value(userIDKey)
	id, ok := v.(uuid.UUID)
	return id, ok
}
