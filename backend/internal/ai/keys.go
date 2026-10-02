package ai

// keys.go — шифрование пользовательских ключей.
//
// Ключ пользователя — это доступ и деньги: с ним можно тратить чужой лимит, а утечка
// означает, что ключ надо отзывать. Поэтому в базе он лежит только зашифрованным
// (AES-256-GCM), наружу не отдаётся никогда (в API — «подключено/нет»), и в логи не
// попадает.
//
// Ключ шифрования — `AI_SECRET_KEY` (32 байта, hex или base64). Если он не задан,
// функция «свой ключ» выключена целиком: хранить ключи без шифрования нельзя, а
// придумывать «временный ключ на диске» — то же самое, только незаметно.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

// ErrNoCipher — не задан ключ шифрования: работать со своими ключами нельзя.
var ErrNoCipher = errors.New("не задан AI_SECRET_KEY: хранение своих ключей выключено")

// Cipher шифрует и расшифровывает ключи провайдеров.
type Cipher struct {
	aead cipher.AEAD
}

// NewCipher собирает шифр из ключа в виде hex или base64 (32 байта после разбора).
func NewCipher(secret string) (*Cipher, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, ErrNoCipher
	}
	raw, err := decodeSecret(secret)
	if err != nil {
		return nil, err
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("AI_SECRET_KEY: нужно 32 байта, получено %d (hex или base64)", len(raw))
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// decodeSecret принимает hex (64 символа) или base64.
func decodeSecret(secret string) ([]byte, error) {
	if len(secret) == 64 {
		if raw, err := hex.DecodeString(secret); err == nil {
			return raw, nil
		}
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding} {
		if raw, err := enc.DecodeString(secret); err == nil {
			return raw, nil
		}
	}
	if raw, err := hex.DecodeString(secret); err == nil {
		return raw, nil
	}
	return nil, errors.New("AI_SECRET_KEY: не hex и не base64")
}

// Encrypt — ключ провайдера в шифртекст (nonce впереди).
func (c *Cipher) Encrypt(plain string) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, ErrNoCipher
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return c.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

// Decrypt — обратно в ключ. Ошибка означает, что шифртекст испорчен или ключ
// шифрования сменили: тогда пользователь просто вводит ключ заново.
func (c *Cipher) Decrypt(data []byte) (string, error) {
	if c == nil || c.aead == nil {
		return "", ErrNoCipher
	}
	size := c.aead.NonceSize()
	if len(data) < size {
		return "", errors.New("шифртекст ключа короче nonce")
	}
	nonce, body := data[:size], data[size:]
	plain, err := c.aead.Open(nil, nonce, body, nil)
	if err != nil {
		return "", fmt.Errorf("расшифровка ключа: %w", err)
	}
	return string(plain), nil
}

// MaskKey — как показать ключ, если очень нужно (в логах — никогда). Оставляем
// хвост: по нему человек узнаёт свой ключ, а целиком он не светится.
func MaskKey(key string) string {
	key = strings.TrimSpace(key)
	if len(key) <= 4 {
		return "…"
	}
	return "…" + key[len(key)-4:]
}
