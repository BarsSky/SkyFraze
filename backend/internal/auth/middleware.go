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
		auth := r.Header.Get("Authorization")
		if auth == "" {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			http.Error(w, "bad authorization header", http.StatusUnauthorized)
			return
		}
		claims, err := ParseAccess(s.secret, parts[1])
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, claims.UserID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
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
