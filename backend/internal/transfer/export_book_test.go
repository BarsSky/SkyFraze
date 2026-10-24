package transfer_test

// export_book_test.go — выгрузка книги (EPUB/DOCX).
//
// Проверяем ровно то, что можно проверить объективно, без «открыл в читалке и понравилось»:
// EPUB — это zip, и у него есть требования спецификации (первая запись `mimetype`, без
// сжатия; container.xml указывает на OPF; в OPF есть nav; оглавление ведёт на реальные
// файлы; текст кадра на месте и экранирован). DOCX — тоже zip с обязательными частями
// (Content_Types, связи, document.xml).
//
// Почему это важно: самодельные сборщики EPUB ломаются именно на `mimetype` (сжатый или не
// первый) и на несовпадении путей в OPF и архиве — и файл открывается не везде. Тест ловит
// это на сборке.

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

// zipFiles открывает архив и возвращает карту «имя → содержимое» и порядок записей.
func zipFiles(t *testing.T, data []byte) (map[string]string, []string) {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("архив не читается: %v", err)
	}
	files := make(map[string]string, len(reader.File))
	order := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		order = append(order, file.Name)
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("файл %s: %v", file.Name, err)
		}
		content, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("файл %s: %v", file.Name, err)
		}
		files[file.Name] = string(content)
	}
	return files, order
}

func TestExportEPUB(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, chapter, child := e.projectWithBook(t, owner)

	var buf bytes.Buffer
	info, err := e.transfer.ExportEPUB(ctx, owner, project, &buf)
	if err != nil {
		t.Fatalf("epub: %v", err)
	}
	if info.Events != 3 {
		t.Errorf("кадров в книге: %d", info.Events)
	}
	if !strings.HasSuffix(info.Filename, ".epub") {
		t.Errorf("имя файла: %q", info.Filename)
	}

	files, order := zipFiles(t, buf.Bytes())

	// 1. mimetype — первой записью и без сжатия (требование спецификации).
	if len(order) == 0 || order[0] != "mimetype" {
		t.Fatalf("первая запись архива: %v", order)
	}
	if files["mimetype"] != "application/epub+zip" {
		t.Errorf("mimetype: %q", files["mimetype"])
	}
	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("архив: %v", err)
	}
	if reader.File[0].Method != zip.Store {
		t.Errorf("mimetype сжат (method=%d) — часть читалок такой файл не откроет", reader.File[0].Method)
	}

	// 2. Контейнер указывает на OPF, OPF существует.
	if !strings.Contains(files["META-INF/container.xml"], `full-path="OEBPS/content.opf"`) {
		t.Errorf("container.xml: %s", files["META-INF/container.xml"])
	}
	opf, ok := files["OEBPS/content.opf"]
	if !ok {
		t.Fatal("нет OEBPS/content.opf")
	}
	if !strings.Contains(opf, `<dc:title>`) || !strings.Contains(opf, `urn:uuid:`+project.String()) {
		t.Errorf("метаданные OPF: %s", opf)
	}
	// Каждая глава из манифеста должна быть в архиве, и наоборот.
	for _, chapterFile := range []string{"text/chapter-01.xhtml", "text/chapter-02.xhtml"} {
		if _, ok := files["OEBPS/"+chapterFile]; !ok {
			t.Fatalf("нет файла главы %s", chapterFile)
		}
		if !strings.Contains(opf, chapterFile) {
			t.Errorf("глава %s не попала в манифест", chapterFile)
		}
	}

	// 3. Оглавление ведёт на существующие файлы и содержит под-событие.
	nav, ok := files["OEBPS/nav.xhtml"]
	if !ok {
		t.Fatal("нет nav.xhtml")
	}
	if !strings.Contains(nav, `epub:type="toc"`) {
		t.Errorf("nav без toc: %s", nav)
	}
	if !strings.Contains(nav, "text/chapter-01.xhtml") {
		t.Errorf("оглавление не ссылается на главу: %s", nav)
	}
	if !strings.Contains(nav, "Под-событие") {
		t.Errorf("под-событие не попало в оглавление: %s", nav)
	}

	// 4. Текст кадра на месте; разметка стала тегами, а не осталась звёздочками.
	page := files["OEBPS/text/chapter-01.xhtml"]
	if !strings.Contains(page, "Текст главы") {
		t.Errorf("текст главы не попал в книгу: %s", page)
	}
	if !strings.Contains(page, "<strong>важно</strong>") {
		t.Errorf("выделение не отрендерено: %s", page)
	}
	if strings.Contains(page, "**важно**") {
		t.Errorf("маркеры Markdown остались в XHTML: %s", page)
	}
	// 5. Идентификаторы кадров — якоря, на которые ведёт оглавление.
	if !strings.Contains(page, "f-"+chapter.String()) || !strings.Contains(page, "f-"+child.String()) {
		t.Errorf("нет якорей кадров в главе: %s", page)
	}

	// 6. Картинка кадра попала в архив, а OPF на неё ссылается — и она же обложка:
	// без свойства cover-image читалка показывает серый прямоугольник.
	images := 0
	for name := range files {
		if strings.HasPrefix(name, "OEBPS/images/") {
			images++
		}
	}
	if images != 1 {
		t.Errorf("картинок в книге: %d, ожидалась 1", images)
	}
	if !strings.Contains(opf, `properties="cover-image"`) {
		t.Errorf("обложка не помечена в манифесте: %s", opf)
	}
	if !strings.Contains(page, `src="../images/01.png"`) {
		t.Errorf("картинка не вставлена в главу: %s", page)
	}

	// 7. Текст экранирован: «<script>» в кадре (он у под-события в первой главе) не должен
	// стать разметкой.
	if strings.Contains(page, "<script>") {
		t.Errorf("HTML из текста кадра стал разметкой: %s", page)
	}
	if !strings.Contains(page, "&lt;script&gt;") {
		t.Errorf("текст с угловыми скобками не экранирован: %s", page)
	}
}

func TestExportDOCX(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, _, _ := e.projectWithBook(t, owner)

	var buf bytes.Buffer
	info, err := e.transfer.ExportDOCX(ctx, owner, project, &buf)
	if err != nil {
		t.Fatalf("docx: %v", err)
	}
	if !strings.HasSuffix(info.Filename, ".docx") {
		t.Errorf("имя файла: %q", info.Filename)
	}

	files, _ := zipFiles(t, buf.Bytes())
	// Обязательные части пакета: без любой из них Word файл не откроет.
	for _, name := range []string{
		"[Content_Types].xml", "_rels/.rels", "word/document.xml",
		"word/styles.xml", "word/_rels/document.xml.rels", "docProps/core.xml",
	} {
		if _, ok := files[name]; !ok {
			t.Fatalf("нет части пакета %s", name)
		}
	}

	document := files["word/document.xml"]
	if !strings.Contains(document, "Текст главы") {
		t.Errorf("текст главы не попал в документ: %s", document)
	}
	if !strings.Contains(document, "<w:b/>") {
		t.Errorf("выделение не стало жирным прогоном: %s", document)
	}
	if !strings.Contains(document, "Heading1") || !strings.Contains(document, "Heading2") {
		t.Errorf("заголовки не получили стили: %s", document)
	}
	// Картинка: связь есть и в документе, и в связях, и файл в архиве.
	if !strings.Contains(document, `<a:blip r:embed="rId10"`) {
		t.Errorf("картинка не вставлена: %s", document)
	}
	if !strings.Contains(files["word/_rels/document.xml.rels"], "media/01.png") {
		t.Errorf("связь картинки не описана: %s", files["word/_rels/document.xml.rels"])
	}
	if _, ok := files["word/media/01.png"]; !ok {
		t.Error("файла картинки нет в архиве")
	}
	// Типы содержимого должны объявить png, иначе Word не поймёт файл.
	if !strings.Contains(files["[Content_Types].xml"], `Extension="png"`) {
		t.Errorf("тип png не объявлен: %s", files["[Content_Types].xml"])
	}
}

// Права: читатель книгу скачивает (он и так видит содержимое), посторонний — нет.
func TestExportBookPermissions(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, _, _ := e.projectWithBook(t, owner)
	stranger := e.user(t, "stranger@example.com")

	var buf bytes.Buffer
	if _, err := e.transfer.ExportEPUB(ctx, owner, project, &buf); err != nil {
		t.Fatalf("владелец: %v", err)
	}
	if _, err := e.transfer.ExportEPUB(ctx, stranger, project, &buf); err == nil {
		t.Fatal("посторонний не должен скачивать книгу")
	}
}

// attachImage кладёт картинку в проект и привязывает её к кадру — тем же путём, что
// иллюстрация помощника (документ и CRDT-привязка), чтобы выгрузка видела настоящую картинку.
func (e *env) attachImage(t *testing.T, owner, projectID, eventID uuid.UUID) bool {
	t.Helper()
	ctx := context.Background()
	svc := assets.New(e.st, e.obj, e.proj)
	asset, err := svc.Upload(ctx, owner, projectID, assets.UploadOpts{
		Filename:    "обложка.png",
		ContentType: "image/png",
		Size:        int64(len(tinyPNGForAttach)),
		Reader:      bytes.NewReader(tinyPNGForAttach),
	})
	if err != nil {
		t.Fatalf("картинка: %v", err)
	}
	// Документ проекта собираем из проекции: так же выглядит проект без снапшота.
	rows, err := e.st.ListEvents(ctx, projectID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	doc := yjs.NewDoc()
	seeds := make([]yjs.EventSeed, 0, len(rows))
	for _, row := range rows {
		seed := yjs.EventSeed{ID: row.ID.String(), Title: row.Title, Body: row.Body}
		if row.ParentID != nil {
			seed.ParentID = row.ParentID.String()
		}
		seeds = append(seeds, seed)
	}
	if err := doc.SeedEvents(seeds); err != nil {
		t.Fatalf("документ: %v", err)
	}
	if _, err := doc.AttachAsset(eventID.String(), asset.ID.String(), false); err != nil {
		t.Fatalf("привязка: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, projectID, owner, doc.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	return true
}

// projectWithBook — проект с главой, под-событием и картинкой у главы.
func (e *env) projectWithBook(t *testing.T, owner uuid.UUID) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	project, err := e.proj.Create(ctx, owner, "Книга про Орион", "Короткое описание")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	chapter, child := uuid.New(), uuid.New()
	date := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	if err := e.st.ReplaceEventTree(ctx, project.ID, owner, []store.Event{
		{
			ID: chapter, ProjectID: project.ID, Position: 0, Depth: 0, Title: "Глава 1",
			Body:      "Текст главы с **важно** внутри.\n\n- пункт списка\n- второй пункт",
			EventDate: &date,
		},
		{ID: child, ProjectID: project.ID, ParentID: &chapter, Position: 1, Depth: 1,
			Title: "Под-событие", Body: "Текст <script>alert(1)</script> под-события."},
		{ID: uuid.New(), ProjectID: project.ID, Position: 2, Depth: 0, Title: "Глава 2",
			Body: "Вторая глава."},
	}); err != nil {
		t.Fatalf("дерево: %v", err)
	}
	// Картинка: настоящий PNG 1×1 (проверенный base64), привязанная к главе через CRDT.
	if !e.attachImage(t, owner, project.ID, chapter) {
		t.Fatal("картинка не привязалась — выгрузку проверять не на чем")
	}
	return project.ID, chapter, child
}
