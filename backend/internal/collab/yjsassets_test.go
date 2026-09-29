package collab_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/platform/testyjs"
)

// Проверяем читатель CRDT-снапшота на настоящем update'е от Yjs: иначе выгрузка
// в Markdown молча осталась бы без картинок (а понять это по коду невозможно —
// привязки вложений в реляционной проекции просто нет).
func TestAssetBindings_RealSnapshot(t *testing.T) {
	got, err := collab.AssetBindings(testyjs.State())
	if err != nil {
		t.Fatalf("разбор снапшота: %v", err)
	}

	want := map[uuid.UUID][]uuid.UUID{
		// Ключ assets у Event1 переписан вторым клиентом: побеждает новый item,
		// хотя в потоке он без parent/parent_sub.
		testyjs.Event1: {testyjs.Asset1, testyjs.Asset2},
		// Вложение общее для двух событий — так тоже бывает.
		testyjs.Event2: {testyjs.Asset2},
		testyjs.Event3: {testyjs.Asset3},
	}
	if len(got) != len(want) {
		t.Fatalf("привязок %d, ожидалось %d (%v)", len(got), len(want), got)
	}
	for eventID, wantAssets := range want {
		assets, ok := got[eventID]
		if !ok {
			t.Errorf("нет привязки для события %s", eventID)
			continue
		}
		if len(assets) != len(wantAssets) {
			t.Errorf("событие %s: вложений %v, ожидалось %v", eventID, assets, wantAssets)
			continue
		}
		for i := range assets {
			if assets[i] != wantAssets[i] {
				t.Errorf("событие %s: вложение #%d = %s, ожидалось %s", eventID, i, assets[i], wantAssets[i])
			}
		}
	}
}

// Пустой снапшот — это норма (проект без CRDT: создан через API или импорт),
// и он не должен выглядеть как ошибка.
func TestAssetBindings_EmptyAndBroken(t *testing.T) {
	if got, err := collab.AssetBindings(nil); err != nil || got != nil {
		t.Fatalf("пустой снапшот: got=%v err=%v", got, err)
	}
	// Мусор и обрезанный снапшот — ошибка, а не паника: экспорт Markdown в этом
	// случае продолжает работать, просто без картинок.
	for _, junk := range [][]byte{
		{0xff, 0xff, 0xff, 0xff},
		[]byte("это не yjs"),
		testyjs.State()[:len(testyjs.State())/2],
	} {
		if _, err := collab.AssetBindings(junk); err == nil {
			t.Errorf("мусор %q должен возвращать ошибку", junk)
		}
	}
}
