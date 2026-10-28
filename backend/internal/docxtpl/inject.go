package docxtpl

// inject.go — вставка содержимого проекта в пакет шаблона (0.91.0, docs/docx-template.md).
//
// Почему так, а не «взять из шаблона шрифт»: автору нужен СВОЙ документ — с титулом, колонтитулами,
// полями, нумерацией страниц и стилями. Поэтому пакет шаблона остаётся основой: находим абзац
// {{content}}, вырезаем его и вставляем на это место тело проекта. Всё остальное (титул, разделы,
// темы, стили, связи) копируется байт-в-байт.
//
// Трогаем только: `word/document.xml` (тело), связи документа (картинки) и `[Content_Types].xml`
// (расширения картинок). Остальные части обязаны остаться как были — иначе Word не откроет файл.

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// ErrNoPlaceholder — в шаблоне нет абзаца {{content}}: вставлять некуда, вызывающий решает,
// собирать ли документ встроенным оформлением.
var ErrNoPlaceholder = errors.New("в шаблоне нет абзаца {{content}}")

// Media — картинка для вставки: имя внутри пакета (`media/07.png`) и байты.
type Media struct {
	// Name — желаемое имя части (`media/07.png`). Если такое уже есть в шаблоне, имя получит
	// префикс `sf-`; на идентификатор связи это не влияет (тело ссылается только на RelID).
	Name string
	Data []byte
	Mime string
	// RelID — идентификатор связи, который уже использован в теле (`r:embed="rIdN"`).
	// Пусто — назначим сами (уникальный). Вызывающий берёт стартовое значение из
	// NextRelationshipID, чтобы не занять чужой rId шаблона.
	RelID string
}

// InjectOptions — что вставить в шаблон.
type InjectOptions struct {
	// ContentXML — готовое тело: параграфы в разметке WordprocessingML.
	ContentXML string
	// LinkContent — тело с ПЛЕЙСХОЛДЕРАМИ имён картинок: `{{sf-image:Name}}` заменяется на
	// идентификатор связи, выданный при вставке. Так вызывающий строит тело один раз, а связи
	// получает здесь (в шаблоне rId уже заняты стилями, колонтитулами и титульными картинками).
	Media []Media
}

// Result — собранный пакет и выданные связи.
type Result struct {
	Data []byte
	// RelIDs — имя части картинки (`media/07.png`) → идентификатор связи (`rId12`).
	RelIDs map[string]string
}

// Inject собирает новый пакет: шаблон + тело проекта на месте плейсхолдера.
func Inject(raw []byte, opts InjectOptions) (*Result, error) {
	if len(raw) == 0 {
		return nil, ErrBadTemplate
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadTemplate, err)
	}

	type part struct {
		file *zip.File
		data []byte
	}
	parts := make([]part, 0, len(zr.File))
	byName := make(map[string][]byte, len(zr.File))
	for _, file := range zr.File {
		if file.FileInfo().IsDir() {
			continue
		}
		switch file.Name {
		case "word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml":
			data, readErr := readPart(file)
			if readErr != nil {
				return nil, readErr
			}
			parts = append(parts, part{file: file, data: data})
			byName[file.Name] = data
		default:
			// Остальные части не читаем в память: они переливаются в новый пакет потоком.
			parts = append(parts, part{file: file})
		}
	}

	document := string(byName["word/document.xml"])
	if document == "" {
		return nil, fmt.Errorf("%w: нет word/document.xml", ErrBadTemplate)
	}
	index := strings.Index(document, PlaceholderText)
	if index < 0 {
		return nil, ErrNoPlaceholder
	}
	start := paragraphStart(document, index)
	end := strings.Index(document[index:], "</w:p>")
	if start < 0 || end < 0 {
		return nil, ErrNoPlaceholder
	}

	// Связи картинок. В шаблоне rId уже заняты стилями, колонтитулами, титульными картинками —
	// «занять rIdN» вслепую значит сломать чужую связь.
	rels := string(byName["word/_rels/document.xml.rels"])
	if rels == "" {
		rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
	}
	nextRID := maxRelationshipID(rels) + 1
	addedRels := strings.Builder{}
	usedNames := map[string]bool{}
	for name := range byName {
		usedNames[name] = true
	}
	result := &Result{RelIDs: map[string]string{}}
	added := make([]Media, 0, len(opts.Media))
	for _, media := range opts.Media {
		if len(media.Data) == 0 {
			continue
		}
		name := media.Name
		if usedNames[name] {
			base := path.Base(media.Name)
			name = "media/sf-" + base
			for i := 2; usedNames[name]; i++ {
				name = fmt.Sprintf("media/sf-%d-%s", i, base)
			}
		}
		usedNames[name] = true
		relID := media.RelID
		if relID == "" {
			relID = fmt.Sprintf("rId%d", nextRID)
			nextRID++
		} else if parsed := strings.TrimPrefix(relID, "rId"); atoiOrZero(parsed) >= nextRID {
			// Заняли выданный вызывающим номер — следующий автоматический должен быть выше.
			nextRID = atoiOrZero(parsed) + 1
		}
		result.RelIDs[media.Name] = relID
		result.RelIDs[name] = relID
		fmt.Fprintf(&addedRels, `<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="%s"/>`,
			relID, name)
		added = append(added, Media{Name: name, Data: media.Data, Mime: media.Mime, RelID: relID})
	}

	// Тело: вырезаем абзац-плейсхолдер и ставим на его место содержимое проекта.
	document = document[:start] + opts.ContentXML + document[index+end+len("</w:p>"):]
	byName["word/document.xml"] = []byte(document)

	if len(added) > 0 {
		rels = strings.Replace(rels, "</Relationships>", addedRels.String()+"</Relationships>", 1)
		byName["word/_rels/document.xml.rels"] = []byte(rels)
	}

	// Типы содержимого: расширения картинок обязаны быть объявлены, иначе Word не откроет файл.
	contentTypes := string(byName["[Content_Types].xml"])
	if contentTypes == "" {
		return nil, fmt.Errorf("%w: нет [Content_Types].xml", ErrBadTemplate)
	}
	additions := strings.Builder{}
	for _, media := range added {
		ext := strings.TrimPrefix(strings.ToLower(path.Ext(media.Name)), ".")
		if ext == "" || strings.Contains(contentTypes, `Extension="`+ext+`"`) {
			continue
		}
		mime := media.Mime
		if mime == "" {
			mime = imageMimeFor(ext)
		}
		fmt.Fprintf(&additions, `<Default Extension="%s" ContentType="%s"/>`, ext, mime)
	}
	if additions.Len() > 0 {
		contentTypes = strings.Replace(contentTypes, "</Types>", additions.String()+"</Types>", 1)
	}
	byName["[Content_Types].xml"] = []byte(contentTypes)

	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, item := range parts {
		if data, ok := byName[item.file.Name]; ok {
			if err := writeZipFile(zw, item.file.Name, data); err != nil {
				return nil, err
			}
			delete(byName, item.file.Name)
			continue
		}
		if err := copyZipFile(zw, item.file); err != nil {
			return nil, err
		}
	}
	for _, media := range added {
		// Связь Target в document.xml.rels отсчитывается от папки word/, а сама часть лежит как
		// word/media/... — поэтому к имени добавляем префикс word/.
		entry := "word/" + strings.TrimPrefix(media.Name, "word/")
		if err := writeZipFile(zw, entry, media.Data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	result.Data = out.Bytes()
	return result, nil
}

func writeZipFile(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func copyZipFile(zw *zip.Writer, file *zip.File) error {
	rc, err := file.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	w, err := zw.CreateHeader(&zip.FileHeader{Name: file.Name, Method: file.Method, Modified: file.Modified})
	if err != nil {
		return err
	}
	_, err = io.Copy(w, rc)
	return err
}

// NextRelationshipID — свободный номер связи в шаблоне (для картинок тела).
//
// Нужен вызывающему ДО сборки тела: тело ссылается на картинки по rId, и номер надо знать, пока
// строится XML. Шаблон был проверен при загрузке, но если его заменили в обход (или испортили),
// возвращаем 100 — безопасный запас, при котором Word откроет файл даже с «лишними» связями.
func NextRelationshipID(raw []byte) int {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return 100
	}
	for _, file := range zr.File {
		if file.Name != "word/_rels/document.xml.rels" {
			continue
		}
		data, readErr := readPart(file)
		if readErr != nil {
			return 100
		}
		return maxRelationshipID(string(data)) + 1
	}
	return 1
}

// maxRelationshipID ищет максимальный rIdN в связях, чтобы не занять чужой.
func maxRelationshipID(rels string) int {
	max := 0
	rest := rels
	for {
		idx := strings.Index(rest, `Id="rId`)
		if idx < 0 {
			return max
		}
		rest = rest[idx+len(`Id="rId`):]
		end := strings.Index(rest, `"`)
		if end < 0 {
			return max
		}
		if value := atoiOrZero(rest[:end]); value > max {
			max = value
		}
		rest = rest[end:]
	}
}

// imageMimeFor — MIME по расширению (в DOCX картинки опознаются по расширению части).
func imageMimeFor(ext string) string {
	switch ext {
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "svg":
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}
