package transfer

// export_epub.go — выгрузка проекта в EPUB 3.
//
// Зачем. Результат работы над проектом — книга, а получить её файлом, который открывается
// в читалке и на телефоне, было нечем: выгрузка отдавала только ZIP с Markdown (он нужен
// для переноса между стендами, а не для чтения). EPUB — это zip с XHTML и OPF, то есть ни
// новой базы, ни внешних сервисов.
//
// Структура файла: главы верхнего уровня — отдельные XHTML-документы (по одному на главу),
// под-события — разделы внутри главы со своими <h2>/<h3> и якорями. Оглавление (nav.xhtml)
// повторяет дерево проекта, поэтому в читалке видно ту же иерархию, что в таймлайне.
//
// Что важно в реализации:
//
//   - запись `mimetype` обязана идти ПЕРВОЙ и БЕЗ сжатия (требование спецификации EPUB;
//     на этом ломаются самодельные сборщики, и файл открывается не во всех читалках);
//   - текст кадра — пользовательский ввод, поэтому в XHTML он попадает только
//     экранированным (см. markdown_html.go);
//   - картинка, которой нет в хранилище, не роняет выгрузку: глава остаётся, а картинка
//     пропускается — файл книги важнее одного потерянного вложения.

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"html"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

// epubMediaType — MIME тип книги.
const epubFileMime = "application/epub+zip"

// epubChapter — глава верхнего уровня со своими разделами.
type epubChapter struct {
	// File — имя файла внутри OEBPS/text (без префикса архива).
	File string
	// Title — заголовок главы (номер + название).
	Title string
	// Frames — кадры главы в порядке чтения: сама глава и её под-события.
	Frames []storyFrame
}

// epubImage — картинка, которую нужно положить в книгу.
type epubImage struct {
	// Path — путь внутри OEBPS (images/…).
	Path      string
	MediaType string
	Asset     store.Asset
	// Cover — обложка книги: первая картинка в порядке чтения. Читалки показывают её в
	// библиотеке, и без этого свойства EPUB выглядит безымянным прямоугольником.
	Cover bool
}

// ExportEPUB собирает книгу и пишет её в w.
func (s *Service) ExportEPUB(
	ctx context.Context, userID, projectID uuid.UUID, w io.Writer,
) (*MarkdownInfo, error) {
	st, err := s.loadStory(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}

	chapters := epubChapters(st)
	// Картинки глав: по одной на вложение, путь — images/<номер>.<ext>.
	images := make([]epubImage, 0, len(st.Assets))
	imagePath := make(map[uuid.UUID]string, len(st.Assets))
	for _, frame := range st.Frames {
		for _, a := range frame.Images {
			if _, ok := imagePath[a.ID]; ok {
				continue
			}
			path := "images/" + fmt.Sprintf("%02d", st.AssetNumber[a.ID]) + "." + mimeExtension(a.Mime)
			imagePath[a.ID] = path
			images = append(images, epubImage{
				Path: path, MediaType: a.Mime, Asset: a,
				// Обложка — первая картинка книги: у проекта это обычно иллюстрация первой
				// главы. Отдельного поля «обложка» пока нет (см. docs/import-export.md).
				Cover: len(images) == 0,
			})
		}
	}

	modified := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	title := oneLine(st.Project.Title)
	if title == "" {
		title = "Без названия"
	}

	counter := &countingWriter{w: w}
	zw := zip.NewWriter(counter)

	// 1. mimetype — первым и без сжатия.
	if err := writeZipStored(zw, "mimetype", []byte(epubFileMime)); err != nil {
		return nil, err
	}
	// 2. Контейнер: где лежит OPF.
	container := `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
	if err := writeZipFile(zw, "META-INF/container.xml", []byte(container)); err != nil {
		return nil, err
	}
	// 3. Стили: обычная книжная типографика, без внешних шрифтов.
	if err := writeZipFile(zw, "OEBPS/style.css", []byte(epubStyle)); err != nil {
		return nil, err
	}
	// 4. Оглавление.
	nav := epubNav(title, chapters)
	if err := writeZipFile(zw, "OEBPS/nav.xhtml", []byte(nav)); err != nil {
		return nil, err
	}
	// 5. Главы.
	for _, chapter := range chapters {
		page := epubChapterXHTML(st, chapter, imagePath)
		if err := writeZipFile(zw, "OEBPS/"+chapter.File, []byte(page)); err != nil {
			return nil, err
		}
	}
	// 6. Картинки — через хранилище: файла может не быть, и это не повод терять книгу.
	for _, image := range images {
		rc, err := s.obj.Get(ctx, image.Asset.S3Key)
		if err != nil {
			continue
		}
		var buf bytes.Buffer
		_, copyErr := io.Copy(&buf, rc)
		_ = rc.Close()
		if copyErr != nil {
			continue
		}
		if err := writeZipFile(zw, "OEBPS/"+image.Path, buf.Bytes()); err != nil {
			return nil, err
		}
	}
	// 7. Манифест книги — последним: он описывает всё, что уже добавлено.
	opf := epubOPF(title, modified, projectID, chapters, images)
	if err := writeZipFile(zw, "OEBPS/content.opf", []byte(opf)); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return &MarkdownInfo{
		Title:    title,
		Filename: bookFilename(st.Project.Title, ".epub"),
		Events:   len(st.Frames),
		Assets:   len(images),
		Bytes:    counter.n,
	}, nil
}

// bookFilename — имя скачанной книги: название проекта, пригодное для файла.
//
// SlugifyFileName здесь не годится: он латинский, и кириллическое название превращалось бы
// в «project.epub» — у всех книг одинаково. Имя файла читает человек, поэтому буквы любого
// алфавита сохраняются (как в storyTitleSlug для файлов папки story/).
func bookFilename(title, extension string) string {
	slug := storyTitleSlug(title)
	if slug == "event" {
		// storyTitleSlug подставляет «event» для пустого заголовка; для файла книги это
		// значение бессмысленно.
		slug = "book"
	}
	return slug + extension
}

// epubChapters группирует кадры по главам верхнего уровня.
//
// Кадры у story уже в порядке чтения и с глубиной, поэтому глава — это кадр с depth==0,
// а всё, что идёт за ним до следующей главы, — её разделы.
func epubChapters(st *story) []epubChapter {
	chapters := make([]epubChapter, 0, len(st.Frames))
	for _, frame := range st.Frames {
		if frame.Depth == 0 {
			chapters = append(chapters, epubChapter{
				File:   fmt.Sprintf("text/chapter-%02d.xhtml", len(chapters)+1),
				Title:  frameHeadline(frame),
				Frames: []storyFrame{frame},
			})
			continue
		}
		if len(chapters) == 0 {
			// Под-событие без главы (сирота): BuildTree поднял бы его в корень, но если
			// оно всё же пришло с глубиной > 0, кладём его в первую главу, а не теряем.
			chapters = append(chapters, epubChapter{
				File:   "text/chapter-01.xhtml",
				Title:  "Без главы",
				Frames: []storyFrame{},
			})
		}
		last := &chapters[len(chapters)-1]
		last.Frames = append(last.Frames, frame)
	}
	return chapters
}

// epubNav печатает оглавление книги.
func epubNav(title string, chapters []epubChapter) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ru" lang="ru">
<head><title>Оглавление</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Оглавление</h1>
<ol>
`)
	for _, chapter := range chapters {
		fmt.Fprintf(&b, `<li><a href="%s">%s</a>`, chapter.File, escapeXML(chapter.Title))
		if len(chapter.Frames) > 1 {
			b.WriteString("\n<ol>\n")
			for _, frame := range chapter.Frames[1:] {
				fmt.Fprintf(&b, `<li><a href="%s#f-%s">%s</a></li>`+"\n",
					chapter.File, frame.Event.ID, escapeXML(frameHeadline(frame)))
			}
			b.WriteString("</ol>\n")
		}
		b.WriteString("</li>\n")
	}
	b.WriteString(`</ol>
</nav>
</body>
</html>
`)
	return b.String()
}

// epubChapterXHTML печатает одну главу книги.
func epubChapterXHTML(st *story, chapter epubChapter, imagePath map[uuid.UUID]string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru" lang="ru">
<head><title>`)
	b.WriteString(escapeXML(chapter.Title))
	b.WriteString(`</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
`)
	for i, frame := range chapter.Frames {
		fmt.Fprintf(&b, `<section id="f-%s">`, frame.Event.ID)
		level := 1 + frame.Depth
		if level > 3 {
			level = 3
		}
		if level == 1 {
			fmt.Fprintf(&b, "<h1>%s</h1>", escapeXML(frameHeadline(frame)))
		} else {
			fmt.Fprintf(&b, "<h%d>%s</h%d>", level, escapeXML(frameHeadline(frame)), level)
		}
		if frame.Event.EventDate != nil {
			fmt.Fprintf(&b, `<p class="date">%s</p>`, frame.Event.EventDate.Format("2 January 2006"))
		}
		for _, a := range frame.Images {
			path, ok := imagePath[a.ID]
			if !ok {
				continue
			}
			// Картинок в кадре может быть несколько: они идут перед текстом, как на стадии.
			fmt.Fprintf(&b, `<figure><img src="../%s" alt="%s"/></figure>`+"\n",
				path, escapeXML(frame.Number))
		}
		if body := strings.TrimSpace(frame.Event.Body); body != "" {
			// Маркеры DOCX (0.92.0) книга не умеет: разрыв страницы и оглавление в EPUB
			// задаются самой книгой, а «стиль шаблона» — понятие Word. Убираем строки-маркеры,
			// чтобы служебные комментарии не попали читателю в текст.
			b.WriteString(blocksXHTML(parseMarkdown(stripDocxMarkers(body))))
		}
		if i == 0 && st.Project.Description != "" && chapter.Frames[0].Event.ID == frame.Event.ID &&
			len(chapter.Frames) == 1 {
			// Описание проекта в первой главе — только если глава одна: иначе оно
			// повторялось бы в каждой главе или висело бы не там.
			b.WriteString("<p class=\"note\">")
			b.WriteString(inlineXHTML(oneLine(st.Project.Description)))
			b.WriteString("</p>\n")
		}
		b.WriteString("</section>\n")
	}
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

// epubOPF печатает манифест книги.
func epubOPF(
	title, modified string, projectID uuid.UUID, chapters []epubChapter, images []epubImage,
) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ru">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
`)
	fmt.Fprintf(&b, "    <dc:identifier id=\"bookid\">urn:uuid:%s</dc:identifier>\n", projectID)
	fmt.Fprintf(&b, "    <dc:title>%s</dc:title>\n", escapeXML(title))
	b.WriteString("    <dc:language>ru</dc:language>\n")
	fmt.Fprintf(&b, "    <dc:creator>%s</dc:creator>\n", escapeXML("SkyFraze"))
	fmt.Fprintf(&b, "    <meta property=\"dcterms:modified\">%s</meta>\n", modified)
	b.WriteString(`  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
`)
	for i, chapter := range chapters {
		fmt.Fprintf(&b, "    <item id=\"c%d\" href=\"%s\" media-type=\"application/xhtml+xml\"/>\n",
			i+1, chapter.File)
	}
	for i, image := range images {
		// `cover-image` говорит читалке, что это обложка: без свойства книга в
		// библиотеке показывается серым прямоугольником с названием.
		properties := ""
		if image.Cover {
			properties = ` properties="cover-image"`
		}
		fmt.Fprintf(&b, "    <item id=\"i%d\" href=\"%s\" media-type=\"%s\"%s/>\n",
			i+1, image.Path, escapeXML(image.MediaType), properties)
	}
	b.WriteString("  </manifest>\n  <spine>\n")
	for i := range chapters {
		fmt.Fprintf(&b, "    <itemref idref=\"c%d\"/>\n", i+1)
	}
	b.WriteString(`  </spine>
</package>
`)
	return b.String()
}

// writeZipStored кладёт файл в архив БЕЗ сжатия: так требует EPUB для `mimetype`
// (первая запись, без сжатия — иначе часть читалок файл не открывает).
func writeZipStored(zw *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetMode(0644)
	w, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// mimeExtension — расширение по MIME картинки: имя файла внутри книги должно
// соответствовать содержимому, иначе читалка не покажет картинку.
func mimeExtension(mime string) string {
	switch strings.ToLower(mime) {
	case "image/png":
		return "png"
	case "image/jpeg", "image/jpg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "image/svg+xml":
		return "svg"
	default:
		return "img"
	}
}

// escapeXML экранирует текст для XHTML/OPF: текст кадра и заголовки — пользовательский
// ввод, и «<» в нём должен остаться «<».
func escapeXML(text string) string { return html.EscapeString(text) }

// epubStyle — оформление книги: читаемая типографика без внешних шрифтов.
const epubStyle = `body { font-family: serif; line-height: 1.5; margin: 0 1em; }
h1 { font-size: 1.5em; margin: 1.2em 0 0.4em; page-break-before: always; }
h2 { font-size: 1.2em; margin: 1em 0 0.3em; }
h3 { font-size: 1.05em; margin: 0.9em 0 0.2em; }
p { margin: 0 0 0.7em; text-align: justify; }
p.date, p.note { color: #555; font-size: 0.9em; }
blockquote { margin: 0.8em 0 0.8em 1em; color: #333; }
pre { white-space: pre-wrap; font-size: 0.9em; background: #f4f4f4; padding: 0.5em; }
figure { margin: 0.8em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 0.8em 0; }
th, td { border: 1px solid #bbb; padding: 0.2em 0.4em; text-align: left; }
li.nested { margin-left: 1em; }
`
