package assistant

// docx_markers.go — маркеры DOCX глазами помощника (0.92.0, docs/docx-template.md §3).
//
// Помощник правит текст целиком, поэтому испортить маркер ему ничего не стоит: строка
// `<!-- sf:style=Эпиграф -->`, приклеенная к абзацу, перестаёт быть маркером, и при выгрузке
// человек молча теряет оформление. Поэтому текст от модели проверяется ДО того, как стать
// кадром: ошибка возвращается модели как ошибка инструмента, с перечнем того, что допустимо.
//
// Проверяется только синтаксис. Имена стилей зависят от шаблона проекта и приходят модели в
// правилах — сервер их здесь не сверяет: шаблон можно сменить между вопросом и подтверждением,
// и отказ «стиль не из шаблона» был бы отказом за то, чего модель не выбирала.

import (
	"fmt"
	"strings"
)

// Разметка маркера в тексте.
const (
	docxMarkerOpen  = "<!-- sf:"
	docxMarkerClose = "-->"
)

// docxMarkerCommands — что вообще допустимо; тот же список, что в правилах и в интерфейсе.
var docxMarkerCommands = []string{"pagebreak", "toc", "style=Имя стиля", "begin=Имя стиля", "end"}

// checkDocxMarkers проверяет строки-маркеры в тексте от модели.
//
// Правила простые и проверяются буквально:
//   - маркер обязан занимать строку ЦЕЛИКОМ (иначе он останется обычным текстом и попадёт в
//     показ как комментарий);
//   - команда обязана быть из словаря;
//   - внутри ``` и ~~~ маркеры не проверяются: это код, и там они не работают намеренно.
func checkDocxMarkers(body string) error {
	if !strings.Contains(body, docxMarkerOpen) {
		return nil
	}
	fence := ""
	for index, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trimmed, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = trimmed[:3]
			continue
		}
		if !strings.Contains(trimmed, docxMarkerOpen) {
			continue
		}
		if !strings.HasPrefix(trimmed, docxMarkerOpen) || !strings.HasSuffix(trimmed, docxMarkerClose) {
			return fmt.Errorf("строка %d: маркер DOCX должен занимать строку целиком, "+
				"например `<!-- sf:pagebreak -->` отдельной строкой", index+1)
		}
		command := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, docxMarkerOpen), docxMarkerClose))
		if !docxMarkerKnown(command) {
			return fmt.Errorf("строка %d: неизвестный маркер `%s`. Допустимо: %s", index+1, trimmed,
				strings.Join(docxMarkerCommands, ", "))
		}
	}
	return nil
}

// docxMarkerKnown — команда из словаря (с непустым именем стиля после `=`).
func docxMarkerKnown(command string) bool {
	switch command {
	case "pagebreak", "toc", "end":
		return true
	}
	for _, prefix := range []string{"style=", "begin="} {
		if rest, ok := strings.CutPrefix(command, prefix); ok {
			return strings.TrimSpace(rest) != ""
		}
	}
	return false
}

// docxMarkupBlock — что модель должна знать про маркеры. Отдельным блоком правил, а не строкой в
// диалоге: маркеры нужны редко, но если модель про них не знает, она на просьбу «пусть глава
// начинается с нового листа» начнёт выдумывать markdown-разделитель, который ничего не делает.
//
// `styles` — стили абзаца действующего шаблона (пусто — шаблона нет). Тогда `style=`/`begin=`
// модели не предлагаются: имя, которого нет в шаблоне, в Word не применится, и человек увидит
// нулевой эффект при видимой ошибке в тексте.
func docxMarkupBlock(styles []string) string {
	var b strings.Builder
	b.WriteString("\n\nРазметка DOCX. В тексте кадра можно ставить служебные строки — их понимает только\n")
	b.WriteString("скачивание в .docx, в показе проекта их не видно:\n")
	b.WriteString("<!-- sf:pagebreak --> — начать новый лист\n")
	b.WriteString("<!-- sf:toc --> — поле оглавления Word\n")
	if len(styles) > 0 {
		b.WriteString("<!-- sf:style=Имя --> — текст ниже (до следующего маркера) оформить этим стилем шаблона\n")
		b.WriteString("<!-- sf:begin=Имя --> … <!-- sf:end --> — кусок этим стилем\n")
		fmt.Fprintf(&b, "Стили шаблона в этом проекте: %s.\n", strings.Join(styles, ", "))
	} else {
		b.WriteString("Стилей шаблона в этом проекте нет: style= и begin= не используй.\n")
	}
	b.WriteString("Маркер занимает строку целиком; внутри блоков кода он не работает.\n")
	b.WriteString("Если в тексте кадра уже есть такие строки, сохраняй их на месте, пока правка не\n")
	b.WriteString("просит обратного. Без просьбы автора маркеры не добавляй.")
	return b.String()
}
