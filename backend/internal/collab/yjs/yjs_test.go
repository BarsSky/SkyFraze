package yjs_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/platform/testyjs"
)

// Фикстуры собирает `frontend/tests/yjs-fixtures.ts` из настоящей Yjs (та же
// версия, что у клиента): базовый снапшот нашего формата документа, две
// расходящиеся правки одного поля и ожидаемый результат их слияния.
//
// Тест доказывает ровно то, на чём стоит Фаза 3: серверный порт читает наши байты
// и сливает наши правки так же, как это делает браузер. Без этого серверный
// писатель снапшота был бы доверием к README чужой библиотеки.
func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("фикстура %s: %v (перегенерировать: cd frontend && npx tsx tests/yjs-fixtures.ts)", name, err)
	}
	return raw
}

type expectedFixture struct {
	ChapterID string `json:"chapterId"`
	StepID    string `json:"stepId"`
	Base      struct {
		Title     string   `json:"title"`
		Body      string   `json:"body"`
		StepTitle string   `json:"stepTitle"`
		EventDate string   `json:"eventDate"`
		Assets    []string `json:"assets"`
	} `json:"base"`
	Edits            map[string]string `json:"edits"`
	MergedBody       string            `json:"mergedBody"`
	MergedUpdateBody string            `json:"mergedUpdateBody"`
}

func TestReadClientSnapshot(t *testing.T) {
	var want expectedFixture
	if err := json.Unmarshal(loadFixture(t, "expected.json"), &want); err != nil {
		t.Fatalf("expected.json: %v", err)
	}

	doc, err := yjs.FromState(loadFixture(t, "base.bin"))
	if err != nil {
		t.Fatalf("снапшот клиента не применился: %v", err)
	}

	events := doc.Events()
	if len(events) != 2 {
		t.Fatalf("событий %d, ожидалось 2", len(events))
	}
	if events[0].ID != want.ChapterID || events[0].Title != want.Base.Title || events[0].Body != want.Base.Body {
		t.Fatalf("глава прочитана неверно: %+v", events[0])
	}
	if events[1].ID != want.StepID || events[1].ParentID != want.ChapterID || events[1].Title != want.Base.StepTitle {
		t.Fatalf("под-событие прочитано неверно: %+v", events[1])
	}
	if events[1].Body == "" {
		t.Fatal("текст под-события не прочитался")
	}
}

// Текст, записанный сервером, обязан остаться читаемым: серверный писатель
// снапшота не имеет права менять формат.
func TestEncodeStateKeepsText(t *testing.T) {
	doc, err := yjs.FromState(loadFixture(t, "base.bin"))
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	state := doc.EncodeState()
	if len(state) == 0 {
		t.Fatal("сервер закодировал пустое состояние")
	}

	// Повторное чтение собственных байтов даёт тот же документ.
	again, err := yjs.FromState(state)
	if err != nil {
		t.Fatalf("собственные байты не читаются: %v", err)
	}
	first, second := doc.Events(), again.Events()
	if len(first) != len(second) {
		t.Fatalf("после круга событий %d вместо %d", len(second), len(first))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("событие %d изменилось после круга: %+v → %+v", i, first[i], second[i])
		}
	}
}

func TestApplyClientEditsAndMerge(t *testing.T) {
	var want expectedFixture
	if err := json.Unmarshal(loadFixture(t, "expected.json"), &want); err != nil {
		t.Fatalf("expected.json: %v", err)
	}
	base := loadFixture(t, "base.bin")
	editA := loadFixture(t, "edit-a.bin")
	editB := loadFixture(t, "edit-b.bin")

	t.Run("правки применяются по очереди", func(t *testing.T) {
		doc, err := yjs.FromState(base)
		if err != nil {
			t.Fatalf("снапшот: %v", err)
		}
		if err := doc.Apply(editA); err != nil {
			t.Fatalf("правка A: %v", err)
		}
		if err := doc.Apply(editB); err != nil {
			t.Fatalf("правка B: %v", err)
		}
		if got := doc.Events()[0].Body; got != want.MergedBody {
			t.Fatalf("слияние дало %q, Yjs даёт %q", got, want.MergedBody)
		}
	})

	t.Run("порядок применения не важен", func(t *testing.T) {
		doc, err := yjs.FromState(base)
		if err != nil {
			t.Fatalf("снапшот: %v", err)
		}
		if err := doc.Apply(editB); err != nil {
			t.Fatalf("правка B: %v", err)
		}
		if err := doc.Apply(editA); err != nil {
			t.Fatalf("правка A: %v", err)
		}
		if got := doc.Events()[0].Body; got != want.MergedBody {
			t.Fatalf("обратный порядок дал %q, ожидалось %q", got, want.MergedBody)
		}
	})

	t.Run("повторное применение не удваивает текст", func(t *testing.T) {
		doc, err := yjs.FromState(base)
		if err != nil {
			t.Fatalf("снапшот: %v", err)
		}
		for i := 0; i < 3; i++ {
			if err := doc.Apply(editA); err != nil {
				t.Fatalf("правка A (повтор %d): %v", i, err)
			}
			if err := doc.Apply(editB); err != nil {
				t.Fatalf("правка B (повтор %d): %v", i, err)
			}
		}
		if got := doc.Events()[0].Body; got != want.MergedBody {
			t.Fatalf("повторный приём дал %q, ожидалось %q", got, want.MergedBody)
		}
	})

	t.Run("слияние апдейтов без документа совпадает с Yjs", func(t *testing.T) {
		merged, err := yjs.MergeUpdates([][]byte{editA, editB})
		if err != nil {
			t.Fatalf("merge: %v", err)
		}
		doc, err := yjs.FromState(base)
		if err != nil {
			t.Fatalf("снапшот: %v", err)
		}
		if err := doc.Apply(merged); err != nil {
			t.Fatalf("слитый апдейт: %v", err)
		}
		if got := doc.Events()[0].Body; got != want.MergedUpdateBody {
			t.Fatalf("слитый апдейт дал %q, ожидалось %q", got, want.MergedUpdateBody)
		}
	})
}

// Сервер обязан переживать битые и враждебные байты: это вход из сети.
func TestRejectsBrokenUpdates(t *testing.T) {
	doc := yjs.NewDoc()
	cases := map[string][]byte{
		"мусор":                 {0xff, 0xff, 0xff, 0xff},
		"обрезанный снапшот":    loadFixture(t, "base.bin")[:40],
		"пустой заголовок":      {0x00},
		"только объявленный id": {0x01, 0x02},
	}
	for name, raw := range cases {
		if err := doc.Apply(raw); err == nil {
			t.Errorf("%s: апдейт принят, хотя должен быть отклонён", name)
		}
	}
	// После отклонённых апдейтов документ остался рабочим.
	if err := doc.Apply(loadFixture(t, "base.bin")); err != nil {
		t.Fatalf("корректный снапшот после мусора не применился: %v", err)
	}
	if len(doc.Events()) != 2 {
		t.Fatalf("после мусора событий %d, ожидалось 2", len(doc.Events()))
	}
}

// Настоящий снапшот приложения (тот же, что используют тесты переноса и
// привязок вложений) тоже должен читаться: он снят до Фазы 2, со скалярными
// title/body, и сервер обязан понимать такие байты.
func TestReadLegacySnapshot(t *testing.T) {
	doc, err := yjs.FromState(testyjs.State())
	if err != nil {
		t.Fatalf("снапшот приложения не применился: %v", err)
	}
	events := doc.Events()
	if len(events) != 3 {
		t.Fatalf("событий %d, ожидалось 3 (Event1/Event2/Event3)", len(events))
	}
	byID := map[string]yjs.Event{}
	for _, e := range events {
		byID[e.ID] = e
	}
	if _, ok := byID[testyjs.Event1.String()]; !ok {
		t.Fatalf("в снапшоте нет Event1: %+v", events)
	}
	if byID[testyjs.Event1.String()].Title == "" {
		t.Fatal("скалярный заголовок не прочитался: сервер обязан понимать снапшоты до Фазы 2")
	}
	if byID[testyjs.Event2.String()].ParentID != testyjs.Event1.String() {
		t.Fatalf("родитель Event2 = %q", byID[testyjs.Event2.String()].ParentID)
	}
}

// Миграция на сервере: старые скалярные строки превращаются в Y.Text один раз и
// одним писателем. Иначе два клиента создали бы по своему Y.Text, LWW выбрал бы
// одну ветку, и правки во второй стали бы невидимыми.
func TestEnsureTextFieldsMigratesLegacy(t *testing.T) {
	doc, err := yjs.FromState(testyjs.State())
	if err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	before := doc.Events()

	if created := doc.EnsureTextFields(); created == 0 {
		t.Fatal("миграция ничего не создала, хотя снапшот со скалярными строками")
	}
	after := doc.Events()
	if len(after) != len(before) {
		t.Fatalf("после миграции событий %d вместо %d", len(after), len(before))
	}
	for i := range before {
		if before[i].Title != after[i].Title || before[i].Body != after[i].Body {
			t.Fatalf("миграция изменила текст события %d: %+v → %+v", i, before[i], after[i])
		}
	}
	if again := doc.EnsureTextFields(); again != 0 {
		t.Fatalf("повторная миграция создала ещё %d полей", again)
	}

	// Состояние после миграции читается заново, текст остаётся на месте, и
	// повторная миграция перечитанному документу уже не нужна.
	reloaded, err := yjs.FromState(doc.EncodeState())
	if err != nil {
		t.Fatalf("состояние после миграции: %v", err)
	}
	for i, event := range reloaded.Events() {
		if event.Title != before[i].Title || event.Body != before[i].Body {
			t.Fatalf("после круга текст события %d изменился: %+v → %+v", i, before[i], event)
		}
	}
	if again := reloaded.EnsureTextFields(); again != 0 {
		t.Fatalf("мигрированный снапшот снова мигрировали: %d полей", again)
	}
}
