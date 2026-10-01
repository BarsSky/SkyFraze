package transfer_test

// markdown_attachments_integration_test.go — картинки при импорте на настоящей базе.
//
// Привязка «событие → вложения» существует ТОЛЬКО в CRDT-снапшоте (таблица
// event_assets пуста с миграции 0002). Поэтому здесь проверяется не «файл записан»,
// а то, что редактор увидит картинку у своего события: файл в хранилище, строка в
// `assets`, привязка в документе — и всё это на одном и том же событии.
//
// Нужна Postgres (TEST_DATABASE_URL), как и остальным интеграционным тестам.

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/platform/testimage"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// pngBytes — настоящий PNG (см. testimage.SmallPNG): код пережатия пытается его
// декодировать, поэтому «PNG из случайных байтов» давал бы предупреждение в лог на
// каждой загрузке.
var pngBytes = testimage.SmallPNG()

func readObject(t *testing.T, e *env, key string) []byte {
	t.Helper()
	rc, err := e.obj.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("файл вложения не читается (%s): %v", key, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("файл вложения не читается до конца: %v", err)
	}
	return data
}

// Импорт папки с картинками в НОВЫЙ проект: файлы становятся вложениями проекта,
// привязываются к тем событиям, в чьих файлах о них написано, а документ
// собирается и сохраняется снапшотом — иначе привязки некуда было бы положить.
func TestImportMarkdown_AttachesImagesToNewProject(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	parsed, err := parseFolder(t, map[string]string{
		"01-Глава.md":         "---\ntitle: Глава\n---\n\nТекст главы.\n![схема](картинки/схема.png)\n",
		"02-Вторая.md":        "# Вторая\nТекст второй.\n",
		"картинки/схема.png":  string(pngBytes),
		"картинки/лишний.png": string(pngBytes),
		"заметки.txt":         "просто заметки",
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if parsed.Stats.Attachments != 1 {
		t.Fatalf("вложений %d, ожидалось 1: %+v", parsed.Stats.Attachments, parsed.Attachments)
	}

	p, err := e.transfer.ImportMarkdown(ctx, owner, parsed, "")
	if err != nil {
		t.Fatalf("импорт: %v", err)
	}

	// Файл лежит в хранилище и описан в таблице вложений проекта.
	assets, err := e.st.ListAssets(ctx, p.ID)
	if err != nil {
		t.Fatalf("вложения проекта: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("вложений в проекте %d, ожидалось 1: %+v", len(assets), assets)
	}
	asset := assets[0]
	// Картинка из набора приходит уже пережатой: имя и тип говорят о том, что
	// лежит в хранилище, а не о том, как файл назывался в папке.
	if asset.Filename != "схема.webp" || asset.Kind != "image" || asset.Mime != "image/webp" {
		t.Errorf("вложение: %+v", asset)
	}
	// Файл в хранилище соответствует строке вложения. Размер сверяем со строкой, а
	// не с исходником: картинки пережимаются при записи (см. internal/media), и
	// байты в хранилище — уже WebP.
	if got := readObject(t, e, asset.S3Key); int64(len(got)) != asset.Size {
		t.Errorf("файл в хранилище: %d байт, в строке вложения %d", len(got), asset.Size)
	}

	// Документ собран: снапшот есть, и в нём та же привязка, что увидит редактор.
	state, err := e.st.GetProjectEventState(ctx, p.ID)
	if err != nil || state == nil {
		t.Fatalf("импорт с вложениями обязан собрать документ: %+v (err=%v)", state, err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	events := doc.Events()
	if len(events) != 2 {
		t.Fatalf("событий в документе %d, ожидалось 2: %+v", len(events), events)
	}
	bindings, err := collab.AssetBindings(state.YjsState)
	if err != nil {
		t.Fatalf("привязки не читаются: %v", err)
	}
	first := events[0]
	if list := bindings[uuid.MustParse(first.ID)]; len(list) != 1 || list[0] != asset.ID {
		t.Fatalf("привязка главы: %+v (ожидалось [%s])", list, asset.ID)
	}
	// Ссылка в тексте ведёт на вложение проекта: относительный путь из чужой папки в
	// приложении не открылся бы (браузер искал бы его от страницы проекта).
	if !strings.Contains(first.Body, "](/api/assets/"+asset.ID.String()+")") {
		t.Errorf("ссылка в тексте не заменена адресом вложения: %q", first.Body)
	}
	if list := bindings[uuid.MustParse(events[1].ID)]; len(list) != 0 {
		t.Errorf("у второй главы не должно быть вложений: %+v", list)
	}
	// Фон кадра — первая картинка события: иначе картинка была бы просто в списке
	// вложений, а кадр остался бы с унаследованным фоном.
	if first.Background != asset.ID.String() {
		t.Errorf("фон кадра: %q, ожидался %s", first.Background, asset.ID)
	}

	// Таблица событий — проекция документа (не отдельная запись «похожего» дерева).
	rows, err := e.st.ListEvents(ctx, p.ID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("строки событий: %d (err=%v)", len(rows), err)
	}
	if rows[0].Title != "Глава" || rows[1].Title != "Вторая" {
		t.Errorf("дерево в таблице: %+v", rows)
	}
}

// Импорт «в место» с картинками: файл попадает в проект, а привязка — в документ
// вместе с куском (в этом и смысл: без неё картинка была бы «просто файлом»).
func TestImportMarkdownInto_AttachesImages(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Проект с куском", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	parsed, err := parseFolder(t, map[string]string{
		"01-Вставка.md":    "---\ntitle: Вставка\n---\n\nТекст.\n![карта](assets/карта.png)\n",
		"assets/карта.png": string(pngBytes),
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}

	res, err := e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed, transfer.InsertPlace{})
	if err != nil {
		t.Fatalf("вставка: %v", err)
	}
	if res.Events != 1 || res.Warning != "" {
		t.Fatalf("результат вставки: %+v", res)
	}

	assets, err := e.st.ListAssets(ctx, project.ID)
	if err != nil || len(assets) != 1 {
		t.Fatalf("вложения проекта: %+v (err=%v)", assets, err)
	}
	state, err := e.st.GetProjectEventState(ctx, project.ID)
	if err != nil || state == nil {
		t.Fatalf("снапшот после вставки: %+v (err=%v)", state, err)
	}
	doc, err := yjs.FromState(state.YjsState)
	if err != nil {
		t.Fatalf("снапшот не читается: %v", err)
	}
	events := doc.Events()
	if len(events) != 1 {
		t.Fatalf("событий в документе %d: %+v", len(events), events)
	}
	bindings, err := collab.AssetBindings(state.YjsState)
	if err != nil {
		t.Fatalf("привязки не читаются: %v", err)
	}
	if list := bindings[uuid.MustParse(events[0].ID)]; len(list) != 1 || list[0] != assets[0].ID {
		t.Fatalf("привязка вставленного события: %+v (ожидалось [%s])", list, assets[0].ID)
	}
	if events[0].Background != assets[0].ID.String() {
		t.Errorf("фон вставленного кадра: %q, ожидался %s", events[0].Background, assets[0].ID)
	}
}

// Если в папке нет ни одного md, проект создавать не из чего: файлы не становятся
// содержимым проекта, и ошибка остаётся прежней.
func TestImportMarkdown_ImagesWithoutEvents(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	parsed, err := parseFolder(t, map[string]string{"картинки/схема.png": string(pngBytes)})
	if err == nil {
		t.Fatalf("ожидалась ошибка «нет md-файлов», получено: %+v", parsed)
	}
	if projects, err := e.proj.List(ctx, owner); err != nil || len(projects) != 0 {
		t.Fatalf("проектов после отказа: %d (err=%v)", len(projects), err)
	}
}

// Отказ «в место» не оставляет за собой ни файлов, ни строк вложений: человек
// ничего не прикреплял, а повтор импорта добавил бы вторые такие же файлы.
func TestImportMarkdownInto_RefusalKeepsNoFiles(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")

	project, err := e.proj.Create(ctx, owner, "Глубокий проект", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	// Цепочка из четырёх уровней: кусок под её низ не влезет.
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	rows := []store.Event{{ID: ids[0], ProjectID: project.ID, Position: 0, Depth: 0, Title: "Уровень 0", Body: "текст"}}
	for i := 1; i < len(ids); i++ {
		rows = append(rows, store.Event{
			ID: ids[i], ProjectID: project.ID, ParentID: &ids[i-1], Position: i,
			Depth: int16(i), Title: "Уровень " + strconv.Itoa(i), Body: "текст",
		})
	}
	if err := e.st.InsertEventTree(ctx, project.ID, owner, rows); err != nil {
		t.Fatalf("дерево: %v", err)
	}

	parsed, err := parseFolder(t, map[string]string{
		"01-Кусок.md":        "---\ntitle: Кусок\n---\n\n![схема](картинки/схема.png)\n",
		"01.1-Внутри.md":     "# Внутри\nтело\n",
		"01.1.1-Глубже.md":   "# Глубже\nтело\n",
		"картинки/схема.png": string(pngBytes),
	})
	if err != nil {
		t.Fatalf("разбор: %v", err)
	}
	if parsed.Stats.Attachments != 1 {
		t.Fatalf("вложений в разборе %d: %+v", parsed.Stats.Attachments, parsed.Attachments)
	}

	_, err = e.transfer.ImportMarkdownInto(ctx, owner, project.ID, parsed,
		transfer.InsertPlace{ParentID: &ids[3]})
	if !errors.Is(err, transfer.ErrMarkdownTooDeep) {
		t.Fatalf("ожидался отказ по глубине, получено: %v", err)
	}

	// Файла нет ни в хранилище, ни в списке вложений проекта.
	files, err := e.obj.List(ctx, project.ID.String()+"/")
	if err != nil {
		t.Fatalf("список файлов: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("после отказа в хранилище остались файлы: %+v", files)
	}
	if list, err := e.st.ListAssets(ctx, project.ID); err != nil || len(list) != 0 {
		t.Errorf("после отказа остались строки вложений: %+v (err=%v)", list, err)
	}
	// Дерево проекта не изменилось.
	if after, err := e.st.ListEvents(ctx, project.ID); err != nil || len(after) != len(rows) {
		t.Fatalf("после отказа событий %d, ожидалось %d (err=%v)", len(after), len(rows), err)
	}
}
