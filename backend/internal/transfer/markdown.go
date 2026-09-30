package transfer

// markdown.go — выгрузка проекта одной лентой Markdown.
//
// Формат зафиксирован в docs/import-export.md: story.md — вся история подряд,
// story/ — по файлу на кадр, assets/ — вложения. Один и тот же рендер
// используется и здесь, и в архиве переноса (service.go), поэтому «полный архив»
// и «md + ассеты» всегда описывают проект одинаково — различаются только имена
// файлов вложений и, значит, ссылки на них.
//
// Привязка «событие → вложения» лежит только в CRDT-снапшоте (в таблице events
// её нет, event_assets пустая), поэтому картинки берутся из
// collab.AssetBindings. Снапшот не разобрался — выгрузка продолжается без
// картинок: терять из-за этого весь текст нельзя.

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab"
	"github.com/skyfraze/backend/internal/events"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

// Имена внутри zip-архива выгрузки.
const (
	storyFileName = "story.md"
	storyDirName  = "story/"
	readmeName    = "README.txt"

	// imageMimePrefix — что считаем картинкой: только их печатаем в ленте
	// (`![номер·порядок](...)`), остальные вложения остаются в assets/ и манифесте.
	imageMimePrefix = "image/"
)

// MarkdownInfo — что получилось выгрузить (для заголовков ответа и тестов).
type MarkdownInfo struct {
	Title    string
	Filename string
	Events   int
	Assets   int
	Bytes    int64
}

// storyFrame — кадр истории в порядке таймлайна (pre-order, как на экране).
type storyFrame struct {
	Number string
	Depth  int
	Event  store.Event
	// Images — картинки события в порядке привязки (только image/*).
	Images []store.Asset
}

// story — подготовленная выгрузка: всё, что нужно для рендера, уже загружено и
// разложено. Отдельный тип, чтобы разметку можно было напечатать в разные
// приёмники (одна лента, файлы story/, вложение в архив переноса) из одних данных.
type story struct {
	Project     *store.Project
	Frames      []storyFrame
	Assets      []store.Asset
	AssetNumber map[uuid.UUID]int // id вложения → номер в архиве (1-based)
}

// newStory собирает кадры, номера и привязки вложений.
//
// Порядок обхода — events.BuildTree, то есть тот же, что у таймлайна: главы,
// внутри них под-события по position, внутри — под-шаги. Номер кадра считается
// от позиции в дереве (`01`, `01.1`, `01.1.1`) — ровно как chapterNumber/
// stepNumber в frontend/src/components/timeline/timelineModel.ts. Считать его от
// position в базе нельзя: тот же номер должен получиться и при импорте папки,
// где позиции другие.
func newStory(p *store.Project, evs []store.Event, assets []store.Asset, state []byte) *story {
	images := imageBindings(assets, state)

	st := &story{
		Project:     p,
		Assets:      assets,
		AssetNumber: make(map[uuid.UUID]int, len(assets)),
	}
	var walk func(nodes []events.TreeEvent, prefix string, depth int)
	walk = func(nodes []events.TreeEvent, prefix string, depth int) {
		for i := range nodes {
			number := strconv.Itoa(i + 1)
			if depth == 0 {
				// Номер главы двузначный: 01, 02 … 99 — так его показывает таймлайн.
				number = fmt.Sprintf("%02d", i+1)
			} else {
				number = prefix + "." + strconv.Itoa(i+1)
			}
			st.Frames = append(st.Frames, storyFrame{
				Number: number,
				Depth:  depth,
				Event:  nodes[i].Event,
				Images: images[nodes[i].ID],
			})
			walk(nodes[i].Children, number, depth+1)
		}
	}
	// Depth в корне принудительно 0: BuildTree поднимает сирот в корень, но
	// оставляет им прежнюю глубину — для заголовка ленты это было бы враньём.
	roots := events.BuildTree(evs)
	for i := range roots {
		roots[i].Depth = 0
	}
	walk(roots, "", 0)

	// Номера вложений: сначала те, что встречаются в ленте (по порядку чтения),
	// потом остальные — так в архиве видно, к чему относится файл.
	numbered := make(map[uuid.UUID]bool, len(assets))
	for i := range st.Frames {
		for _, a := range st.Frames[i].Images {
			if !numbered[a.ID] {
				numbered[a.ID] = true
				st.AssetNumber[a.ID] = len(st.AssetNumber) + 1
			}
		}
	}
	for _, a := range assets {
		if !numbered[a.ID] {
			numbered[a.ID] = true
			st.AssetNumber[a.ID] = len(st.AssetNumber) + 1
		}
	}
	return st
}

// imageBindings отбирает из привязок CRDT те вложения, что реально есть в
// проекте, и только картинки: остальные в ленте не показываются.
func imageBindings(assets []store.Asset, state []byte) map[uuid.UUID][]store.Asset {
	byID := make(map[uuid.UUID]store.Asset, len(assets))
	for _, a := range assets {
		byID[a.ID] = a
	}
	bindings, err := collab.AssetBindings(state)
	if err != nil || len(bindings) == 0 {
		return nil
	}
	out := make(map[uuid.UUID][]store.Asset, len(bindings))
	for eventID, ids := range bindings {
		for _, id := range ids {
			a, ok := byID[id]
			if !ok || !strings.HasPrefix(a.Mime, imageMimePrefix) {
				continue
			}
			out[eventID] = append(out[eventID], a)
		}
	}
	return out
}

// storyMarkdown печатает всю историю одной лентой. link задаёт, как подписать
// вложение (абсолютный /api/assets/<id> для одиночного файла или относительный
// путь внутри архива).
func (st *story) storyMarkdown(link func(store.Asset) string) []byte {
	var b strings.Builder
	b.WriteString("# " + oneLine(st.Project.Title) + "\n")
	if desc := strings.TrimSpace(st.Project.Description); desc != "" {
		b.WriteString(desc + "\n")
	}
	for _, f := range st.Frames {
		b.WriteString("\n")
		b.WriteString(storyComment(f))
		b.WriteString(strings.Repeat("#", headingLevel(f.Depth)) + " " + frameHeadline(f) + "\n")
		if body := strings.TrimRight(f.Event.Body, "\n"); body != "" {
			b.WriteString(body + "\n")
		}
		writeImageLines(&b, f, link)
	}
	return []byte(b.String())
}

// storyFile — один файл папки story/.
type storyFile struct {
	Name    string
	Content []byte
}

// storyFiles печатает по файлу на событие: имя `<номер>-<заголовок>.md`,
// внутри front-matter, машинный комментарий, H1 с номером и телом — ровно это и
// есть формат обратного импорта (docs/import-export.md, п. 2).
func (st *story) storyFiles(link func(store.Asset) string) []storyFile {
	out := make([]storyFile, 0, len(st.Frames))
	for _, f := range st.Frames {
		var b strings.Builder
		b.WriteString(yamlFrontMatter(f))
		b.WriteString(storyComment(f))
		b.WriteString("# " + frameHeadline(f) + "\n")
		if body := strings.TrimRight(f.Event.Body, "\n"); body != "" {
			b.WriteString(body + "\n")
		}
		writeImageLines(&b, f, link)
		out = append(out, storyFile{
			Name:    storyFilePath(f),
			Content: []byte(b.String()),
		})
	}
	return out
}

// storyFilePath — `<номер>-<заголовок>.md` для папки story/.
//
// Заголовок остаётся читаемым, в том числе кириллицей: файлы этой папки человек
// открывает и правит руками (и возвращает обратно импортом), поэтому латинский
// слаг из SlugifyFileName здесь не годится — «Сборка на орбитальной верфи
// „Прометей-7“» превращалась бы в «7», а глава «Запуск „Альфы“» — в «project».
// Запрещённые в файловых системах символы выкидываем, разделители — дефис.
func storyFilePath(f storyFrame) string {
	return storyDirName + f.Number + "-" + storyTitleSlug(f.Event.Title) + ".md"
}

// storyTitleSlug — заголовок, пригодный для имени файла: буквы и цифры любых
// алфавитов, остальное — дефис; пустой результат заменяется на «event».
func storyTitleSlug(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.TrimSpace(title) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			prevDash = false
		case r == ' ' || r == '-' || r == '_' || r == '.' || r == '·':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
		if b.Len() >= 60 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "event"
	}
	return out
}

// writeImageLines печатает картинки события сразу после его текста — как кадры
// картинок идут в таймлайне (сначала иллюстрации, потом вложенные события).
func writeImageLines(b *strings.Builder, f storyFrame, link func(store.Asset) string) {
	for i, a := range f.Images {
		b.WriteString("\n![")
		b.WriteString(f.Number)
		b.WriteString("·")
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString("](")
		b.WriteString(link(a))
		b.WriteString(")\n")
	}
}

// storyComment — машинная строка, по которой лента и папка сопоставляются
// однозначно (docs/import-export.md, п. 1.1).
func storyComment(f storyFrame) string {
	return fmt.Sprintf("<!-- skyfraze: number=%s id=%s kind=event -->\n", f.Number, f.Event.ID)
}

// yamlFrontMatter — необязательный блок front-matter в начале файла story/:
// `title` (точный заголовок события) и `date` (только если дата есть). Без него
// дата, поставленная в приложении, в файлах терялась бы — и круговой обмен
// «выгрузка → импорт» её не сохранял (импорт читает эти же поля, см.
// markdown_import.go). Нет ни заголовка, ни даты — нет и блока: пустой
// front-matter только засорил бы файл.
func yamlFrontMatter(f storyFrame) string {
	var b strings.Builder
	if title := oneLine(f.Event.Title); title != "" {
		b.WriteString("title: " + yamlScalar(title) + "\n")
	}
	if f.Event.EventDate != nil {
		b.WriteString("date: " + f.Event.EventDate.Format("2006-01-02") + "\n")
	}
	if b.Len() == 0 {
		return ""
	}
	return "---\n" + b.String() + "---\n\n"
}

// yamlScalar печатает значение front-matter: простым текстом, если это безопасно,
// иначе в двойных кавычках с экранированием `"` и `\`. Импорт разбирает плоские
// пары `ключ: значение` (frontMatterValue в markdown_import.go), но файлы читает
// ещё и человек с pandoc — значение обязано пережить и обычный YAML.
func yamlScalar(v string) string {
	if !yamlNeedsQuotes(v) {
		return v
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range v {
		if r == '"' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

// yamlNeedsQuotes — требует ли значение кавычек: пустое или с ведущими и
// замыкающими пробелами, с кавычками или обратным слэшем, с двоеточием или
// решёткой в начале и конце, с «опасной» парой (`: `, ` #`), а также
// начинающееся с индикатора YAML (`-`, `?`, `[`, `{`, `#` и им подобных).
// Всё это YAML прочитал бы иначе, чем мы записали.
func yamlNeedsQuotes(v string) bool {
	if v == "" || strings.TrimSpace(v) != v {
		return true
	}
	switch v[0] {
	case '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`':
		return true
	}
	if strings.ContainsAny(v, "\"'\\") {
		return true
	}
	if strings.HasSuffix(v, ":") {
		return true
	}
	return strings.Contains(v, ": ") || strings.Contains(v, " #") || strings.HasSuffix(v, "#")
}

// frameHeadline — «01.1 Сборка на орбитальной верфи»: номер кадра плюс заголовок.
func frameHeadline(f storyFrame) string {
	if title := oneLine(f.Event.Title); title != "" {
		return f.Number + " " + title
	}
	return f.Number
}

// headingLevel — уровень заголовка по глубине: глава `##`, под-событие `###`,
// под-шаг `####`; глубже шести уровней markdown не умеет.
func headingLevel(depth int) int {
	level := 2 + depth
	if level > 6 {
		level = 6
	}
	return level
}

// oneLine защищает разметку от перевода строки в заголовке: иначе заголовок
// проекта или события разорвал бы структуру документа.
func oneLine(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\r", " ")
	return strings.ReplaceAll(s, "\n", " ")
}

// ---------- выгрузка ----------

// ExportMarkdown отдаёт всю историю одной лентой Markdown. Права — viewer+, как
// у архива переноса и у чтения проекта: читатель и так видит всё содержимое, и
// второй уровень доступа к тому же контенту только путал бы.
func (s *Service) ExportMarkdown(
	ctx context.Context, userID, projectID uuid.UUID, w io.Writer,
) (*MarkdownInfo, error) {
	st, err := s.loadStory(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	data := st.storyMarkdown(func(a store.Asset) string { return assetAPIPath(a) })
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	return &MarkdownInfo{
		Title:    st.Project.Title,
		Filename: SlugifyFileName(st.Project.Title) + ".md",
		Events:   len(st.Frames),
		Assets:   len(st.Assets),
		Bytes:    int64(len(data)),
	}, nil
}

// ExportMarkdownZip отдаёт zip со story.md, папкой story/, вложениями и
// манифестом переноса. Состав ровно такой, как описано в docs/import-export.md:
// манифест — тот же (формат skyfraze-project, версия 1), поэтому архив годится и
// для «Импорта проекта» на другом стенде. Снапшот CRDT сюда НЕ кладём: в
// манифесте has_state=false, иначе получился бы манифест, обещающий state.bin.
func (s *Service) ExportMarkdownZip(
	ctx context.Context, userID, projectID uuid.UUID, w io.Writer,
) (*MarkdownInfo, error) {
	st, err := s.loadStory(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	// Файлы папки story/ лежат на уровень глубже, поэтому их ссылки начинаются с
	// `../`, а лента story.md ссылается на assets/ напрямую.
	laneLink := func(a store.Asset) string { return st.archiveAssetFile(a) }
	fileLink := func(a store.Asset) string { return "../" + st.archiveAssetFile(a) }

	counter := &countingWriter{w: w}
	zw := zip.NewWriter(counter)
	if err := writeZipFile(zw, storyFileName, st.storyMarkdown(laneLink)); err != nil {
		return nil, err
	}
	for _, f := range st.storyFiles(fileLink) {
		if err := writeZipFile(zw, f.Name, f.Content); err != nil {
			return nil, err
		}
	}
	for _, a := range st.Assets {
		rc, err := s.obj.Get(ctx, a.S3Key)
		if err != nil {
			// Файла нет в хранилище — не роняем всю выгрузку: остальное
			// содержимое проекта важнее одного потерянного вложения.
			continue
		}
		err = writeZipStream(zw, st.archiveAssetFile(a), rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := writeZipFile(zw, manifestName, st.markdownManifest()); err != nil {
		return nil, err
	}
	if err := writeZipFile(zw, readmeName, []byte(st.readme())); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return &MarkdownInfo{
		Title:    st.Project.Title,
		Filename: SlugifyFileName(st.Project.Title) + "-md.zip",
		Events:   len(st.Frames),
		Assets:   len(st.Assets),
		Bytes:    counter.n,
	}, nil
}

// loadStory — общая загрузка для выгрузок: права (viewer+, как и у чтения
// проекта: читатель и так видит всё содержимое, поэтому доступ ему не
// расширяется), проект, дерево, вложения, CRDT-снапшот.
func (s *Service) loadStory(ctx context.Context, userID, projectID uuid.UUID) (*story, error) {
	if err := s.proj.RequireViewer(ctx, userID, projectID); err != nil {
		if errors.Is(err, projects.ErrForbidden) {
			return nil, ErrForbidden
		}
		return nil, err
	}
	p, err := s.store.GetProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	evs, err := s.store.ListEvents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	assets, err := s.store.ListAssets(ctx, projectID)
	if err != nil {
		return nil, err
	}
	state, err := s.store.GetProjectEventState(ctx, projectID)
	if err != nil {
		return nil, err
	}
	var raw []byte
	if state != nil {
		raw = state.YjsState
	}
	return newStory(p, evs, assets, raw), nil
}

// assetAPIPath — картинка в обычном экспорте: абсолютный путь приложения, файл
// открывается и в браузере, и в редакторе с доступом к стенду.
func assetAPIPath(a store.Asset) string {
	return "/api/assets/" + a.ID.String()
}

// archiveAssetFile — путь вложения ВНУТРИ архива выгрузки: assets/<NN>-<имя>.
// Номер в имени нужен, чтобы два вложения с одинаковым именем файла не
// столкнулись; сам номер — порядок появления в ленте (см. newStory).
func (st *story) archiveAssetFile(a store.Asset) string {
	return assetsDir + archiveAssetName(st.AssetNumber[a.ID], a.Filename)
}

// archiveAssetName — «03-верфь.png».
func archiveAssetName(number int, filename string) string {
	return fmt.Sprintf("%02d-%s", number, safeFileName(filename))
}

// safeFileName приводит имя вложения к безопасному имени файла: убирает пути и
// управляющие символы (в имени из загрузки может оказаться что угодно), режет
// длину и не даёт пустого имени.
func safeFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f:
			continue
		case strings.ContainsRune(`/\:*?"<>|`, r):
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), ". ")
	if out == "" {
		return "file"
	}
	if runes := []rune(out); len(runes) > 80 {
		out = string(runes[:80])
	}
	return out
}

// markdownManifest собирает манифест переноса для zip-выгрузки Markdown: тот же
// формат и версия, что у архива переноса, но file у вложения указывает на
// реально лежащий в архиве файл assets/<NN>-<имя> — иначе «Импорт проекта» не
// нашёл бы файлы, а сам архив перестал бы быть архивом переноса.
func (st *story) markdownManifest() []byte {
	m := Manifest{
		Format:     FormatName,
		Version:    FormatVersion,
		ExportedAt: time.Now().UTC(),
		App:        "SkyFraze",
		Project:    ProjectMeta{Title: st.Project.Title, Description: st.Project.Description},
		Events:     make([]EventRecord, 0, len(st.Frames)),
		Assets:     make([]AssetRecord, 0, len(st.Assets)),
		HasState:   false, // state.bin в этот архив не кладём — и не обещаем
	}
	for _, f := range st.Frames {
		e := f.Event
		m.Events = append(m.Events, EventRecord{
			ID: e.ID, ParentID: e.ParentID, Position: e.Position, Depth: e.Depth,
			Title: e.Title, Body: e.Body, EventDate: e.EventDate,
		})
	}
	for _, a := range st.Assets {
		m.Assets = append(m.Assets, AssetRecord{
			ID: a.ID, Filename: a.Filename, Mime: a.Mime, Size: a.Size, Kind: a.Kind,
			Width: a.Width, Height: a.Height, File: st.archiveAssetFile(a),
		})
	}
	// Ошибка маршалинга на этой структуре невозможна (только строки и числа),
	// но пустой объект вместо манифеста был бы хуже падения: импорт сказал бы
	// «это не архив SkyFraze» и не объяснил причину.
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return []byte("{}")
	}
	return data
}

// readme — короткая инструкция к архиву: человек открывает zip и должен понять,
// что с ним делать, не заглядывая в репозиторий. Держим 5-10 строк.
func (st *story) readme() string {
	var b strings.Builder
	b.WriteString("SkyFraze — история проекта «" + oneLine(st.Project.Title) + "»\n\n")
	b.WriteString("- story.md — вся история одной лентой: читать, печатать, отдавать в pandoc.\n")
	b.WriteString("- story/ — по файлу на событие; это же формат обратного импорта (POST /api/projects/import/markdown).\n")
	b.WriteString("- assets/ — вложения проекта, в именах файлов порядковый номер.\n")
	b.WriteString("- manifest.json — манифест переноса (формат skyfraze-project, версия 1): этот же архив\n")
	b.WriteString("  принимает «Импорт проекта» на другом стенде SkyFraze.\n")
	b.WriteString("- ссылки на картинки в story.md и story/ относительные: папку можно открыть где угодно.\n")
	return b.String()
}

// archiveStoryFiles готовит story.md и story/ для архива ПЕРЕНОСА, где вложения
// лежат под своими id (assets/<id>), а не под номерами: манифест и раскладку
// этого архива менять нельзя — старые версии SkyFraze читают файлы по полю file,
// а «полный архив» уже раздавали пользователям. Лента та же самая, отличаются
// только ссылки.
func (st *story) archiveStoryFiles() ([]byte, []storyFile) {
	lane := st.storyMarkdown(func(a store.Asset) string { return assetsDir + a.ID.String() })
	// Из story/*.md ссылка ведёт на уровень выше: ../assets/<id>.
	files := st.storyFiles(func(a store.Asset) string { return "../" + assetsDir + a.ID.String() })
	return lane, files
}
