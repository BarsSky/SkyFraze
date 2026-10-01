package transfer_test

// markdown_weight_integration_test.go — вес набора в предпросмотре импорта.
//
// Импорт подчиняется пределу вложений проекта (см. docs/storage-compression.md,
// шаг 7): набор, который не помещается, отклоняется на первом же файле. Чтобы
// человек узнавал об этом ДО импорта, предпросмотр отдаёт и вес вложений, и сам
// предел. Проверяем это на живом HTTP-контракте: считаем вес по худшему случаю (до
// пережатия) и отдаём предел даже тогда, когда в наборе нет ни одной картинки.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// quotaStub — предел вложений проекта для теста: настоящий живёт в конфиге
// (ASSET_QUOTA_BYTES), а проверяем мы передачу числа в предпросмотр.
type quotaStub struct{ limit int64 }

func (q quotaStub) Quota() int64 { return q.limit }

func TestMarkdownPreviewReportsAttachmentWeight(t *testing.T) {
	e := setup(t)
	owner := e.user(t, "owner@example.com")
	const limit = 10 << 20
	e.transfer.UseQuota(quotaStub{limit: limit})
	h := markdownRouter(e.transfer)

	// Картинка на 500 байт, на которую есть ссылка из текста: она станет вложением.
	picture := strings.Repeat("P", 500)
	folder := multipartBody(t, map[string]string{
		"files:01-Пролог.md":     "# Пролог\nТекст главы.\n\n![схема](assets/схема.png)\n",
		"files:assets/схема.png": picture,
	}, nil)

	rec := doJSON(t, h, http.MethodPost, "/api/projects/import/markdown/preview", owner,
		bytes.NewReader(folder.body), folder.contentType)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var preview struct {
		Stats struct {
			Attachments     int   `json:"attachments"`
			AttachmentBytes int64 `json:"attachment_bytes"`
		} `json:"stats"`
		QuotaBytes int64 `json:"quota_bytes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
		t.Fatalf("preview json: %v (%s)", err, rec.Body.String())
	}
	if preview.Stats.Attachments != 1 {
		t.Errorf("вложений в предпросмотре %d, ожидалось 1 (%s)", preview.Stats.Attachments, rec.Body.String())
	}
	if preview.Stats.AttachmentBytes != int64(len(picture)) {
		t.Errorf("вес вложений %d, ожидалось %d", preview.Stats.AttachmentBytes, len(picture))
	}
	if preview.QuotaBytes != limit {
		t.Errorf("предел в предпросмотре %d, ожидался %d", preview.QuotaBytes, limit)
	}
}

// Без источника предела (старая сборка, тесты) предпросмотр отдаёт 0 — «предела
// нет»: интерфейс в этом случае просто не предупреждает.
func TestMarkdownPreviewWithoutQuota(t *testing.T) {
	e := setup(t)
	owner := e.user(t, "owner@example.com")
	h := markdownRouter(e.transfer)

	folder := multipartBody(t, map[string]string{
		"files:01-Пролог.md": "# Пролог\nТекст.\n",
	}, nil)
	rec := doJSON(t, h, http.MethodPost, "/api/projects/import/markdown/preview", owner,
		bytes.NewReader(folder.body), folder.contentType)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var preview struct {
		QuotaBytes int64 `json:"quota_bytes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
		t.Fatalf("preview json: %v (%s)", err, rec.Body.String())
	}
	if preview.QuotaBytes != 0 {
		t.Errorf("предел без источника %d, ожидался 0", preview.QuotaBytes)
	}
}
