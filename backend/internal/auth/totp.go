package auth

// totp.go — второй фактор входа: TOTP (RFC 6238) без внешних сервисов.
//
// Почему свой TOTP, а не библиотека. Это HOTP поверх HMAC-SHA1 и base32 — сорок строк, из
// которых половина про неудобные края (шаг, окно, шесть цифр). Правильность проверяется
// официальными тестовыми векторами RFC 6238 (totp_test.go), так что «своя реализация» здесь
// не значит «на глазок».
//
// Что важно помнить, трогая файл:
//   - секрет хранится в base32 без паддинга: так его принимают приложения-аутентификаторы;
//   - код сравнивается в пределах окна ±1 шага (30 с): часы телефона и сервера всегда
//     немного расходятся, и строгий шаг означал бы «не пускает своего же человека»;
//   - окно ограничено: без него TOTP теряет смысл (любой из прошлых кодов подходит вечно).

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// totpStep — шаг TOTP: стандартные 30 секунд.
const totpStep = 30 * time.Second

// totpDigits — сколько цифр в коде: 6 — то, что показывают все аутентификаторы.
const totpDigits = 6

// totpWindow — сколько шагов в каждую сторону принимается (расхождение часов).
const totpWindow = 1

// GenerateTOTPSecret — новый секрет: 20 случайных байт в base32 без паддинга.
//
// 20 байт (160 бит) — размер, который рекомендуют и RFC, и приложения-аутентификаторы.
func GenerateTOTPSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("totp: случайные байты: %w", err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf), nil
}

// TOTPCode считает код для момента времени.
func TOTPCode(secret string, at time.Time) (string, error) {
	counter := uint64(at.Unix() / int64(totpStep/time.Second))
	return hotpCode(secret, counter, totpDigits)
}

// VerifyTOTP проверяет код с окном ±totpWindow шагов.
func VerifyTOTP(secret, code string, at time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	base := at.Unix() / int64(totpStep/time.Second)
	for offset := -int64(totpWindow); offset <= int64(totpWindow); offset++ {
		counter := base + offset
		if counter < 0 {
			continue
		}
		candidate, err := hotpCode(secret, uint64(counter), totpDigits)
		if err != nil {
			return false
		}
		// Сравнение за постоянное время: код — секрет, и по времени ответа его нельзя
		// подбирать посимвольно.
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

// hotpCode — HOTP (RFC 4226): HMAC-SHA1 от счётчика, динамическая обрезка, N цифр.
//
// digits вынесен параметром ради тестовых векторов RFC 6238: там коды восьмизначные, а в
// жизни нужны шесть.
func hotpCode(secret string, counter uint64, digits int) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", fmt.Errorf("totp: секрет не base32: %w", err)
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod), nil
}

// OTPAuthURL — ссылка `otpauth://totp/...` для приложения-аутентификатора.
//
// Именно ссылка, а не QR-картинка: QR потребовал бы библиотеки рисования, а вставить ссылку
// в приложение можно и руками — и это честнее, чем обещать «наведите камеру», когда камеру
// наводить не на что.
func OTPAuthURL(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	query := url.Values{}
	query.Set("secret", secret)
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", fmt.Sprint(totpDigits))
	query.Set("period", fmt.Sprint(int(totpStep/time.Second)))
	return "otpauth://totp/" + label + "?" + query.Encode()
}

// recoveryCodeAlphabet — без похожих символов (0/O, 1/I/L): код диктуют голосом и вводят с
// телефона, и «ноль или буква O» здесь стоит человеку входа в аккаунт.
const recoveryCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// GenerateRecoveryCodes — набор одноразовых кодов вида `ABCDE-FGHJK`.
func GenerateRecoveryCodes(count int) ([]string, error) {
	if count <= 0 {
		count = 8
	}
	codes := make([]string, 0, count)
	for i := 0; i < count; i++ {
		raw := make([]byte, 10)
		if _, err := rand.Read(raw); err != nil {
			return nil, fmt.Errorf("totp: коды восстановления: %w", err)
		}
		var b strings.Builder
		for j, value := range raw {
			if j == 5 {
				b.WriteByte('-')
			}
			b.WriteByte(recoveryCodeAlphabet[int(value)%len(recoveryCodeAlphabet)])
		}
		codes = append(codes, b.String())
	}
	return codes, nil
}

// normalizeRecoveryCode — к виду для хеширования: без пробелов, дефисов и нижнего регистра.
//
// Нормализация обязательна: человек введёт код как удобно, а хеш должен совпасть с тем, что
// сохранён при выдаче.
func normalizeRecoveryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	return code
}
