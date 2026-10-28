package transfer_test

// docx_markers_span_test.go — правка ФРАГМЕНТА не съедает маркеры DOCX (0.93.1).
//
// Маркеры (`<!-- sf:pagebreak -->`, `<!-- sf:toc -->`) живут отдельными строками текста кадра.
// Помощник правит фрагмент диапазоном (`ReplaceSpanChecked`) — и это единственный путь правки,
// который мог бы их задеть: переписать одно слово и «прихватить» соседнюю строку-маркер.
// Проверяем, что после такой правки маркеры на месте и остаются отдельными строками, иначе
// скачивание в DOCX молча потеряло бы разрыв страницы и оглавление.

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
)

func TestReplaceSpanKeepsDocxMarkers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Книга с разметкой", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}

	chapter := uuid.New()
	body := "<!-- sf:pagebreak -->\n\nАнна вошла в дом.\n\n<!-- sf:toc -->"
	state, err := yjs.FromState(nil)
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	if err := state.SeedEvents([]yjs.EventSeed{{
		ID: chapter.String(), Title: "Глава", Body: body,
	}}); err != nil {
		t.Fatalf("засев: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, project.ID, owner, state.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}

	// Якорь на слово «вошла» — индексы Yjs считаются в UTF-16, поэтому считаем их той же
	// функцией, что и клиент.
	byteIndex := strings.Index(body, "вошла")
	if byteIndex < 0 {
		t.Fatal("в тексте нет слова для правки")
	}
	from := yjs.UTF16Len(body[:byteIndex])
	to := from + yjs.UTF16Len("вошла")
	start, end, ok := state.AnchorSpan(chapter.String(), "body", from, to)
	if !ok {
		t.Fatal("якорь на фрагмент не построился")
	}

	if _, _, _, err := e.transfer.ReplaceSpanChecked(ctx, owner, owner, project.ID,
		chapter.String(), "body", start, end, "вошла", "вбежала"); err != nil {
		t.Fatalf("правка фрагмента: %v", err)
	}

	rows, err := e.st.ListEvents(ctx, project.ID)
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	var edited store.Event
	for _, row := range rows {
		if row.ID == chapter {
			edited = row
		}
	}
	if edited.ID != chapter {
		t.Fatal("кадр пропал")
	}
	if !strings.Contains(edited.Body, "вбежала") {
		t.Fatalf("правка не применилась: %q", edited.Body)
	}
	if strings.Contains(edited.Body, "вошла") {
		t.Fatalf("старый текст остался: %q", edited.Body)
	}
	// Маркеры на месте и — что важнее — всё ещё ОТДЕЛЬНЫМИ строками: склеенный маркер
	// (например «… Абзац. <!-- sf:toc -->») сервер не разберёт, и оформление пропадёт молча.
	markers := 0
	for _, line := range strings.Split(edited.Body, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "<!-- sf:") {
			continue
		}
		markers++
		if trimmed != line {
			t.Fatalf("маркер перестал быть отдельной строкой: %q", line)
		}
	}
	if markers != 2 {
		t.Fatalf("маркеров после правки %d, ожидалось 2: %q", markers, edited.Body)
	}
	if !strings.Contains(edited.Body, "<!-- sf:pagebreak -->") || !strings.Contains(edited.Body, "<!-- sf:toc -->") {
		t.Fatalf("маркеры изменились: %q", edited.Body)
	}
}
