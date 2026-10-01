package transfer_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/platform/testyjs"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// Импорт «в место»: разобранный кусок md вставляется в СУЩЕСТВУЮЩИЙ проект.
//
// Ключевое отличие от импорта в новый проект: здесь проект уже живёт, источник
// правды — его CRDT-документ, и таблица событий перестраивается из документа.
// Поэтому проверяем обе стороны: вставленное есть и в документе (иначе редакторы
// его не увидят), и в таблице (иначе не увидят лента, выгрузка и перенос).
func TestImportMarkdownInto_InsertsIntoExistingProject(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	// Проект с одной главой, заведённой как обычно — через CRDT-документ.
	project, err := e.proj.Create(ctx, owner, "Куда вставлять", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	chapter := uuid.New()
	state, err := yjs.FromState(nil)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	if err := state.SeedEvents([]yjs.EventSeed{{
		ID: chapter.String(), Title: "Первая глава", Body: "Текст первой главы.",
	}}); err != nil {
		t.Fatalf("засев: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, project.ID, owner, state.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	parsed, err := parseFolder(t, map[string]string{
		"01-Вставка.md":  "---\ntitle: Вставленная глава\ndate: 2024-05-17\n---\n\nТекст вставки.\n",
		"01.1-Подшаг.md": "# Подшаг вставки\nТело подшага.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}

	created, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed,
		transfer.InsertPlace{AfterID: &chapter})
	if err != nil {
		t.Fatalf("вставка: %v", err)
	}
	if created != 2 {
		t.Fatalf("вставлено событий %d, ожидалось 2", created)
	}

	// Таблица событий: прежняя глава на месте, вставленное — после неё и вложено верно.
	rows, err := e.st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("событий %d, ожидалось 3: %+v", len(rows), titles(rows))
	}
	byTitle := map[string]store.Event{}
	for _, row := range rows {
		byTitle[row.Title] = row
	}
	first, ok := byTitle["Первая глава"]
	if !ok {
		t.Fatalf("прежняя глава потерялась: %+v", titles(rows))
	}
	inserted, ok := byTitle["Вставленная глава"]
	if !ok {
		t.Fatalf("вставленная глава не появилась: %+v", titles(rows))
	}
	step, ok := byTitle["Подшаг вставки"]
	if !ok {
		t.Fatalf("подшаг вставки не появился: %+v", titles(rows))
	}
	if inserted.ParentID != nil {
		t.Fatalf("вставка должна быть на верхнем уровне, а у неё родитель %v", inserted.ParentID)
	}
	if inserted.Position <= first.Position {
		t.Fatalf("вставка встала до главы: позиции %d и %d", inserted.Position, first.Position)
	}
	if step.ParentID == nil || *step.ParentID != inserted.ID {
		t.Fatalf("подшаг вставки не под своей главой: %+v", step.ParentID)
	}
	if inserted.EventDate == nil || inserted.EventDate.Format("2006-01-02") != "2024-05-17" {
		t.Fatalf("дата из front-matter не доехала: %v", inserted.EventDate)
	}

	// Документ: вставленное обязано быть и в CRDT, иначе редакторы его не увидят.
	saved, err := e.st.GetProjectEventState(ctx, project.ID)
	if err != nil || saved == nil {
		t.Fatalf("снапшот: %v", err)
	}
	doc, err := yjs.FromState(saved.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	found := false
	for _, event := range doc.Events() {
		if event.ID == inserted.ID.String() {
			found = true
			if event.Body != "Текст вставки." {
				t.Fatalf("текст вставки в документе: %q", event.Body)
			}
		}
		if event.ID == chapter.String() && event.Title != "Первая глава" {
			t.Fatalf("прежняя глава испорчена в документе: %+v", event)
		}
	}
	if !found {
		t.Fatalf("вставленного события нет в CRDT-документе: %+v", doc.Events())
	}
}

// Вставка под существующее событие: кусок становится его детьми.
func TestImportMarkdownInto_InsertsAsChildren(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Дети", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	chapter := uuid.New()
	if err := e.st.InsertEventTree(ctx, project.ID, owner, []store.Event{
		{ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава", Body: "текст"},
	}); err != nil {
		t.Fatalf("глава: %v", err)
	}

	parsed, err := parseFolder(t, map[string]string{
		"01-Шаг.md": "# Новый шаг\nТело шага.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}

	// Снапшота у проекта нет: документ собирается из реляционных строк, иначе
	// вставка потеряла бы уже существующую главу.
	if _, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed,
		transfer.InsertPlace{ParentID: &chapter}); err != nil {
		t.Fatalf("вставка: %v", err)
	}

	rows, err := e.st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("событий %d, ожидалось 2: %+v", len(rows), titles(rows))
	}
	byTitle := map[string]store.Event{}
	for _, row := range rows {
		byTitle[row.Title] = row
	}
	step, ok := byTitle["Новый шаг"]
	if !ok || step.ParentID == nil || *step.ParentID != chapter {
		t.Fatalf("вставка не стала ребёнком главы: %+v", step)
	}
	if _, ok := byTitle["Глава"]; !ok {
		t.Fatalf("прежняя глава потерялась: %+v", titles(rows))
	}
}

// «Перед событием» — не то же самое, что «после предыдущего»: у главы может быть
// поддерево, и вставить кусок нужно строго перед самой главой, а не после её детей.
func TestImportMarkdownInto_BeforeEvent(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Перед главой", "описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	first, second := uuid.New(), uuid.New()
	child := uuid.New()
	if err := e.st.InsertEventTree(ctx, project.ID, owner, []store.Event{
		{ID: first, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Первая", Body: "текст"},
		{ID: child, ProjectID: project.ID, ParentID: &first, Position: 1, Depth: 1, Title: "Ребёнок", Body: "текст"},
		{ID: second, ProjectID: project.ID, Position: 2, Depth: 0, Title: "Вторая", Body: "текст"},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}

	parsed, err := parseFolder(t, map[string]string{"01-Между.md": "# Между\nТело.\n"})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if _, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed,
		transfer.InsertPlace{BeforeID: &second}); err != nil {
		t.Fatalf("вставка: %v", err)
	}

	rows, err := e.st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("событий %d, ожидалось 4: %+v", len(rows), titles(rows))
	}
	// Таблица читается по «глубина, позиция», поэтому порядок верхнего уровня — это
	// порядок самих глав: кусок обязан встать между «Первой» и «Второй», а «Ребёнок»
	// остаться под «Первой».
	var roots []string
	byTitle := map[string]store.Event{}
	for _, row := range rows {
		byTitle[row.Title] = row
		if row.Depth == 0 {
			roots = append(roots, row.Title)
		}
	}
	if strings.Join(roots, ",") != "Первая,Между,Вторая" {
		t.Fatalf("порядок глав: %v, ожидалось [Первая Между Вторая]", roots)
	}
	between := byTitle["Между"]
	if between.Position >= byTitle["Вторая"].Position {
		t.Errorf("кусок встал не перед «Второй»: позиции %d и %d",
			between.Position, byTitle["Вторая"].Position)
	}
	if child := byTitle["Ребёнок"]; child.ParentID == nil || *child.ParentID != byTitle["Первая"].ID {
		t.Errorf("«Ребёнок» потерял родителя: %+v", child.ParentID)
	}
}

// stubLive — подставная живая комната: проверяем, что импорт «в место» идёт к ней,
// а не в снапшот базы, и что «комнаты нет» возвращает работу вызывающему.
type stubLive struct {
	handled bool
	calls   int
	seeds   []yjs.EventSeed
	place   yjs.InsertPlace
}

func (s *stubLive) InsertLive(
	_ context.Context, _ uuid.UUID, _ uuid.UUID, seeds []yjs.EventSeed, place yjs.InsertPlace,
) (bool, error) {
	s.calls++
	s.seeds = seeds
	s.place = place
	return s.handled, nil
}

func TestImportMarkdownInto_UsesLiveRoom(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Живая комната", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	parsed, err := parseFolder(t, map[string]string{"01-Кусок.md": "# Кусок\nТело куска.\n"})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	target := uuid.New()

	// Комната обработала вставку: в базу transfer не пишет ничего — это делает хаб
	// (снапшот и проекция), иначе документ комнаты и снапшот разъехались бы.
	live := &stubLive{handled: true}
	e.transfer.UseLiveDoc(live)
	created, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed,
		transfer.InsertPlace{ParentID: &target, AfterID: nil})
	if err != nil {
		t.Fatalf("вставка: %v", err)
	}
	if created != 1 || live.calls != 1 {
		t.Fatalf("вставлено %d, вызовов комнаты %d", created, live.calls)
	}
	if live.place.ParentID != target.String() {
		t.Errorf("место вставки не доехало до комнаты: %+v", live.place)
	}
	if len(live.seeds) != 1 || live.seeds[0].Title != "Кусок" || live.seeds[0].Body != "Тело куска." {
		t.Fatalf("события куска не доехали до комнаты: %+v", live.seeds)
	}
	if state, err := e.st.GetProjectEventState(ctx, project.ID); err != nil || state != nil {
		t.Errorf("при живой комнате снапшот пишет она, а не transfer: %+v (err=%v)", state, err)
	}
	rows, err := e.st.ListEvents(ctx, project.ID)
	if err != nil || len(rows) != 0 {
		t.Errorf("таблицу событий при живой комнате перестраивает она: %+v (err=%v)", rows, err)
	}

	// Комнаты нет — работа возвращается transfer, и он пишет снапшот сам.
	live.handled = false
	if _, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed, transfer.InsertPlace{}); err != nil {
		t.Fatalf("вставка без комнаты: %v", err)
	}
	state, err := e.st.GetProjectEventState(ctx, project.ID)
	if err != nil || state == nil || len(state.YjsState) == 0 {
		t.Fatalf("без комнаты снапшот обязан появиться: %+v (err=%v)", state, err)
	}
	rows, err = e.st.ListEvents(ctx, project.ID)
	if err != nil || len(rows) != 1 || rows[0].Title != "Кусок" {
		t.Fatalf("без комнаты таблица событий обязана заполниться: %+v (err=%v)", rows, err)
	}
}

func titles(rows []store.Event) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Title)
	}
	return out
}

// HTTP-контракт импорта «в место»: место задаётся полями формы, новый проект НЕ
// создаётся, а права такие же, как у правки событий (viewer получает 403, а не
// 500 — иначе интерфейс показывал бы «ошибка сервера» там, где отказано в доступе).
func TestImportMarkdownIntoHTTP_Contract(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	viewer := e.user(t, "viewer@example.com")
	projectID := e.seedStoryProject(t, owner)
	if err := e.st.AddMembership(ctx, projectID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("membership: %v", err)
	}
	h := markdownRouter(e.transfer)

	chunk := func(values map[string]string) multipartFixture {
		return multipartBody(t, map[string]string{"files:Вставка.md": "# Вставленная глава\nТекст вставки.\n"},
			nil, values)
	}
	post := func(user uuid.UUID, body multipartFixture) *httptest.ResponseRecorder {
		return doJSON(t, h, http.MethodPost, "/api/projects/"+projectID.String()+"/import/markdown",
			user, bytes.NewReader(body.body), body.contentType)
	}

	// Под главу 1: вставленное становится её ребёнком, проект остаётся тем же.
	rec := post(owner, chunk(map[string]string{"parent_id": testyjs.Event1.String()}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	var res struct {
		ProjectID uuid.UUID `json:"project_id"`
		Events    int       `json:"events"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("json: %v (%s)", err, rec.Body.String())
	}
	if res.ProjectID != projectID || res.Events != 1 {
		t.Fatalf("ответ вставки: %+v", res)
	}
	rows, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	inserted := false
	for _, row := range rows {
		if row.Title != "Вставленная глава" {
			continue
		}
		inserted = true
		if row.ParentID == nil || *row.ParentID != testyjs.Event1 {
			t.Errorf("вставка не под главой 1: %+v", row.ParentID)
		}
	}
	if !inserted {
		t.Fatalf("вставленного события нет в проекте: %+v", titles(rows))
	}
	// Проект не задвоился: импорт «в место» — не создание проекта.
	list, err := e.proj.List(ctx, owner)
	if err != nil {
		t.Fatalf("список проектов: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("проектов %d, ожидался 1", len(list))
	}

	// Читатель править не может: 403, а не «ошибка сервера».
	if rec := post(viewer, chunk(nil)); rec.Code != http.StatusForbidden {
		t.Fatalf("читатель: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// Посторонний — тоже 403 (существование проекта ему не подтверждаем).
	if rec := post(e.user(t, "stranger@example.com"), chunk(nil)); rec.Code != http.StatusForbidden {
		t.Fatalf("посторонний: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// Мусор в месте вставки — 400 с именем поля, а не молчаливая вставка в конец.
	rec = post(owner, chunk(map[string]string{"after_id": "не-uuid"}))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "after_id") {
		t.Fatalf("битый after_id: код %d, тело %s", rec.Code, rec.Body.String())
	}
	// «Перед» и «после» одновременно места не задают: это разные места.
	rec = post(owner, chunk(map[string]string{
		"after_id":  testyjs.Event1.String(),
		"before_id": testyjs.Event2.String(),
	}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("after_id+before_id: код %d, тело %s", rec.Code, rec.Body.String())
	}
}
