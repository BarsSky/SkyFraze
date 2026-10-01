package yjs_test

// assetusage_test.go — подсчёт ссылок «кадр → файл» в документе.
//
// Подсчёт один и тот же для живой комнаты и для снапшота базы: сервер спрашивает
// его перед удалением вложения. Поэтому проверяем на документе, где ссылки стоят
// по-разному: в списке вложений, фоном, и в обоих местах сразу — кадр обязан
// считаться один раз, иначе отказ «прикреплён к N кадрам» пугал бы числами.

import (
	"testing"

	ygo "github.com/Deln0r/ygo"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
)

func TestDocAssetUsage(t *testing.T) {
	inList := uuid.NewString()
	asBackground := uuid.NewString()
	both := uuid.NewString()
	nowhere := uuid.NewString()

	doc := yjs.NewDoc()
	if err := doc.InsertEvents(0, []yjs.EventSeed{
		{ID: uuid.NewString(), Title: "В списке", Assets: []string{inList}},
		{ID: uuid.NewString(), Title: "Фоном", Background: asBackground},
		{ID: uuid.NewString(), Title: "И в списке, и фоном", Assets: []string{both}, Background: both},
		{ID: uuid.NewString(), Title: "Без вложений"},
		{ID: uuid.NewString(), Title: "Другой файл", Assets: []string{uuid.NewString()}},
	}); err != nil {
		t.Fatalf("документ: %v", err)
	}

	cases := []struct {
		name    string
		assetID string
		want    int
	}{
		{"вложение кадра", inList, 1},
		{"фон кадра", asBackground, 1},
		{"и вложение, и фон — кадр один", both, 1},
		{"файла в документе нет", nowhere, 0},
		{"пустой id", "", 0},
	}
	for _, tc := range cases {
		if usage := doc.AssetUsage(tc.assetID); usage != tc.want {
			t.Errorf("%s: расход %d, ожидался %d", tc.name, usage, tc.want)
		}
	}
}

// Фон считается ссылкой только когда он выбран картинкой (`bg_kind: asset`):
// «наследовать» и тон — это не вложение, и удалять из-за них файл нельзя.
// Заодно проверяется чтение снапшота: документ собирается «как из базы».
func TestDocAssetUsageIgnoresInheritedBackground(t *testing.T) {
	assetID := uuid.NewString()

	// Собираем документ вручную: у кадра стоит bg_asset, но bg_kind не «asset» —
	// так выглядит кадр, наследующий фон главы.
	inner := ygo.NewDoc()
	events := ygo.NewArray(inner, "events")
	txn := inner.WriteTxn()
	item := events.InsertMap(txn, 0)
	item.Set(txn, "id", uuid.NewString())
	item.Set(txn, "bg_asset", assetID)
	txn.Commit()

	doc, err := yjs.FromState(ygo.EncodeStateAsUpdate(inner))
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	if usage := doc.AssetUsage(assetID); usage != 0 {
		t.Errorf("унаследованный фон: расход %d, ожидался 0", usage)
	}
}
