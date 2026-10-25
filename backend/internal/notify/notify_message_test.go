package notify

// notify_message_test.go — сборка письма: то, что ломалось на живой отправке.
//
// Живая проверка 2026-10-25: тело письма с кириллицей читалось, а ТЕМА доезжала как `??????` —
// потому что не-ASCII в заголовке передавать сырыми байтами нельзя (RFC 5322 требует ASCII,
// а для остального — кодирование по RFC 2047). Эти тесты фиксируют обе стороны: тема не
// ломается и при этом ASCII-тема остаётся читаемой как есть.

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestEncodeHeaderKeepsASCIISimple(t *testing.T) {
	const subject = "SkyFraze: new comment"
	if got := encodeHeader(subject); got != subject {
		t.Fatalf("ASCII-тема не должна кодироваться: %q", got)
	}
}

func TestEncodeHeaderEncodesCyrillic(t *testing.T) {
	const subject = "SkyFraze: новое замечание в «Проекте»"
	encoded := encodeHeader(subject)
	if !strings.HasPrefix(encoded, "=?UTF-8?B?") || !strings.HasSuffix(encoded, "?=") {
		t.Fatalf("тема не закодирована по RFC 2047: %q", encoded)
	}
	// Раскодированное должно совпасть: иначе письмо придёт с мусором в теме.
	body := strings.TrimSuffix(strings.TrimPrefix(encoded, "=?UTF-8?B?"), "?=")
	decoded, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		t.Fatalf("base64 в теме не читается: %v", err)
	}
	if string(decoded) != subject {
		t.Fatalf("тема после раскодирования: %q", decoded)
	}
	// В заголовке не осталось сырых не-ASCII байтов.
	for _, r := range encoded {
		if r > 127 {
			t.Fatalf("в заголовке остался не-ASCII символ: %q", encoded)
		}
	}
}

// Письмо целиком: заголовки отделены пустой строкой, тело в UTF-8 с переводами строк CRLF.
func TestBuildMessageShape(t *testing.T) {
	message := buildMessage("skyfraze@example.com", "reader@example.com",
		"Замечание", "строка один\nстрока два")
	head, body, found := strings.Cut(message, "\r\n\r\n")
	if !found {
		t.Fatal("нет пустой строки между заголовками и телом")
	}
	for _, header := range []string{"From: skyfraze@example.com", "To: reader@example.com", "MIME-Version: 1.0"} {
		if !strings.Contains(head, header) {
			t.Errorf("в заголовках нет %q:\n%s", header, head)
		}
	}
	if strings.Contains(head, "\n\n") {
		t.Errorf("пустая строка внутри заголовков:\n%s", head)
	}
	if body != "строка один\r\nстрока два" {
		t.Errorf("тело: %q", body)
	}
}
