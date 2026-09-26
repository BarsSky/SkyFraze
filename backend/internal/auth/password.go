package auth

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

const bcryptCost = 12

// HashPassword — bcrypt-хэш пароля.
func HashPassword(plain string) (string, error) {
	if len(plain) < 8 {
		return "", errors.New("password too short (min 8 chars)")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("bcrypt: %w", err)
	}
	return string(h), nil
}

// VerifyPassword — сравнивает plain с bcrypt-хэшем.
func VerifyPassword(hash, plain string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain))
}
