package transfer_test

// markdown_integration_test.go — выгрузка Markdown и импорт папки на настоящей
// базе: только так видно, что картинки в ленте стоят у СВОИХ событий (привязки
// живут в CRDT-снапшоте), что zip-выгрузка остаётся архивом переноса и что
// круговой обмен «выгрузили → загрузили» даёт то же дерево.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform/testyjs"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// seedStoryProject сеет проект «как у пользователя»: три кадра (глава,
// под-событие, под-шаг), три вложения и НАСТОЯЩИЙ CRDT-снапшот, в котором
// записано, какая картинка к какому кадру прикреплена (в таблицах этой связи
// нет). Идентификаторы — из фикстуры testyjs.
func (e *env) seedStoryProject(t *testing.T, owner uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	p, err := e.proj.Create(ctx, owner, "Галактическая сага", "История одной станции")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	date := time.Date(2024, 5, 17, 0, 0, 0, 0, time.UTC)
	rows := []store.Event{
		{ID: testyjs.Event1, ProjectID: p.ID, Position: 0, Depth: 0, Title: "Глава 1", Body: "Текст главы.", EventDate: &date},
		{ID: testyjs.Event2, ProjectID: p.ID, ParentID: ptrID(testyjs.Event1), Position: 0, Depth: 1, Title: "Под-событие", Body: "Текст под-события."},
		{ID: testyjs.Event3, ProjectID: p.ID, ParentID: ptrID(testyjs.Event2), Position: 0, Depth: 2, Title: "Под-шаг", Body: "Текст под-шага."},
	}
	if err := e.st.InsertEventTree(ctx, p.ID, owner, rows); err != nil {
		t.Fatalf("events: %v", err)
	}

	for _, a := range []struct {
		id   uuid.UUID
		name string
	}{
		{testyjs.Asset1, "схема.png"},
		{testyjs.Asset2, "старт.png"},
		{testyjs.Asset3, "финал.png"},
	} {
		content := []byte("данные-" + a.name)
		key := p.ID.String() + "/" + a.id.String()
		if err := e.obj.Put(ctx, key, "image/png", bytes.NewReader(content), int64(len(content))); err != nil {
			t.Fatalf("put asset: %v", err)
		}
		if err := e.st.InsertAsset(ctx, &store.Asset{
			ID: a.id, ProjectID: p.ID, OwnerID: owner, Filename: a.name,
			Mime: "image/png", Size: int64(len(content)), S3Key: key, Kind: "image",
		}); err != nil {
			t.Fatalf("insert asset: %v", err)
		}
	}

	if _, err := e.st.SaveProjectEventState(ctx, p.ID, owner, testyjs.State(), 0); err != nil {
		t.Fatalf("state: %v", err)
	}
	return p.ID
}

func ptrID(id uuid.UUID) *uuid.UUID { return &id }

// storyLine — ожидаемая история одной лентой: заголовки по глубине, машинные
// комментарии с номерами кадров, тела и картинки строго после текста своего кадра.
func TestExportMarkdown_Lane(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)

	var buf bytes.Buffer
	info, err := e.transfer.ExportMarkdown(ctx, owner, projectID, &buf)
	if err != nil {
		t.Fatalf("export markdown: %v", err)
	}
	if info.Events != 3 || info.Assets != 3 {
		t.Errorf("в выгрузке %d событий и %d вложений, ожидалось 3 и 3", info.Events, info.Assets)
	}
	if info.Filename != "project.md" {
		t.Errorf("имя файла: %q (кириллический заголовок даёт нейтральное имя)", info.Filename)
	}

	got := buf.String()
	for _, want := range []string{
		"# Галактическая сага\nИстория одной станции\n",
		"<!-- skyfraze: number=01 id=" + testyjs.Event1.String() + " kind=event -->",
		"## 01 Глава 1\nТекст главы.",
		"![01·1](/api/assets/" + testyjs.Asset1.String() + ")",
		"![01·2](/api/assets/" + testyjs.Asset2.String() + ")",
		"<!-- skyfraze: number=01.1 id=" + testyjs.Event2.String() + " kind=event -->",
		"### 01.1 Под-событие\nТекст под-события.",
		"![01.1·1](/api/assets/" + testyjs.Asset2.String() + ")",
		"#### 01.1.1 Под-шаг\nТекст под-шага.",
		"![01.1.1·1](/api/assets/" + testyjs.Asset3.String() + ")",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("в ленте нет фрагмента:\n%s\n--- получено ---\n%s", want, got)
		}
	}

	// Порядок: картинки главы идут ДО комментария следующего кадра (в таймлайне
	// иллюстрации показываются сразу после текста, до вложенных событий).
	firstImg := strings.Index(got, "![01·1]")
	secondComment := strings.Index(got, "number=01.1")
	if firstImg < 0 || secondComment < 0 || firstImg > secondComment {
		t.Errorf("картинки главы должны стоять до следующего кадра:\n%s", got)
	}
}

// Zip-выгрузка: ровно обещанный состав, относительные ссылки, манифест переноса
// (то есть архив годится и для «Импорта проекта»), README.
func TestExportMarkdownZip_ContentsAndTransferImport(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)

	var buf bytes.Buffer
	info, err := e.transfer.ExportMarkdownZip(ctx, owner, projectID, &buf)
	if err != nil {
		t.Fatalf("export zip: %v", err)
	}
	if info.Filename != "project-md.zip" {
		t.Errorf("имя архива: %q", info.Filename)
	}

	entries := readZipEntries(t, buf.Bytes())
	wantNames := map[string]bool{
		"story.md":                  true,
		"story/01-Глава-1.md":       true,
		"story/01.1-Под-событие.md": true,
		"story/01.1.1-Под-шаг.md":   true,
		"assets/01-схема.png":       true,
		"assets/02-старт.png":       true,
		"assets/03-финал.png":       true,
		"manifest.json":             true,
		"README.txt":                true,
	}
	if len(entries) != len(wantNames) {
		t.Fatalf("в архиве %d записей, ожидалось %d: %v", len(entries), len(wantNames), entryNames(entries))
	}
	for name := range wantNames {
		if _, ok := entries[name]; !ok {
			t.Errorf("в архиве нет %s (есть %v)", name, entryNames(entries))
		}
	}

	// story.md — те же ссылки, но относительные.
	lane := string(entries["story.md"])
	for _, want := range []string{
		"![01·1](assets/01-схема.png)",
		"![01·2](assets/02-старт.png)",
		"![01.1·1](assets/02-старт.png)",
		"![01.1.1·1](assets/03-финал.png)",
		"## 01 Глава 1",
		"### 01.1 Под-событие",
		"#### 01.1.1 Под-шаг",
	} {
		if !strings.Contains(lane, want) {
			t.Errorf("в story.md нет %q:\n%s", want, lane)
		}
	}
	if strings.Contains(lane, "/api/assets/") {
		t.Errorf("в архиве ссылки должны быть относительными:\n%s", lane)
	}
	// Файлы story/ — на уровень глубже, поэтому ссылки с ../.
	file := string(entries["story/01-Глава-1.md"])
	for _, want := range []string{
		"<!-- skyfraze: number=01 id=" + testyjs.Event1.String() + " kind=event -->",
		"# 01 Глава 1",
		"Текст главы.",
		"../assets/01-схема.png",
	} {
		if !strings.Contains(file, want) {
			t.Errorf("в story/01-Глава-1.md нет %q:\n%s", want, file)
		}
	}

	// README объясняет, что это за архив.
	readme := string(entries["README.txt"])
	if lines := strings.Count(strings.TrimSpace(readme), "\n") + 1; lines < 5 || lines > 10 {
		t.Errorf("README.txt: %d строк, ожидалось 5-10:\n%s", lines, readme)
	}
	for _, want := range []string{"story.md", "story/", "manifest.json", "assets/"} {
		if !strings.Contains(readme, want) {
			t.Errorf("README.txt не упоминает %q:\n%s", want, readme)
		}
	}

	// Манифест — тот же формат, что у архива переноса, и файлы в нём указывают на
	// реально лежащие в архиве записи.
	bundle, err := transfer.ParseBundle(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("манифест должен разбираться переносом: %v", err)
	}
	if bundle.Manifest.Project.Title != "Галактическая сага" || len(bundle.Manifest.Events) != 3 {
		t.Errorf("манифест: %+v", bundle.Manifest.Project)
	}
	if bundle.Manifest.HasState {
		t.Error("в архиве md нет снапшота — манифест не должен обещать state.bin")
	}
	for _, a := range bundle.Manifest.Assets {
		if _, ok := entries[a.File]; !ok {
			t.Errorf("манифест ссылается на отсутствующий файл %s", a.File)
		}
	}
	// Каждый ассет должен быть читаем через перенос (иначе архив не «годится и для импорта»).
	if _, err := bundle.AssetReader(bundle.Manifest.Assets[0]); err != nil {
		t.Errorf("вложение не читается из архива: %v", err)
	}

	// «Другой стенд»: удаляем исходный проект и импортируем этот же архив переносом.
	if err := e.st.DeleteProject(ctx, projectID); err != nil {
		t.Fatalf("delete source: %v", err)
	}
	res, err := e.transfer.Import(ctx, owner, bundle)
	if err != nil {
		t.Fatalf("импорт архива переносом: %v", err)
	}
	if res.Events != 3 || res.Assets != 3 {
		t.Errorf("после импорта: событий %d, вложений %d", res.Events, res.Assets)
	}
	evs, err := e.st.ListEvents(ctx, res.Project.ID)
	if err != nil || len(evs) != 3 {
		t.Fatalf("событий после импорта: %d (err=%v)", len(evs), err)
	}
	if evs[0].Title != "Глава 1" || evs[2].Title != "Под-шаг" {
		t.Errorf("заголовки не перенеслись: %+v", evs)
	}
}

// Круговой обмен: выгрузка zip → разбор тем же импортом → дерево совпадает
// (номера, заголовки, вложенность, тела), а заголовок и дата переживают круг
// целиком: выгрузка пишет их в front-matter, импорт читает оттуда же и не
// задваивает заголовок строкой H1. Это обязательное свойство формата.
func TestMarkdownRoundTrip(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.ExportMarkdownZip(ctx, owner, projectID, &buf); err != nil {
		t.Fatalf("export zip: %v", err)
	}
	parsed, err := transfer.ParseMarkdownZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}

	want := []struct {
		number, title, body string
		depth               int
		// date — дата события в виде ГГГГ-ММ-ДД ("" — даты нет).
		date string
	}{
		{"01", "Глава 1", "Текст главы.", 0, "2024-05-17"},
		{"01.1", "Под-событие", "Текст под-события.", 1, ""},
		{"01.1.1", "Под-шаг", "Текст под-шага.", 2, ""},
	}
	if parsed.ProjectTitle != "Галактическая сага" {
		t.Errorf("название проекта не восстановилось: %q", parsed.ProjectTitle)
	}
	if len(parsed.Events) != len(want) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(parsed.Events), len(want), parsed.Events)
	}
	for i, w := range want {
		got := parsed.Events[i]
		if got.Number != w.number || got.Title != w.title || got.Body != w.body || got.Depth != w.depth {
			t.Errorf("кадр #%d: получено {%s %d %q %q}, ожидалось {%s %d %q %q}",
				i, got.Number, got.Depth, got.Title, got.Body, w.number, w.depth, w.title, w.body)
		}
		if dateOf(got.Date) != w.date {
			t.Errorf("дата кадра #%d: получено %q, ожидалось %q", i, dateOf(got.Date), w.date)
		}
		// Заголовок взят из front-matter, а H1 в файле остался: в теле его быть
		// не должно, иначе в приложении заголовок задвоится.
		if strings.HasPrefix(got.Body, "# ") {
			t.Errorf("в теле кадра #%d остался H1: %q", i, got.Body)
		}
	}

	// Импорт создаёт НОВЫЙ проект владельца с тем же деревом.
	p, err := e.transfer.ImportMarkdown(ctx, owner, parsed, "")
	if err != nil {
		t.Fatalf("import markdown: %v", err)
	}
	if p.ID == projectID {
		t.Fatal("импорт обязан создавать новый проект")
	}
	if p.Title != "Галактическая сага" || p.Description != "История одной станции" {
		t.Errorf("метаданные проекта: %+v", p)
	}
	evs, err := e.st.ListEvents(ctx, p.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(evs) != 3 {
		t.Fatalf("событий в проекте: %d", len(evs))
	}
	for i, w := range want {
		if evs[i].Depth != int16(w.depth) || evs[i].Title != w.title || evs[i].Body != w.body {
			t.Errorf("событие #%d в базе: %+v, ожидалось %+v", i, evs[i], w)
		}
		if evs[i].Position != 0 {
			t.Errorf("позиция события #%d: %d", i, evs[i].Position)
		}
		if dateOf(evs[i].EventDate) != w.date {
			t.Errorf("дата события #%d в базе: %v, ожидалось %q", i, evs[i].EventDate, w.date)
		}
	}
	if evs[0].ParentID != nil || evs[1].ParentID == nil || *evs[1].ParentID != evs[0].ID {
		t.Error("вложенность верхнего уровня не сохранилась")
	}
	if evs[2].ParentID == nil || *evs[2].ParentID != evs[1].ID {
		t.Error("вложенность под-шага не сохранилась")
	}
}

// dateOf — дата события в виде ГГГГ-ММ-ДД, "" — даты нет.
func dateOf(d *time.Time) string {
	if d == nil {
		return ""
	}
	return d.Format("2006-01-02")
}

// Front-matter на «неудобных» заголовках: двоеточие, кавычки, решётка и обратный
// слэш обязаны пережить и файл (значение в кавычках с экранированием), и круг
// «выгрузка → импорт» — байт в байт.
func TestMarkdownRoundTrip_QuotedTitles(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	p, err := e.proj.Create(ctx, owner, "Служебные символы", "")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	date := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	titles := []string{
		"Сборка: «Прометей-7»",
		`Он сказал "старт" и ушёл`,
		"#1 старт",
		`C:\верфь`,
	}
	rows := make([]store.Event, 0, len(titles))
	for i, title := range titles {
		row := store.Event{
			ID: uuid.New(), ProjectID: p.ID, Position: i, Depth: 0,
			Title: title, Body: "Тело события.",
		}
		if i == 0 {
			row.EventDate = &date
		}
		rows = append(rows, row)
	}
	if err := e.st.InsertEventTree(ctx, p.ID, owner, rows); err != nil {
		t.Fatalf("events: %v", err)
	}

	var buf bytes.Buffer
	if _, err := e.transfer.ExportMarkdownZip(ctx, owner, p.ID, &buf); err != nil {
		t.Fatalf("export zip: %v", err)
	}
	entries := readZipEntries(t, buf.Bytes())

	var storyFiles strings.Builder
	for name, content := range entries {
		if strings.HasPrefix(name, "story/") {
			storyFiles.Write(content)
		}
	}
	// Значение со служебным символом выгрузка пишет в двойных кавычках и
	// экранирует `"` и `\` — ровно то, что снимет импорт.
	for _, want := range []string{
		"title: \"Сборка: «Прометей-7»\"",
		"title: \"Он сказал \\\"старт\\\" и ушёл\"",
		"title: \"#1 старт\"",
		"title: \"C:\\\\верфь\"",
		"date: 2026-01-15",
	} {
		if !strings.Contains(storyFiles.String(), want) {
			t.Errorf("в front-matter выгрузки нет %q:\n%s", want, storyFiles.String())
		}
	}

	parsed, err := transfer.ParseMarkdownZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("разбор архива: %v", err)
	}
	if len(parsed.Events) != len(titles) {
		t.Fatalf("событий %d, ожидалось %d: %+v", len(parsed.Events), len(titles), parsed.Events)
	}
	for i, title := range titles {
		got := parsed.Events[i]
		if got.Title != title {
			t.Errorf("заголовок кадра #%d: получено %q, ожидалось %q", i, got.Title, title)
		}
		if strings.HasPrefix(got.Body, "# ") {
			t.Errorf("в теле кадра #%d остался H1: %q", i, got.Body)
		}
		want := ""
		if i == 0 {
			want = "2026-01-15"
		}
		if dateOf(got.Date) != want {
			t.Errorf("дата кадра #%d: получено %q, ожидалось %q", i, dateOf(got.Date), want)
		}
	}

	imported, err := e.transfer.ImportMarkdown(ctx, owner, parsed, "")
	if err != nil {
		t.Fatalf("import markdown: %v", err)
	}
	evs, err := e.st.ListEvents(ctx, imported.ID)
	if err != nil || len(evs) != len(titles) {
		t.Fatalf("событий в базе: %d (err=%v)", len(evs), err)
	}
	for i, title := range titles {
		if evs[i].Title != title || evs[i].Body != "Тело события." {
			t.Errorf("событие #%d в базе: %+v, ожидался заголовок %q", i, evs[i], title)
		}
		want := ""
		if i == 0 {
			want = "2026-01-15"
		}
		if dateOf(evs[i].EventDate) != want {
			t.Errorf("дата события #%d в базе: %v, ожидалось %q", i, evs[i].EventDate, want)
		}
	}
}

// Импорт сохраняет дату из front-matter в базу и больше не предупреждает о CRDT:
// засев пустого Y.Doc из таблицы событий несёт event_date, поэтому дата видна
// первому редактору (и уезжает обратно в базу вместе с проекцией дерева).
func TestImportMarkdown_SavesDateAndWarns(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	parsed, err := parseFolder(t, map[string]string{
		"01-Пролог.md": "---\ntitle: Пролог\ndate: 2024-05-17\n---\n\nТекст главы.\n",
		"01.1-Шаг.md":  "# Шаг\nШаг главы.\n",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	p, err := e.transfer.ImportMarkdown(ctx, owner, parsed, "Своё название")
	if err != nil {
		t.Fatalf("import markdown: %v", err)
	}
	if p.Title != "Своё название" {
		t.Errorf("поле title запроса должно побеждать: %q", p.Title)
	}
	if hasWarning(parsed.Warnings, "CRDT-засев") {
		t.Errorf("устаревшее предупреждение про дату и CRDT: %v", parsed.Warnings)
	}
	evs, err := e.st.ListEvents(ctx, p.ID)
	if err != nil || len(evs) != 2 {
		t.Fatalf("событий: %d (err=%v)", len(evs), err)
	}
	if evs[0].EventDate == nil || evs[0].EventDate.Format("2006-01-02") != "2024-05-17" {
		t.Errorf("дата не сохранилась в базе: %v", evs[0].EventDate)
	}
	if evs[1].EventDate != nil {
		t.Errorf("у события без даты она не должна появиться: %v", evs[1].EventDate)
	}
	// CRDT-снапшота у нового проекта нет: первый редактор засеет его из таблицы.
	st, err := e.st.GetProjectEventState(ctx, p.ID)
	if err != nil || st != nil {
		t.Errorf("у импортированного проекта не должно быть снапшота: %+v (err=%v)", st, err)
	}
}

// Полный архив переноса тоже получает story.md и story/: обе выгрузки описывают
// проект одинаково.
func TestExportTransferArchive_HasStory(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)

	var buf bytes.Buffer
	if _, err := e.transfer.Export(ctx, owner, projectID, &buf); err != nil {
		t.Fatalf("export: %v", err)
	}
	entries := readZipEntries(t, buf.Bytes())
	if _, ok := entries["state.bin"]; !ok {
		t.Error("архив переноса потерял CRDT-снапшот")
	}
	lane, ok := entries["story.md"]
	if !ok {
		t.Fatalf("в архиве переноса нет story.md: %v", entryNames(entries))
	}
	// В архиве переноса вложения лежат под своими id — и ссылки в ленте тоже.
	if !strings.Contains(string(lane), "![01·1](assets/"+testyjs.Asset1.String()+")") {
		t.Errorf("ссылки ленты не указывают на файлы архива:\n%s", lane)
	}
	file, ok := entries["story/01-Глава-1.md"]
	if !ok {
		t.Fatalf("в архиве переноса нет story/01-Глава-1.md: %v", entryNames(entries))
	}
	if !strings.Contains(string(file), "../assets/"+testyjs.Asset1.String()) {
		t.Errorf("в story/ ссылка должна вести на уровень выше:\n%s", file)
	}
}

// Выгрузка Markdown — viewer+, как у архива переноса и у чтения проекта; импорт —
// любой вошедший (как обычное создание проекта).
func TestMarkdownPermissions(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	viewer := e.user(t, "viewer@example.com")
	stranger := e.user(t, "stranger@example.com")
	projectID := e.seedStoryProject(t, owner)
	if err := e.st.AddMembership(ctx, projectID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("membership: %v", err)
	}

	var buf bytes.Buffer
	if _, err := e.transfer.ExportMarkdown(ctx, stranger, projectID, &buf); !errors.Is(err, transfer.ErrForbidden) {
		t.Errorf("посторонний: %v", err)
	}
	if _, err := e.transfer.ExportMarkdownZip(ctx, stranger, projectID, &buf); !errors.Is(err, transfer.ErrForbidden) {
		t.Errorf("посторонний (zip): %v", err)
	}
	// Читатель выгружает: он и так видит всё содержимое проекта, а второй уровень
	// доступа к тому же контенту только путал бы (у /export он тоже viewer+).
	info, err := e.transfer.ExportMarkdown(ctx, viewer, projectID, &buf)
	if err != nil {
		t.Fatalf("читатель должен выгружать ленту: %v", err)
	}
	if info.Events != 3 {
		t.Errorf("в ленте читателя %d событий", info.Events)
	}
	buf.Reset()
	if _, err := e.transfer.ExportMarkdownZip(ctx, viewer, projectID, &buf); err != nil {
		t.Fatalf("читатель должен выгружать архив: %v", err)
	}
	// Несуществующий проект тоже даёт forbidden: сервис проектов намеренно не
	// рассказывает постороннему, существует проект или нет.
	if _, err := e.transfer.ExportMarkdown(ctx, uuid.New(), uuid.New(), &buf); !errors.Is(err, transfer.ErrForbidden) {
		t.Errorf("чужой/несуществующий проект: %v", err)
	}

	// Импорт доступен любому вошедшему: он создаёт свой проект.
	parsed, err := parseFolder(t, map[string]string{"01-Пролог.md": "# Пролог\nТекст.\n"})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	p, err := e.transfer.ImportMarkdown(ctx, viewer, parsed, "")
	if err != nil {
		t.Fatalf("импорт читателем: %v", err)
	}
	if p.OwnerID != viewer {
		t.Errorf("владельцем импортированного проекта должен стать импортирующий: %s", p.OwnerID)
	}
}

// ---------- вспомогательное ----------

// markdownRouter собирает ровно те ветки, что регистрирует cmd/server/main.go:
// так тест проверяет и заголовки ответов, и разбор multipart, и то, что
// static-пути импорта не перехватываются параметрическим /api/projects/{id}.
func markdownRouter(svc *transfer.Service) http.Handler {
	authSvc := auth.New(nil, mdRoutesSecret)
	h := transfer.NewHandler(svc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := chi.NewRouter()
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown/preview", h.MarkdownPreview)
	r.With(authSvc.WithUser).Post("/api/projects/import/markdown", h.MarkdownImport)
	r.Route("/api/projects/{id}", func(r chi.Router) {
		r.Use(authSvc.WithUser)
		r.Get("/export.md", h.ExportMarkdown)
	})
	return r
}

// doJSON выполняет запрос с токеном пользователя и возвращает ответ.
func doJSON(t *testing.T, h http.Handler, method, path string, user uuid.UUID, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := auth.IssueAccess(mdRoutesSecret, user)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// Заголовки выгрузки — часть контракта: имя файла и тип содержимого.
func TestExportMarkdownHTTP_Headers(t *testing.T) {
	e := setup(t)
	owner := e.user(t, "owner@example.com")
	projectID := e.seedStoryProject(t, owner)
	h := markdownRouter(e.transfer)

	rec := doJSON(t, h, http.MethodGet, "/api/projects/"+projectID.String()+"/export.md", owner, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d, тело %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/markdown; charset=utf-8" {
		t.Errorf("Content-Type: %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="project.md"` {
		t.Errorf("Content-Disposition: %q", cd)
	}
	if !strings.HasPrefix(rec.Body.String(), "# Галактическая сага\n") {
		t.Errorf("тело не начинается с заголовка проекта:\n%s", rec.Body.String())
	}

	rec = doJSON(t, h, http.MethodGet, "/api/projects/"+projectID.String()+"/export.md?assets=1", owner, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("zip: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type архива: %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="project-md.zip"` {
		t.Errorf("Content-Disposition архива: %q", cd)
	}
	if _, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len())); err != nil {
		t.Errorf("ответ не читается как zip: %v", err)
	}
}

// HTTP-контракт импорта: preview отдаёт дерево и ничего не пишет, импорт создаёт
// проект; оба принимают и папку (поле files), и zip (поле archive).
func TestImportMarkdownHTTP_Contract(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	h := markdownRouter(e.transfer)

	folder := multipartBody(t, map[string]string{
		"files:Глава 01/01-Пролог.md": "# Пролог\nТекст главы.\n",
		"files:Глава 01/01.1-Шаг.md":  "# Шаг\nШаг главы.\n",
		"files:заметки.txt":           "не md\n",
	}, nil)

	rec := doJSON(t, h, http.MethodPost, "/api/projects/import/markdown/preview", owner,
		bytes.NewReader(folder.body), folder.contentType)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var preview struct {
		ProjectTitle string `json:"project_title"`
		Events       []struct {
			Number   string   `json:"number"`
			Depth    int      `json:"depth"`
			Title    string   `json:"title"`
			Path     string   `json:"path"`
			Chars    int      `json:"chars"`
			Warnings []string `json:"warnings"`
		} `json:"events"`
		Warnings []string `json:"warnings"`
		Stats    struct {
			Files      int `json:"files"`
			Events     int `json:"events"`
			Chars      int `json:"chars"`
			ImageLinks int `json:"image_links"`
		} `json:"stats"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
		t.Fatalf("preview json: %v (%s)", err, rec.Body.String())
	}
	if len(preview.Events) != 3 {
		t.Fatalf("preview: событий %d, ожидалось 3 (%s)", len(preview.Events), rec.Body.String())
	}
	if preview.Events[0].Title != "Глава 01" || preview.Events[0].Depth != 0 ||
		preview.Events[1].Title != "Пролог" || preview.Events[1].Depth != 1 ||
		preview.Events[1].Number != "01.1" {
		t.Errorf("preview: дерево не совпало: %+v", preview.Events)
	}
	if preview.Stats.Files != 2 || preview.Stats.Events != 3 {
		t.Errorf("preview: счётчики %+v", preview.Stats)
	}
	if preview.Events[1].Chars != len([]rune("Текст главы.")) {
		t.Errorf("preview: знаков в событии %d", preview.Events[1].Chars)
	}
	// Предпросмотр ничего не записал.
	list, err := e.proj.List(ctx, owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("предпросмотр создал проекты: %d", len(list))
	}

	// Импорт папки: создаётся новый проект со своим названием.
	rec = doJSON(t, h, http.MethodPost, "/api/projects/import/markdown", owner,
		bytes.NewReader(folder.body), folder.contentType)
	if rec.Code != http.StatusCreated {
		t.Fatalf("import: код %d, тело %s", rec.Code, rec.Body.String())
	}
	var imported struct {
		ProjectID uuid.UUID `json:"project_id"`
		Events    int       `json:"events"`
		Warnings  []string  `json:"warnings"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("import json: %v (%s)", err, rec.Body.String())
	}
	if imported.Events != 3 || imported.ProjectID == uuid.Nil {
		t.Fatalf("import: %+v", imported)
	}
	p, err := e.st.GetProject(ctx, imported.ProjectID)
	if err != nil {
		t.Fatalf("проект не создан: %v", err)
	}
	if p.Title != "Глава 01" {
		t.Errorf("название проекта из корневой папки: %q", p.Title)
	}

	// Импорт zip в поле archive: получаем то же дерево.
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	writeFile(t, zw, "01-Пролог.md", []byte("# Пролог\nТекст главы.\n"))
	writeFile(t, zw, "01.1-Шаг.md", []byte("# Шаг\nШаг главы.\n"))
	closeZip(t, zw)
	archive := multipartBody(t, nil, map[string][]byte{"archive:история.zip": zipBuf.Bytes()})

	rec = doJSON(t, h, http.MethodPost, "/api/projects/import/markdown", owner,
		bytes.NewReader(archive.body), archive.contentType)
	if rec.Code != http.StatusCreated {
		t.Fatalf("импорт архива: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("импорт архива json: %v", err)
	}
	if imported.Events != 2 {
		t.Errorf("импорт архива: событий %d", imported.Events)
	}

	// Фатальная ошибка — 400 с причиной, проект не создаётся.
	files, err := e.proj.List(ctx, owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	broken := multipartBody(t, nil, map[string][]byte{"archive:битый.zip": []byte("это не zip")})
	rec = doJSON(t, h, http.MethodPost, "/api/projects/import/markdown", owner,
		bytes.NewReader(broken.body), broken.contentType)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("битый архив: код %d, тело %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "не читается") {
		t.Errorf("в теле ошибки нет причины: %s", rec.Body.String())
	}
	after, err := e.proj.List(ctx, owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(after) != len(files) {
		t.Errorf("после ошибки число проектов изменилось: %d → %d", len(files), len(after))
	}
}

type multipartFixture struct {
	body        []byte
	contentType string
}

// multipartBody собирает multipart-запрос: ключ — «поле:имя файла» (имя части
// хранит относительный путь, каталоги в нём сохраняются), values — общие поля
// формы вроде title.
func multipartBody(t *testing.T, files map[string]string, archives map[string][]byte) multipartFixture {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for key, content := range files {
		field, name, _ := strings.Cut(key, ":")
		part, err := mw.CreateFormFile(field, name)
		if err != nil {
			t.Fatalf("multipart: %v", err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatalf("multipart write: %v", err)
		}
	}
	for key, content := range archives {
		field, name, _ := strings.Cut(key, ":")
		part, err := mw.CreateFormFile(field, name)
		if err != nil {
			t.Fatalf("multipart: %v", err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatalf("multipart write: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}
	return multipartFixture{body: buf.Bytes(), contentType: mw.FormDataContentType()}
}

// readZipEntries читает архив в память (архивы в тестах маленькие).
func readZipEntries(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	out := make(map[string][]byte, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("zip open %s: %v", f.Name, err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("zip read %s: %v", f.Name, err)
		}
		out[f.Name] = content
	}
	return out
}

func entryNames(entries map[string][]byte) []string {
	out := make([]string, 0, len(entries))
	for name := range entries {
		out = append(out, name)
	}
	return out
}
