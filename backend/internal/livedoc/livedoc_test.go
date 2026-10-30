package livedoc_test

// livedoc_test.go — строки проекта из документа живой комнаты (0.139.0).
//
// Что проверяется. Один разбор состояния на всех читателей (чат, помощник, `GET /events`,
// выгрузка): те же поля, что у проекции (id, родитель, позиция, глубина, заголовок, текст,
// дата), и честный отказ «взяли не из документа», когда комнаты нет, состояние пустое или
// битое. Отказ важен не меньше полей: если бы пустой список возвращался как «данные»,
// помощник и чат решили бы, что кадров в проекте нет.

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/livedoc"
)

// docWithEvents собирает документ комнаты так же, как его держит сервер.
func docWithEvents(t *testing.T, seeds []yjs.EventSeed) []byte {
	t.Helper()
	doc := yjs.NewDoc()
	if err := doc.SeedEvents(seeds); err != nil {
		t.Fatalf("документ комнаты: %v", err)
	}
	return doc.EncodeState()
}

func TestRowsReadsTreeFromDoc(t *testing.T) {
	projectID := uuid.New()
	chapter := uuid.NewString()
	scene := uuid.NewString()
	state := docWithEvents(t, []yjs.EventSeed{
		{ID: chapter, Title: "Глава 1", Body: "Земля ещё спит.", EventDate: "2026-03-02"},
		{ID: scene, ParentID: chapter, Title: "Сцена", Body: "Анна стоит на пороге."},
	})

	rows, ok := livedoc.Rows(state, projectID)
	if !ok {
		t.Fatal("строки из документа не прочитаны")
	}
	if len(rows) != 2 {
		t.Fatalf("кадров: %d, ожидалось 2", len(rows))
	}
	byID := make(map[uuid.UUID]int, len(rows))
	for i, row := range rows {
		byID[row.ID] = i
		if row.ProjectID != projectID {
			t.Errorf("проект строки %s: %s", row.ID, row.ProjectID)
		}
	}
	head, ok := byID[uuid.MustParse(chapter)]
	if !ok {
		t.Fatal("глава не найдена среди строк")
	}
	child, ok := byID[uuid.MustParse(scene)]
	if !ok {
		t.Fatal("сцена не найдена среди строк")
	}
	if rows[head].Depth != 0 {
		t.Errorf("глубина главы: %d, ожидалось 0", rows[head].Depth)
	}
	if rows[child].Depth != 1 {
		t.Errorf("глубина сцены: %d, ожидалось 1", rows[child].Depth)
	}
	if rows[child].ParentID == nil || *rows[child].ParentID != uuid.MustParse(chapter) {
		t.Error("родитель сцены не доехал")
	}
	if rows[head].Title != "Глава 1" || rows[head].Body != "Земля ещё спит." {
		t.Errorf("текст главы: %q / %q", rows[head].Title, rows[head].Body)
	}
	if rows[head].EventDate == nil || rows[head].EventDate.Format("2006-01-02") != "2026-03-02" {
		t.Errorf("дата главы: %v", rows[head].EventDate)
	}
	if rows[child].EventDate != nil {
		t.Errorf("у сцены не должно быть даты: %v", rows[child].EventDate)
	}
	// Порядок как у проекции: глубина, затем позиция — родитель раньше детей.
	if rows[0].Depth > rows[1].Depth {
		t.Error("строки не упорядочены по глубине")
	}
}

func TestRowsRefusesWithoutData(t *testing.T) {
	projectID := uuid.New()
	cases := []struct {
		name  string
		state []byte
	}{
		{"пусто", nil},
		{"битое состояние", []byte{0xde, 0xad, 0xbe, 0xef}},
		{"документ без кадров", docWithEvents(t, nil)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if rows, ok := livedoc.Rows(tc.state, projectID); ok || rows != nil {
				t.Fatalf("ожидался отказ без данных, получено %d строк", len(rows))
			}
		})
	}
}

func TestRowsSkipsBrokenIDs(t *testing.T) {
	projectID := uuid.New()
	state := docWithEvents(t, []yjs.EventSeed{
		{ID: "не-uuid", Title: "Мусор", Body: "не должен стать кадром"},
		{ID: uuid.NewString(), Title: "Глава", Body: "текст"},
	})
	rows, ok := livedoc.Rows(state, projectID)
	if !ok {
		t.Fatal("документ с одним годным кадром должен читаться")
	}
	if len(rows) != 1 || rows[0].Title != "Глава" {
		t.Fatalf("битая строка не пропущена: %+v", rows)
	}
}

// fakeLive — подмена хаба: сервисам не нужна настоящая комната, чтобы проверить, что они
// спрашивают её и предпочитают проекции.
type fakeLive struct {
	state []byte
	calls int
}

func (f *fakeLive) LiveState(_ context.Context, _ uuid.UUID) []byte {
	f.calls++
	return f.state
}

func TestRowsLivePrefersRoom(t *testing.T) {
	state := docWithEvents(t, []yjs.EventSeed{{ID: uuid.NewString(), Title: "Глава", Body: "текст"}})
	live := &fakeLive{state: state}
	rows, ok := livedoc.RowsLive(context.Background(), live, uuid.New())
	if !ok || len(rows) != 1 {
		t.Fatalf("строка из комнаты не прочитана: ok=%v rows=%d", ok, len(rows))
	}
	if live.calls != 1 {
		t.Errorf("комната спрошена %d раз, ожидалось 1", live.calls)
	}
}

func TestRowsLiveWithoutRoom(t *testing.T) {
	// Комнаты нет вовсе: nil не должен паниковать, а false — знак «читайте проекцию».
	if _, ok := livedoc.RowsLive(context.Background(), nil, uuid.New()); ok {
		t.Fatal("nil-комната не может вернуть строки")
	}
	live := &fakeLive{}
	if _, ok := livedoc.RowsLive(context.Background(), live, uuid.New()); ok {
		t.Fatal("пустое состояние комнаты не может вернуть строки")
	}
	if live.calls != 1 {
		t.Errorf("комната спрошена %d раз, ожидалось 1", live.calls)
	}
}

// BenchmarkRows — цена чтения документа, а не таблицы.
//
// Зачем мерить. С 0.139.0 читатели разбирают состояние комнаты на каждый запрос: чат — на
// отправку сообщения, помощник — на каждый инструмент. Это осознанный обмен «разбор против
// запроса к БД», и цифра должна быть на виду, а не выясняться на стенде.
func BenchmarkRows(b *testing.B) {
	body := strings.Repeat("Анна стоит на пороге и смотрит вдаль. ", 32) // ~1.1 КиБ на кадр
	seeds := make([]yjs.EventSeed, 0, 300)
	root := uuid.NewString()
	seeds = append(seeds, yjs.EventSeed{ID: root, Title: "Пролог", Body: body})
	for i := 0; i < 299; i++ {
		seeds = append(seeds, yjs.EventSeed{
			ID: uuid.NewString(), ParentID: root, Title: "Сцена", Body: body, EventDate: "2026-03-02",
		})
	}
	doc := yjs.NewDoc()
	if err := doc.SeedEvents(seeds); err != nil {
		b.Fatalf("документ: %v", err)
	}
	state := doc.EncodeState()
	b.SetBytes(int64(len(state)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rows, ok := livedoc.Rows(state, uuid.New())
		if !ok || len(rows) != 300 {
			b.Fatalf("строки: ok=%v n=%d", ok, len(rows))
		}
	}
}
