package assistant

// tools.go — инструменты, которые помощник отдаёт модели, и разбор их аргументов.
//
// Зачем инструменты, а не «просто попросить модель написать главу». Свободный текст
// модель пишет как хочет, и превращать его в события пришлось бы догадками (разбор
// заголовков, отступов, «вот тут, наверное, глава»). Инструмент — это узкий контракт:
// модель называет, ЧТО сделать, и передаёт параметры, а решение «создавать» принимает
// сервер. Только так можно поставить лимит на число изменений и честно показать
// человеку, что именно изменилось.
//
// Первый набор — только чтение и создание:
//
//	list_events       — дерево проекта: id, заголовок, уровень (контекст модели)
//	read_event        — текст одного кадра (чтобы дописать, а не начинать заново)
//	create_chapter    — глава верхнего уровня
//	create_sub_event  — под-событие внутри главы
//
// Удаления, перезаписи и перемещения здесь намеренно нет: сначала должно работать
// предсказуемое создание (docs/ai-assistant.md, «Что не берём»).
//
// Параметры описаны в форме OpenAI (`tools: [{type:"function", function:{...}}]`):
// это фактический стандарт, его понимают и облачные провайдеры, и Ollama.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/ai"
	"github.com/skyfraze/backend/internal/store"
)

// Имена инструментов. Константами, а не строками по месту: имя приходит от модели, и
// опечатка в одном месте означала бы «инструмент не найден» вместо понятной ошибки.
const (
	ToolListEvents    = "list_events"
	ToolReadEvent     = "read_event"
	ToolCreateChapter = "create_chapter"
	ToolCreateSub     = "create_sub_event"
	ToolUpdateText    = "update_event_text"
	ToolDeleteEvent   = "delete_event"
	// ToolUpdateDate — поставить или снять дату кадра (0.106.0).
	ToolUpdateDate    = "update_event_date"
	ToolGenerateImage = "generate_image"
	// Обсуждение и правка фрагмента по замечанию (0.62.0).
	ToolReadComments        = "read_comments"
	ToolProposeFragmentEdit = "propose_fragment_edit"
	// Карточки мира проекта (0.67.0): персонажи, места, темы.
	ToolListEntities = "list_entities"
	// Где карточка встречается (0.70.0): кадры и цитаты по имени.
	ToolReadEntity = "read_entity"
	// Предложение карточек мира и связей между ними (0.77.0): создаёт человек, не модель.
	ToolProposeEntities = "propose_entities"
)

// ErrUnknownTool — модель попросила инструмент, которого нет. Это не падение сервера:
// ответ уходит модели как результат вызова, и она может исправиться.
var ErrUnknownTool = errors.New("неизвестный инструмент")

// ToolDefs — описания инструментов для запроса к модели.
//
// Набор зависит от возможностей (`caps`) и от того, что подключено на стенде (`editing` —
// правка кадров, `world` — карточки мира): инструмента, которого агент сейчас не может
// выполнить, в списке НЕТ. Так модель физически не может пообещать нарисовать картинку,
// когда генератора нет, — обещание, которое нельзя выполнить, хуже отказа.
func ToolDefs(caps Capabilities, editing, world, worldWrite bool, entityKinds []string, entityTitles map[string]string) []ai.ToolDef {
	defs := []ai.ToolDef{
		{
			Name: ToolListEvents,
			Description: "Показать дерево событий проекта: идентификатор, уровень, заголовок и дату каждого кадра. " +
				"Вызывай, если нужно понять структуру проекта или найти идентификатор главы.",
			Parameters: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
		{
			Name: ToolReadEvent,
			Description: "Прочитать текст одного кадра (Markdown) по его идентификатору: " +
				"нужно, чтобы дописать главу, а не начинать её заново.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{"type": "string", "description": "Идентификатор события из list_events"},
				},
				"required": []string{"id"},
			},
		},
	}

	// Карточки мира проекта (0.67.0): персонажи, места, темы. Только чтение.
	//
	// Почему чтения достаточно: имя персонажа модель и так видит в тексте, а вот ЕДИНОГО имени
	// у неё нет. Получив список, она пишет «Анна», а не «Аня» в одной главе и «Анна Сергеевна»
	// в другой, и упоминания сходятся с карточками. Создание карточек без подтверждения
	// человеком намеренно не дано: неверная карточка портит связи во всём проекте, а не одну
	// правку.
	if caps.Text && world {
		defs = append(defs, ai.ToolDef{
			Name: ToolListEntities,
			Description: "Показать карточки мира проекта: персонажи, места и темы с их алиасами и описанием. " +
				"Вызывай ПЕРЕД тем, как писать текст, чтобы называть персонажей так же, как они записаны в проекте " +
				"(иначе упоминания не сойдутся с карточками).",
			Parameters: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
			// Где карточка встречается (0.70.0). Сервер ищет по проекции дерева, поэтому ответ
			// не зависит от того, открыт ли проект в браузере.
			ai.ToolDef{
				Name: ToolReadEntity,
				Description: "Показать, в каких кадрах встречается персонаж, место или тема, с цитатами. " +
					"Нужно для вопросов «где появляется Анна» и чтобы дописать линию героя, не перечитывая проект целиком.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name": map[string]any{"type": "string", "description": "Имя карточки из list_entities"},
					},
					"required": []string{"name"},
				},
			},
		)
	}

	// Предложение карточек и связей (0.77.0). Нужно И чтение, И запись: без чтения незачем
	// (модель не увидит, что уже заведено), без записи нечего применять.
	//
	// Почему предложение, а не создание. Карточка меняет весь проект — упоминания в тексте,
	// хронологию, матрицу, граф связей. Неверное имя испортит связи везде, где встретится, а
	// не одну сцену; поэтому пачку проверяет и подтверждает человек.
	if caps.Text && world && worldWrite {
		defs = append(defs, ai.ToolDef{
			Name: ToolProposeEntities,
			Description: "Предложить завести карточки мира (персонажи, места, темы) и связи между ними. " +
				"Вызывай, когда в тексте появляются важные герои или места, которых нет в списке карточек " +
				"(сначала посмотри list_entities, чтобы не предлагать то, что уже есть). " +
				"Карточки НЕ создаются: их добавит человек в окне помощника, так же как правку кадра. " +
				"Связи описывай именами карточек — из этой же пачки или уже существующих; подпись — " +
				"по-человечески («живёт на», «сестра»), направление — от первой карточки ко второй.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cards": map[string]any{
						"type":        "array",
						"description": "Карточки, которые стоит завести (не больше 12)",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"kind":        map[string]any{"type": "string", "enum": entityKindEnum(entityKinds), "description": kindEnumNote(entityKinds, entityTitles)},
								"name":        map[string]any{"type": "string", "description": "Имя в именительном падеже: «Анна». От 2 до 80 знаков"},
								"aliases":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Как ещё называют в тексте: падежи и краткие формы («Аня», «Анну») — по ним ищутся упоминания"},
								"description": map[string]any{"type": "string", "description": "Одна-две строки о том, кто это или что это (необязательно)"},
							},
							"required": []string{"kind", "name"},
						},
					},
					"links": map[string]any{
						"type":        "array",
						"description": "Связи между карточками (необязательно, не больше 24)",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"from":  map[string]any{"type": "string", "description": "Имя карточки-источника"},
								"to":    map[string]any{"type": "string", "description": "Имя карточки-цели"},
								"label": map[string]any{"type": "string", "description": "Подпись связи от источника к цели: «живёт на». От 1 до 40 знаков"},
							},
							"required": []string{"from", "to", "label"},
						},
					},
					"note": map[string]any{"type": "string", "description": "Почему предлагаешь: это человек прочитает перед подтверждением"},
				},
				"required": []string{"cards"},
			},
		})
	}

	// Текстовые инструменты — только если текстом можно заниматься (режим «только
	// картинки» их исключает).
	if caps.Text {
		defs = append(defs,
			ai.ToolDef{
				Name: ToolCreateChapter,
				Description: "Создать главу верхнего уровня (новый кадр истории) с описанием в Markdown. " +
					"Если не указать after_id, глава встанет в конец.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"title":    map[string]any{"type": "string", "description": "Заголовок главы, одна строка"},
						"body_md":  map[string]any{"type": "string", "description": "Текст главы в Markdown"},
						"date":     map[string]any{"type": "string", "description": "Дата кадра в виде ГГГГ-ММ-ДД (необязательно)"},
						"after_id": map[string]any{"type": "string", "description": "Идентификатор события, ПОСЛЕ которого поставить главу (необязательно)"},
					},
					"required": []string{"title"},
				},
			},
			ai.ToolDef{
				Name: ToolCreateSub,
				Description: "Создать под-событие внутри существующей главы (вложенный кадр) с описанием в Markdown. " +
					"Нужен идентификатор родителя из list_events.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"parent_id": map[string]any{"type": "string", "description": "Идентификатор главы, внутри которой создать кадр"},
						"title":     map[string]any{"type": "string", "description": "Заголовок кадра, одна строка"},
						"body_md":   map[string]any{"type": "string", "description": "Текст кадра в Markdown"},
						"date":      map[string]any{"type": "string", "description": "Дата кадра в виде ГГГГ-ММ-ДД (необязательно)"},
						"after_id":  map[string]any{"type": "string", "description": "Идентификатор соседа, ПОСЛЕ которого поставить кадр (необязательно)"},
					},
					"required": []string{"parent_id", "title"},
				},
			},
		)
	}

	// Предложения правок — только если правка вообще подключена (`editing`) и текстом
	// можно заниматься. Инструментов, которые нельзя выполнить, модель видеть не должна:
	// иначе она пообещает переписать главу, а кнопки «Применить» в окне не будет.
	if caps.Text && editing {
		defs = append(defs,
			ai.ToolDef{
				Name: ToolUpdateText,
				Description: "Предложить переписать заголовок и/или текст СУЩЕСТВУЮЩЕГО кадра. " +
					"Прочитай кадр (read_event) и передай новый текст целиком: частичных правок нет. " +
					"Правку применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":      map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
						"title":   map[string]any{"type": "string", "description": "Новый заголовок (необязательно; без него заголовок не меняется)"},
						"body_md": map[string]any{"type": "string", "description": "Новый текст кадра в Markdown (необязательно; без него текст не меняется)"},
						"reason":  map[string]any{"type": "string", "description": "Коротко, зачем правка: это увидит человек перед подтверждением"},
					},
					"required": []string{"id"},
				},
			},
			// Дата кадра (0.106.0): отдельный инструмент, а не поле в update_event_text.
			// «Перенеси этот кадр на 3 марта» — частая просьба, и разрешать заодно переписать
			// текст там, где просили поправить только дату, значит давать больше, чем просили.
			ai.ToolDef{
				Name: ToolUpdateDate,
				Description: "Предложить поставить или снять ДАТУ СУЩЕСТВУЮЩЕГО кадра. " +
					"Дата в формате YYYY-MM-DD; пустая строка — убрать дату. Текст кадра не меняется. " +
					"Ставь дату только из слов человека или из текста кадра: придумывать хронологию нельзя. " +
					"Дату применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":     map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
						"date":   map[string]any{"type": "string", "description": "Дата YYYY-MM-DD или пустая строка, чтобы убрать"},
						"reason": map[string]any{"type": "string", "description": "Коротко, откуда дата: это увидит человек перед подтверждением"},
					},
					"required": []string{"id", "date"},
				},
			},
			// Обсуждение кадров и правка по замечанию к фрагменту. Оба инструмента
			// предлагаются только вместе с правкой: читать обсуждение, чтобы ничего не мочь
			// исправить, — бесполезная подсказка модели.
			ai.ToolDef{
				Name: ToolReadComments,
				Description: "Прочитать обсуждение кадра: замечания и ответы с авторами, а у замечаний к фрагменту — цитату. " +
					"Нужно, чтобы понять, что именно просят исправить, прежде чем предлагать правку.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id": map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
					},
					"required": []string{"id"},
				},
			},
			ai.ToolDef{
				Name: ToolProposeFragmentEdit,
				Description: "Предложить заменить ФРАГМЕНТ текста кадра, к которому относится замечание. " +
					"Передай идентификатор замечания (из read_comments) и новый текст фрагмента целиком. " +
					"Если фрагмент успел измениться, предложение не создастся — это нормально, попроси человека уточнить. " +
					"Правку применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"comment_id":  map[string]any{"type": "string", "description": "Идентификатор замечания из read_comments"},
						"replacement": map[string]any{"type": "string", "description": "Новый текст выделенного фрагмента (Markdown, без окружающих абзацев)"},
						"reason":      map[string]any{"type": "string", "description": "Коротко, что исправляет правка: это увидит человек"},
					},
					"required": []string{"comment_id", "replacement"},
				},
			},
			ai.ToolDef{
				Name: ToolDeleteEvent,
				Description: "Предложить удалить кадр. Удалять можно только кадр без под-событий: " +
					"если дети есть, сначала реши, что с ними. Удаление применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":     map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
						"reason": map[string]any{"type": "string", "description": "Коротко, почему кадр лишний: это увидит человек перед подтверждением"},
					},
					"required": []string{"id"},
				},
			},
		)
	}

	// Инструмент иллюстраций — только если картинки доступны: иначе модель не должна
	// даже знать, что «так можно», иначе она пообещает то, чего сервер не сделает.
	if caps.Images && ImageToolAvailable {
		defs = append(defs, ai.ToolDef{
			Name: ToolGenerateImage,
			Description: "Нарисовать иллюстрацию к существующему кадру и привязать её к нему. " +
				"Сначала посмотри дерево (list_events), чтобы взять идентификатор кадра; " +
				"в prompt опиши, что должно быть на картинке (стиль проекта сервер добавит сам).",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"event_id": map[string]any{"type": "string", "description": "Идентификатор кадра из list_events, к которому рисуем"},
					"prompt":   map[string]any{"type": "string", "description": "Что нарисовать: сцена, свет, настроение. Без стиля — его добавит сервер"},
					"as_background": map[string]any{
						"type":        "boolean",
						"description": "Сделать картинку фоном кадра (по умолчанию да: иллюстрация к главе — это её фон)",
					},
				},
				"required": []string{"event_id", "prompt"},
			},
		})
	}
	return defs
}

// UpdateArgs — разобранные аргументы предложения переписать кадр.
type UpdateArgs struct {
	// EventID — какой кадр переписать.
	EventID uuid.UUID
	// Title — новый заголовок (nil — не менять).
	Title *string
	// Body — новый текст (nil — не менять).
	Body *string
	// Reason — почему, словами модели: человек увидит это перед подтверждением.
	Reason string
}

// ParseUpdate разбирает аргументы update_event_text.
//
// «Не задано» и «стереть» — разные вещи, поэтому пустая строка считается заданной, если
// параметр вообще пришёл: стереть заголовок (оставив кадр без названия) — законное
// действие, а вот «ни одного поля» — уже ошибка модели.
func ParseUpdate(args map[string]any, limits Limits) (UpdateArgs, error) {
	var out UpdateArgs
	rawID := argString(args, "id")
	if rawID == "" {
		return out, errors.New("не задан id — скажи, какой кадр переписать (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID

	if raw, ok := args["title"]; ok && raw != nil {
		title := argString(args, "title")
		if len([]rune(title)) > limits.MaxTitleChars {
			return out, TooLongError{Field: "title", Limit: limits.MaxTitleChars}
		}
		out.Title = &title
	}
	if raw, ok := args["body_md"]; ok && raw != nil {
		body := argString(args, "body_md")
		if len([]rune(body)) > limits.MaxBodyChars {
			return out, TooLongError{Field: "body_md", Limit: limits.MaxBodyChars}
		}
		// Маркеры DOCX (0.92.0): правка приходит текстом целиком, и склеенный маркер потерял бы
		// оформление куска молча — ошибка возвращается модели до предложения, а не после.
		if err := checkDocxMarkers(body); err != nil {
			return out, err
		}
		out.Body = &body
	}
	if out.Title == nil && out.Body == nil {
		return out, errors.New("нечего менять: передай title и/или body_md с новым содержимым")
	}
	out.Reason = argString(args, "reason")
	if len([]rune(out.Reason)) > limits.MaxReasonChars {
		out.Reason = string([]rune(out.Reason)[:limits.MaxReasonChars])
	}
	return out, nil
}

// DateArgs — аргументы предложения «поставить дату».
type DateArgs struct {
	EventID uuid.UUID
	// Date — YYYY-MM-DD; пустая строка значит «убрать дату» (осознанное действие, а не
	// отсутствие аргумента: без аргумента инструмент не вызывается).
	Date   string
	Reason string
}

// ParseDateUpdate разбирает аргументы update_event_date.
//
// Формат проверяется ДО предложения: модель охотно пишет «3 марта» и «2026-3-3», а человек
// потом видит предложение, которое нельзя применить. Пустая строка — допустимое значение
// («убрать дату»), отсутствие аргумента — нет.
func ParseDateUpdate(args map[string]any, limits Limits) (DateArgs, error) {
	var out DateArgs
	rawID := argString(args, "id")
	if rawID == "" {
		return out, errors.New("не задан id — скажи, какому кадру менять дату (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID

	raw, ok := args["date"]
	if !ok || raw == nil {
		return out, errors.New("не задана date: YYYY-MM-DD или пустая строка, чтобы убрать дату")
	}
	date := strings.TrimSpace(argString(args, "date"))
	if date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return out, errors.New("дата должна быть в формате YYYY-MM-DD (например 2026-03-02), " +
				"или пустой строкой, чтобы убрать дату")
		}
	}
	out.Date = date
	out.Reason = argString(args, "reason")
	if len([]rune(out.Reason)) > limits.MaxReasonChars {
		out.Reason = string([]rune(out.Reason)[:limits.MaxReasonChars])
	}
	return out, nil
}

// ParseDelete разбирает аргументы предложения удалить кадр.
func ParseDelete(args map[string]any, limits Limits) (uuid.UUID, string, error) {
	rawID := argString(args, "id")
	if rawID == "" {
		return uuid.Nil, "", errors.New("не задан id — скажи, какой кадр удалить (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return uuid.Nil, "", errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	reason := argString(args, "reason")
	if len([]rune(reason)) > limits.MaxReasonChars {
		reason = string([]rune(reason)[:limits.MaxReasonChars])
	}
	return eventID, reason, nil
}

// GenerateArgs — разобранные аргументы генерации иллюстрации.
type GenerateArgs struct {
	// EventID — к какому кадру привязать картинку.
	EventID uuid.UUID
	// Prompt — что нарисовать (стиль проекта дописывает сервер).
	Prompt string
	// AsBackground — сделать картинку фоном кадра (по умолчанию да).
	AsBackground bool
}

// ParseGenerate разбирает аргументы генерации. Проверки те же, что у создания кадра:
// лучше вернуть модели понятную ошибку, чем нарисовать картинку не к тому кадру.
func ParseGenerate(args map[string]any, limits Limits) (GenerateArgs, error) {
	out := GenerateArgs{AsBackground: true}
	rawID := argString(args, "event_id")
	if rawID == "" {
		return out, errors.New("не задан event_id — скажи, к какому кадру рисовать (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("event_id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID

	out.Prompt = strings.TrimSpace(argString(args, "prompt"))
	if out.Prompt == "" {
		return out, errors.New("не задан prompt — опиши, что должно быть на картинке")
	}
	if len([]rune(out.Prompt)) > limits.MaxImagePromptChars {
		return out, TooLongError{Field: "prompt", Limit: limits.MaxImagePromptChars}
	}
	if value, ok := args["as_background"]; ok {
		if flag, isBool := value.(bool); isBool {
			out.AsBackground = flag
		}
	}
	return out, nil
}

// CreateArgs — разобранные и проверенные аргументы создания кадра.
type CreateArgs struct {
	// Title — заголовок (обязателен, одна строка).
	Title string
	// Body — текст в Markdown (может быть пустым: пустой кадр тоже кадр).
	Body string
	// ParentID — nil для главы верхнего уровня.
	ParentID *uuid.UUID
	AfterID  *uuid.UUID
	// Date — дата кадра (нулевая — не задана).
	Date time.Time
}

// TooLongError — аргумент длиннее предела. Отдельный тип, потому что это не «модель
// ошиблась в контракте», а защита: текст на мегабайт в базе и в CRDT нам не нужен.
type TooLongError struct {
	Field string
	Limit int
}

func (e TooLongError) Error() string {
	return fmt.Sprintf("поле %s длиннее предела (%d символов)", e.Field, e.Limit)
}

// ImageToolAvailable — реализован ли инструмент генерации иллюстраций в этой версии.
//
// Отдельная константа, а не проверка настроек, потому что возможности агента
// складываются из трёх независимых вещей: что умеет стенд (настроен ли генератор), что
// разрешил владелец проекта (режим) и что вообще реализовано. Пока инструмента нет,
// режимы «картинки» и «оба» честно недоступны — и интерфейс, и правила говорят об этом
// одинаково, а не обещают картинку, которой не будет.
const ImageToolAvailable = true

// Limits — пределы на то, что модель может прислать и сделать за одно сообщение.
type Limits struct {
	// MaxToolCalls — сколько вызовов выполнить за одно сообщение человека.
	MaxToolCalls int
	// MaxRounds — сколько раз сходить к модели, пока она вызывает инструменты.
	// Больше двух-трёх раундов на практике не нужно, а стоят они денег и времени.
	MaxRounds int
	// MaxTitleChars/MaxBodyChars — пределы на заголовок и текст кадра.
	MaxTitleChars int
	MaxBodyChars  int
	// MaxEventsInPrompt — сколько событий дерева уходит в запрос как контекст.
	MaxEventsInPrompt int
	// MaxHistory — сколько сообщений беседы отправлять модели.
	MaxHistory int
	// MaxImagePromptChars — предел на промпт иллюстрации: он уходит в генератор, и
	// простыня на десять тысяч знаков там ничего не улучшит.
	MaxImagePromptChars int
	// MaxReasonChars — предел на «зачем эта правка»: это подпись для человека, а не
	// место для рассуждений модели.
	MaxReasonChars int
}

// DefaultLimits — пределы по умолчанию. Значения подобраны так, чтобы помощник был
// полезен и при этом не мог случайно залить проект текстом или истратить весь лимит
// провайдера за один вопрос.
func DefaultLimits(maxToolCalls int) Limits {
	if maxToolCalls <= 0 {
		maxToolCalls = 10
	}
	return Limits{
		MaxToolCalls:        maxToolCalls,
		MaxRounds:           3,
		MaxTitleChars:       200,
		MaxBodyChars:        20000,
		MaxEventsInPrompt:   200,
		MaxHistory:          20,
		MaxImagePromptChars: 2000,
		MaxReasonChars:      200,
	}
}

// ParseCreate разбирает аргументы создания кадра. Проверки нарочно строгие: лучше
// вернуть модели понятную ошибку, чем создать кадр с мусором в заголовке.
func ParseCreate(args map[string]any, limits Limits) (CreateArgs, error) {
	var out CreateArgs
	title := argString(args, "title")
	if title == "" {
		return out, errors.New("не задан title — заголовок кадра обязателен")
	}
	if len([]rune(title)) > limits.MaxTitleChars {
		return out, TooLongError{Field: "title", Limit: limits.MaxTitleChars}
	}
	body := argString(args, "body_md")
	if len([]rune(body)) > limits.MaxBodyChars {
		return out, TooLongError{Field: "body_md", Limit: limits.MaxBodyChars}
	}
	// Маркеры DOCX (0.92.0): склеенная строка маркера не работает и молча теряет оформление —
	// лучше вернуть модели понятную ошибку, пока текст не стал кадром.
	if err := checkDocxMarkers(body); err != nil {
		return out, err
	}
	out.Title = title
	out.Body = body

	if raw := argString(args, "parent_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return out, fmt.Errorf("parent_id не похож на идентификатор: %q", raw)
		}
		out.ParentID = &id
	}
	if raw := argString(args, "after_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return out, fmt.Errorf("after_id не похож на идентификатор: %q", raw)
		}
		out.AfterID = &id
	}
	if raw := argString(args, "date"); raw != "" {
		date, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return out, fmt.Errorf("date не разобрана (нужен вид ГГГГ-ММ-ДД): %q", raw)
		}
		out.Date = date
	}
	return out, nil
}

// ParseEventID достаёт идентификатор события из аргументов read_event.
func ParseEventID(args map[string]any) (uuid.UUID, error) {
	raw := argString(args, "id")
	if raw == "" {
		return uuid.Nil, errors.New("не задан id события")
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, fmt.Errorf("id не похож на идентификатор: %q", raw)
	}
	return id, nil
}

// argString читает строковый аргумент терпимо: модели присылают то строку, то число,
// то null, и отказ из-за формата был бы отказом на ровном месте.
func argString(args map[string]any, name string) string {
	value, ok := args[name]
	if !ok || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		// Числа приходят из JSON именно так (дата, год, «5-я глава»).
		return strings.TrimSpace(trimFloat(v))
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

// trimFloat печатает число без хвоста «.0»: «2024» вместо «2024.0».
func trimFloat(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}

// FragmentEditArgs — разобранные аргументы предложения правки фрагмента.
type FragmentEditArgs struct {
	// CommentID — замечание, к фрагменту которого относится правка.
	CommentID uuid.UUID
	// Replacement — новый текст фрагмента.
	Replacement string
	// Reason — почему, словами модели: человек увидит это перед подтверждением.
	Reason string
}

// ParseFragmentEdit разбирает аргументы propose_fragment_edit.
//
// Пустая замена — законное действие: это удаление фрагмента. Поэтому «не задано» проверяется
// по наличию параметра, а не по длине строки.
func ParseFragmentEdit(args map[string]any, limits Limits) (FragmentEditArgs, error) {
	var out FragmentEditArgs
	rawID := argString(args, "comment_id")
	commentID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("нужен идентификатор замечания из read_comments")
	}
	replacement, ok := args["replacement"]
	if !ok {
		return out, errors.New("нужен новый текст фрагмента в поле replacement")
	}
	text, isString := replacement.(string)
	if !isString {
		return out, errors.New("replacement должен быть строкой")
	}
	if limits.MaxBodyChars > 0 && len([]rune(text)) > limits.MaxBodyChars {
		return out, fmt.Errorf("фрагмент длиннее %d знаков — разбей правку на части", limits.MaxBodyChars)
	}
	out.CommentID = commentID
	out.Replacement = text
	out.Reason = argString(args, "reason")
	return out, nil
}

// entityKindEnum — какие виды карточек предложить модели (0.81.0).
//
// Enum собирается по ТИПАМ ПРОЕКТА: помощник не должен придумывать «фракцию», которой в проекте
// нет, — иначе предложение пришлось бы отбрасывать уже после подтверждения. Пустой список (типы
// не подключены) даёт стартовые три: так набор инструментов не зависит от данных.
func entityKindEnum(kinds []string) []string {
	if len(kinds) == 0 {
		return []string{store.EntityTypeCharacter, store.EntityTypePlace, store.EntityTypeTheme}
	}
	return kinds
}

// kindEnumNote — человеческая расшифровка enum для модели: «character — персонаж» читается лучше,
// чем список машинных ключей, особенно когда человек переименовал стартовые типы.
func kindEnumNote(kinds []string, titles map[string]string) string {
	list := entityKindEnum(kinds)
	parts := make([]string, 0, len(list))
	for _, key := range list {
		if title := strings.TrimSpace(titles[key]); title != "" {
			parts = append(parts, key+" — "+title)
		} else {
			parts = append(parts, key)
		}
	}
	return "Вид карточки из списка типов проекта: " + strings.Join(parts, ", ")
}

// EntityProposalArgs — разобранные аргументы propose_entities.
type EntityProposalArgs struct {
	Cards []store.ProposedCard
	Links []store.ProposedLink
	// Note — почему предлагаю: человек прочитает это перед подтверждением.
	Note string
}

// ParseEntityProposal разбирает аргументы propose_entities.
//
// Разбор здесь только структурный: имена, виды, алиасы и подписи проверяет ProposeEntities —
// теми же правилами, что и создание карточки (entities.PrepareCard). Дублировать их в разборе
// значило бы держать две копии, которые однажды разойдутся.
func ParseEntityProposal(args map[string]any) (EntityProposalArgs, error) {
	var out EntityProposalArgs
	rawCards, ok := args["cards"]
	if !ok || rawCards == nil {
		return out, errors.New("нужен список карточек в поле cards")
	}
	list, isList := rawCards.([]any)
	if !isList || len(list) == 0 {
		return out, errors.New("cards должен быть непустым списком карточек")
	}
	out.Cards = make([]store.ProposedCard, 0, len(list))
	for index, item := range list {
		card, isCard := item.(map[string]any)
		if !isCard {
			return out, fmt.Errorf("карточка №%d: ожидался объект с полями kind, name, aliases", index+1)
		}
		name := strings.TrimSpace(argString(card, "name"))
		if name == "" {
			return out, fmt.Errorf("карточка №%d: не задано имя (name)", index+1)
		}
		out.Cards = append(out.Cards, store.ProposedCard{
			Kind:        strings.TrimSpace(argString(card, "kind")),
			Name:        name,
			Aliases:     nonNilStrings(argStrings(card, "aliases")),
			Description: strings.TrimSpace(argString(card, "description")),
		})
	}
	if rawLinks, hasLinks := args["links"]; hasLinks && rawLinks != nil {
		links, isList := rawLinks.([]any)
		if !isList {
			return out, errors.New("links должен быть списком связей")
		}
		out.Links = make([]store.ProposedLink, 0, len(links))
		for index, item := range links {
			link, isLink := item.(map[string]any)
			if !isLink {
				return out, fmt.Errorf("связь №%d: ожидался объект с полями from, to, label", index+1)
			}
			out.Links = append(out.Links, store.ProposedLink{
				From:  strings.TrimSpace(argString(link, "from")),
				To:    strings.TrimSpace(argString(link, "to")),
				Label: strings.TrimSpace(argString(link, "label")),
			})
		}
	}
	out.Note = strings.TrimSpace(argString(args, "note"))
	return out, nil
}

// argStrings читает массив строк из аргументов инструмента. Не-строки пропускаются: модель
// иногда присылает числа или null в списке, и падать из-за этого незачем — мусор отсеет
// проверка алиасов.
func argStrings(args map[string]any, name string) []string {
	raw, ok := args[name]
	if !ok || raw == nil {
		return []string{}
	}
	list, isList := raw.([]any)
	if !isList {
		return []string{}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if value, isString := item.(string); isString {
			out = append(out, value)
		}
	}
	return out
}
