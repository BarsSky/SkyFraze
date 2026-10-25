package auth

// totp_test.go — TOTP по официальным тестовым векторам RFC 6238.
//
// Почему именно векторы RFC. Ошибка в HOTP-обрезке или в base32 не выглядит как ошибка: коды
// получаются «какие-то», и проверка «входит или нет» проходит, если считать и проверять одним
// и тем же кодом. Векторы дают внешнюю точку опоры: секрет «12345678901234567890», известные
// моменты времени и известные восьмизначные коды.

import (
	"strings"
	"testing"
	"time"
)

// RFC 6238, приложение B: SHA1, 8 цифр.
func TestHOTPMatchesRFC6238Vectors(t *testing.T) {
	// base32 от ASCII «12345678901234567890» — секрет из RFC.
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	vectors := []struct {
		unix int64
		code string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	for _, vector := range vectors {
		counter := uint64(vector.unix / 30)
		got, err := hotpCode(secret, counter, 8)
		if err != nil {
			t.Fatalf("код для %d: %v", vector.unix, err)
		}
		if got != vector.code {
			t.Errorf("момент %d: код %s, ожидался %s", vector.unix, got, vector.code)
		}
	}
}

// Шестизначный код — те же цифры, что восьмизначный, только короче.
func TestTOTPCodeIsSixDigits(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	code, err := TOTPCode(secret, time.Unix(1111111109, 0))
	if err != nil {
		t.Fatalf("код: %v", err)
	}
	if len(code) != 6 || !strings.HasSuffix("07081804", code) {
		t.Fatalf("код: %q", code)
	}
}

// Окно ±1 шаг: код соседнего шага принимается, далёкий — нет.
func TestVerifyTOTPWindow(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	at := time.Unix(1111111109, 0)
	current, _ := TOTPCode(secret, at)
	if !VerifyTOTP(secret, current, at) {
		t.Fatal("текущий код должен приниматься")
	}
	// Код предыдущего шага — принимается (часы отстают на несколько секунд).
	previous, _ := TOTPCode(secret, at.Add(-30*time.Second))
	if !VerifyTOTP(secret, previous, at) {
		t.Fatal("код соседнего шага должен приниматься (окно ±1)")
	}
	// Код шага, который был давно, — нет: иначе TOTP теряет смысл.
	old, _ := TOTPCode(secret, at.Add(-10*time.Minute))
	if VerifyTOTP(secret, old, at) {
		t.Fatal("старый код не должен приниматься")
	}
	// Мусор вместо кода — отказ, а не паника.
	for _, bad := range []string{"", "12345", "abcdef", "1234567"} {
		if VerifyTOTP(secret, bad, at) {
			t.Errorf("код %q должен быть отвергнут", bad)
		}
	}
}

func TestGenerateTOTPSecretIsBase32(t *testing.T) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("секрет: %v", err)
	}
	if len(secret) != 32 {
		t.Fatalf("длина секрета: %d (ожидалось 32 символа base32 без паддинга)", len(secret))
	}
	if _, err := hotpCode(secret, 1, 6); err != nil {
		t.Fatalf("секрет не декодируется: %v", err)
	}
}

func TestOTPAuthURLShape(t *testing.T) {
	link := OTPAuthURL("SkyFraze", "author@example.com", "GEZDGNBVGY3TQOJQ")
	if !strings.HasPrefix(link, "otpauth://totp/SkyFraze:author@example.com?") {
		t.Fatalf("ссылка: %s", link)
	}
	for _, part := range []string{"secret=GEZDGNBVGY3TQOJQ", "issuer=SkyFraze", "digits=6", "period=30", "algorithm=SHA1"} {
		if !strings.Contains(link, part) {
			t.Errorf("в ссылке нет %q: %s", part, link)
		}
	}
}

func TestRecoveryCodesAreSingleUseableAndNormalized(t *testing.T) {
	codes, err := GenerateRecoveryCodes(8)
	if err != nil {
		t.Fatalf("коды: %v", err)
	}
	if len(codes) != 8 {
		t.Fatalf("кодов: %d", len(codes))
	}
	seen := map[string]bool{}
	for _, code := range codes {
		if len(code) != 11 || code[5] != '-' {
			t.Fatalf("формат кода: %q", code)
		}
		if seen[code] {
			t.Fatalf("код повторился: %q", code)
		}
		seen[code] = true
		// Нормализация: нижний регистр, пробелы и дефисы не должны давать другой хеш.
		if normalizeRecoveryCode(strings.ToLower(strings.ReplaceAll(code, "-", " "))) !=
			strings.ReplaceAll(code, "-", "") {
			t.Errorf("нормализация кода %q", code)
		}
	}
}
