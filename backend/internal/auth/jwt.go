package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Claims — JWT payload с минимальным набором полей.
type Claims struct {
	UserID uuid.UUID `json:"sub"`
	jwt.RegisteredClaims
}

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 30 * 24 * time.Hour
)

// IssueAccess — короткоживущий access-token (15 мин).
func IssueAccess(secret string, userID uuid.UUID) (string, error) {
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(accessTokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "skyfraze",
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(secret))
}

// IssueRefresh — длинноживущий refresh-token (30 дней), дополнительно содержит JTI для отзыва.
func IssueRefresh(secret string, userID uuid.UUID) (string, string, error) {
	jti := uuid.NewString()
	claims := jwt.MapClaims{
		"sub": userID.String(),
		"jti": jti,
		"typ": "refresh",
		"exp": time.Now().Add(refreshTokenTTL).Unix(),
		"iat": time.Now().Unix(),
		"iss": "skyfraze",
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := t.SignedString([]byte(secret))
	if err != nil {
		return "", "", err
	}
	return s, jti, nil
}

// ParseAccess — валидация access-токена, возвращает claims.
func ParseAccess(secret, raw string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

// ParseRefresh — валидация refresh-токена, возвращает userID + JTI.
func ParseRefresh(secret, raw string) (uuid.UUID, string, error) {
	tok, err := jwt.Parse(raw, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return uuid.Nil, "", err
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok || !tok.Valid {
		return uuid.Nil, "", errors.New("invalid token")
	}
	if typ, _ := claims["typ"].(string); typ != "refresh" {
		return uuid.Nil, "", errors.New("not a refresh token")
	}
	sub, _ := claims["sub"].(string)
	id, err := uuid.Parse(sub)
	if err != nil {
		return uuid.Nil, "", errors.New("invalid sub")
	}
	jti, _ := claims["jti"].(string)
	return id, jti, nil
}
