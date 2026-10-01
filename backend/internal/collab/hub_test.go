package collab

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Проверка Origin для WebSocket: за reverse proxy Host приходит без порта, а
// Origin — с портом. Именно на этом ломался realtime при работе по домену.
func TestSameHost_IgnoresSchemeAndPort(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		host   string
		xHost  string
		want   bool
	}{
		{"совпадает как есть", "http://192.168.13.66", "192.168.13.66", "", true},
		{"HTTPS 443 без порта в Host", "https://fraza.skynas.ru", "fraza.skynas.ru", "", true},
		{"нестандартный порт в Origin", "https://fraza.skynas.ru:8443", "fraza.skynas.ru", "", true},
		{"порт в обоих", "https://host:8443", "host:8443", "", true},
		{"прокси подменил Host на апстрим", "https://fraza.skynas.ru", "skyfraze-frontend", "fraza.skynas.ru", true},
		{"другой хост", "https://evil.example", "fraza.skynas.ru", "", false},
		{"поддомен не считается своим", "https://a.fraza.skynas.ru", "fraza.skynas.ru", "", false},
		{"пустой origin", "", "fraza.skynas.ru", "", false},
		{"IPv6 с портом", "https://[::1]:8443", "[::1]", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://example/api", nil)
			r.Host = c.host
			if c.xHost != "" {
				r.Header.Set("X-Forwarded-Host", c.xHost)
			}
			if got := sameHost(c.origin, r); got != c.want {
				t.Errorf("sameHost(%q, host=%q, xfh=%q) = %v, ожидалось %v", c.origin, c.host, c.xHost, got, c.want)
			}
		})
	}
}

func TestParseOrigins(t *testing.T) {
	got := parseOrigins(" http://localhost , https://fraza.skynas.ru ,, ")
	if len(got) != 2 || !got["http://localhost"] || !got["https://fraza.skynas.ru"] {
		t.Errorf("разбор CORS_ORIGINS: %v", got)
	}
}
