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
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
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
	ToolUpdateDate = "update_event_date"
	// ToolMoveEvent — перенести кадр к другому родителю (0.108.0).
	ToolMoveEvent     = "move_event"
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
	// Абзацы кадра (0.143.0). Читаем и правим по одному абзацу: ответ маленькой модели
	// должен быть коротким, а контекст она набирает повторными вызовами.
	ToolReadEventParagraphs = "read_event_paragraphs"
	ToolUpdateParagraph     = "update_event_paragraph"

	// Знания проекта (0.149.0). save_knowledge — то, ради чего беседу можно удалять:
	// модель укладывает выводы в знание (или несколько, если в предел не влезло), и оно
	// остаётся у проекта, пока беседа стареет. list/read — чтобы знаниями можно было
	// пользоваться в следующих вопросах, не пересказывая их человеку заново.
	ToolSaveKnowledge = "save_knowledge"
	ToolListKnowledge = "list_knowledge"
	ToolReadKnowledge = "read_knowledge"
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
		// Абзацами (0.143.0). Почему не только read_event: длинный текст кадра режется
		// (toolBodyChars), и модель, которой нужен абзац из середины, его просто не видит.
		// Здесь текст приходит по частям, и модель сама набирает столько, сколько нужно,
		// чтобы понять идею, — без одного гигантского ответа.
		{
			Name: ToolReadEventParagraphs,
			Description: "Прочитать текст кадра абзацами: номер, текст, всего абзацев. " +
				"Вызывай, когда текст кадра длинный или правка касается конкретного абзаца: " +
				"читай по 5 абзацев (count), повторяй с нужного (from), пока не поймёшь, о чём глава " +
				"и какой абзац править. Номера абзацев нужны для update_event_paragraph.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id":    map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
					"from":  map[string]any{"type": "number", "description": "С какого абзаца начать (1 — первый; по умолчанию 1)"},
					"count": map[string]any{"type": "number", "description": "Сколько абзацев вернуть (по умолчанию 5, не больше 20)"},
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
					"Если новый текст больше трёх абзацев, передавай его блоком skyfraze-text, а не " +
					"сюда: длинный текст в JSON-аргументе обрывается. " +
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
			// Точечная правка абзацем (0.143.0). Почему отдельный инструмент, а не «передай
			// body_md целиком»: живая gemma на «перепиши главу» пишет всю главу внутрь
			// JSON-строки с экранированием переводов строк и обрывается на середине — вызов
			// не разбирается. Здесь ответ — один абзац обычным текстом, экранировать нечего.
			ai.ToolDef{
				Name: ToolUpdateParagraph,
				Description: "Предложить заменить ОДИН абзац кадра. Самый надёжный способ правки: " +
					"нужно сначала прочитать кадр абзацами (read_event_paragraphs), затем передать номер " +
					"абзаца и его новый текст — обычным текстом, без JSON-экранирования и без разметки " +
					"вызова внутри текста. Правку применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":        map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
						"paragraph": map[string]any{"type": "number", "description": "Номер абзаца из read_event_paragraphs (1 — первый)"},
						"text":      map[string]any{"type": "string", "description": "Новый текст этого абзаца (Markdown, без заголовка кадра)"},
						"reason":    map[string]any{"type": "string", "description": "Коротко, зачем правка: это увидит человек перед подтверждением"},
					},
					"required": []string{"id", "paragraph", "text"},
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
			// Перенос по дереву (0.108.0). Отдельный инструмент: место кадра — не текст и не
			// дата, и «Вернуть» здесь возвращает прежнюю главу.
			ai.ToolDef{
				Name: ToolMoveEvent,
				Description: "Предложить перенести кадр в другую главу или на верхний уровень дерева. " +
					"Передай идентификатор кадра (из list_events) и идентификатор нового родителя из дерева; " +
					"пустой parent_id — верхний уровень. Под-события переезжают вместе с кадром. " +
					"Перенос применяет человек — ты только предлагаешь.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":        map[string]any{"type": "string", "description": "Идентификатор кадра из list_events"},
						"parent_id": map[string]any{"type": "string", "description": "Идентификатор новой родительской главы или пустая строка для верхнего уровня"},
						"reason":    map[string]any{"type": "string", "description": "Коротко, зачем перенос: это увидит человек перед подтверждением"},
					},
					"required": []string{"id", "parent_id"},
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

	// Знания проекта (0.149.0). Чтение доступно всегда — оно не меняет ни проект, ни
	// знания; сохранение только там, где человек вообще может писать. В общем чате
	// проекта (`caps.ReadOnly`) агент знаниями пользуется, но не создаёт: участники
	// обсуждают, а «Нестор по пути завёл знание» — такая же неожиданность, как правка
	// главы из обсуждения.
	defs = append(defs, ai.ToolDef{
		Name: ToolListKnowledge,
		Description: "Показать сохранённые знания проекта: заголовок, пометку «о чём это», " +
			"размер и дату. Вызывай, когда человек ссылается на «то, что мы решили раньше», " +
			"или ПЕРЕД сохранением нового знания — чтобы не завести дубль.",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, ai.ToolDef{
		Name: ToolReadKnowledge,
		Description: "Прочитать знание проекта целиком по идентификатору из list_knowledge. " +
			"Приложенные к вопросу знания уже видны в тексте вопроса — их читать не нужно.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id": map[string]any{"type": "string", "description": "Идентификатор знания из list_knowledge"},
			},
			"required": []string{"id"},
		},
	})
	if !caps.ReadOnly && caps.Text {
		defs = append(defs, ai.ToolDef{
			Name: ToolSaveKnowledge,
			Description: fmt.Sprintf("Сохранить выводы беседы как знание проекта. Вызывай, когда человек "+
				"просит сохранить итоги, решения, договорённости — то, что должно остаться после "+
				"удаления переписки. Уложи в тезисы: что решили, что выяснили, что важно помнить. "+
				"Предел одного знания — %d знаков. Если всё не влезает, разбей на несколько знаний "+
				"по группам (темам, главам, линиям героев) и передай их одной пачкой: не начинай "+
				"второй разговор ради второй части. Заголовок — короткая строка, summary — одна-две "+
				"строки о содержании: по ним человек ищет знания в списке.", MaxKnowledgeChars),
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"entries": map[string]any{
						"type":        "array",
						"description": fmt.Sprintf("Знания, которые нужно сохранить (не больше %d)", MaxKnowledgeEntries),
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"title": map[string]any{"type": "string", "description": fmt.Sprintf(
									"Заголовок знания: о чём оно, до %d знаков", MaxKnowledgeTitle)},
								"summary": map[string]any{"type": "string", "description": fmt.Sprintf(
									"Пометка для списка: одна-две строки о содержании, до %d знаков",
									MaxKnowledgeSummary)},
								"body": map[string]any{"type": "string", "description": fmt.Sprintf(
									"Тезисы в Markdown, до %d знаков", MaxKnowledgeChars)},
								"tags": map[string]any{
									"type":        "array",
									"items":       map[string]any{"type": "string"},
									"description": fmt.Sprintf("Метки для поиска, до %d: темы, имена, линии («драконы», «анна», «канон»)", MaxKnowledgeTags),
								},
							},
							"required": []string{"title", "body"},
						},
					},
				},
				"required": []string{"entries"},
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

// ParagraphReadArgs — аргументы чтения кадра абзацами.
type ParagraphReadArgs struct {
	// EventID — какой кадр читаем.
	EventID uuid.UUID
	// From — с какого абзаца (1-based).
	From int
	// Count — сколько абзацев вернуть.
	Count int
}

// paragraphPageMax — сколько абзацев отдавать за один вызов.
//
// Почему 20: страница должна быть заметно меньше окна модели, иначе возвращается ровно та
// проблема, ради которой инструмент сделан. Кому нужно больше — читает следующую страницу.
const paragraphPageMax = 20

// ParseParagraphRead разбирает аргументы read_event_paragraphs.
//
// Номера абзацев терпим к тому, что модель присылает строкой («2») или отсутствием поля:
// это подсказка, а не идентификатор, и отказ из-за неё был бы отказом на ровном месте.
func ParseParagraphRead(args map[string]any) (ParagraphReadArgs, error) {
	var out ParagraphReadArgs
	rawID := argString(args, "id")
	if rawID == "" {
		return out, errors.New("не задан id — какой кадр читать (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID
	out.From = argInt(args, "from", 1)
	if out.From < 1 {
		out.From = 1
	}
	out.Count = argInt(args, "count", 5)
	if out.Count < 1 {
		out.Count = 5
	}
	if out.Count > paragraphPageMax {
		out.Count = paragraphPageMax
	}
	return out, nil
}

// ParagraphUpdateArgs — аргументы правки одного абзаца.
type ParagraphUpdateArgs struct {
	EventID uuid.UUID
	// Paragraph — номер абзаца (1-based), как его показал read_event_paragraphs.
	Paragraph int
	// Text — новый текст абзаца. Пустая строка — законное действие: абзац убирается.
	Text   string
	Reason string
}

// ParseParagraphUpdate разбирает аргументы update_event_paragraph.
//
// «Не задано» и «пусто» здесь разные вещи, как и в update_event_text: пустой текст — это
// удаление абзаца, и оно допустимо, а вот отсутствие поля — ошибка модели.
func ParseParagraphUpdate(args map[string]any, limits Limits) (ParagraphUpdateArgs, error) {
	var out ParagraphUpdateArgs
	rawID := argString(args, "id")
	if rawID == "" {
		return out, errors.New("не задан id — какому кадру менять абзац (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID

	raw, ok := args["paragraph"]
	if !ok || raw == nil {
		return out, errors.New("не задан paragraph — номер абзаца из read_event_paragraphs")
	}
	out.Paragraph = argInt(args, "paragraph", 0)
	if out.Paragraph < 1 {
		return out, errors.New("paragraph — номер абзаца, начиная с 1: возьми его из read_event_paragraphs")
	}

	value, ok := args["text"]
	if !ok || value == nil {
		return out, errors.New("не задан text — новый текст абзаца (пустая строка убирает абзац)")
	}
	out.Text = argString(args, "text")
	if len([]rune(out.Text)) > limits.MaxBodyChars {
		return out, TooLongError{Field: "text", Limit: limits.MaxBodyChars}
	}
	// Маркеры DOCX внутри абзаца — та же беда, что и в целом тексте: склеенный маркер
	// потеряет оформление молча.
	if err := checkDocxMarkers(out.Text); err != nil {
		return out, err
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

// MoveArgs — аргументы предложения «перенести кадр».
type MoveArgs struct {
	EventID uuid.UUID
	// ParentID — пустая строка значит «на верхний уровень» (это осознанное действие, а не
	// отсутствие аргумента: без parent_id инструмент не вызывается).
	ParentID string
	Reason   string
}

// ParseMove разбирает аргументы move_event.
func ParseMove(args map[string]any, limits Limits) (MoveArgs, error) {
	var out MoveArgs
	rawID := argString(args, "id")
	if rawID == "" {
		return out, errors.New("не задан id — скажи, какой кадр переносить (возьми из list_events)")
	}
	eventID, err := uuid.Parse(rawID)
	if err != nil {
		return out, errors.New("id не похож на идентификатор — возьми его из list_events")
	}
	out.EventID = eventID
	raw, ok := args["parent_id"]
	if !ok || raw == nil {
		return out, errors.New("не задан parent_id: куда переносить (id главы) или пустая строка для верхнего уровня")
	}
	parentID := strings.TrimSpace(argString(args, "parent_id"))
	if parentID != "" {
		if _, err := uuid.Parse(parentID); err != nil {
			return out, errors.New("parent_id не похож на идентификатор — возьми его из дерева проекта")
		}
	}
	if parentID == rawID {
		return out, errors.New("кадр не может быть родителем самому себе")
	}
	out.ParentID = parentID
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
	// KnowledgeChars — предел знаков одного знания (0 — MaxKnowledgeChars). Отдельным
	// полем, чтобы тесты проверяли разбиение на коротком пределе, а не на 4 000 знаков.
	KnowledgeChars int
	// KnowledgeEntries — сколько знаний можно сохранить одной пачкой.
	KnowledgeEntries int
}

// DefaultLimits — пределы по умолчанию. Значения подобраны так, чтобы помощник был
// полезен и при этом не мог случайно залить проект текстом или истратить весь лимит
// провайдера за один вопрос.
func DefaultLimits(maxToolCalls int) Limits {
	if maxToolCalls <= 0 {
		maxToolCalls = 10
	}
	return Limits{
		MaxToolCalls: maxToolCalls,
		// Пять раундов, а не три (0.142.7): живой прогон показал, что помощнику не хватало
		// ровно одного раунда — он прочитал кадр, ошибся с id, прочитал дерево и хотел применить
		// правку, а лимит уже кончился, и финальный запрос «ответь словами» модель выполнила
		// вызовом инструмента текстом (обрезанный JSON в ответе).
		MaxRounds:           5,
		MaxTitleChars:       200,
		MaxBodyChars:        20000,
		MaxEventsInPrompt:   200,
		MaxHistory:          20,
		MaxImagePromptChars: 2000,
		MaxReasonChars:      200,
		KnowledgeChars:      MaxKnowledgeChars,
		KnowledgeEntries:    MaxKnowledgeEntries,
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

// argInt читает числовой аргумент терпимо: модели присылают «5», 5, «5.0» и «пятый».
// Не разобралось — берём значение по умолчанию: это подсказка, а не идентификатор.
func argInt(args map[string]any, name string, def int) int {
	raw := argString(args, name)
	if raw == "" {
		return def
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		// «5.0» и «5,0» — типичный вид числа из JSON-строки.
		if f, ferr := strconv.ParseFloat(strings.ReplaceAll(raw, ",", "."), 64); ferr == nil {
			return int(f)
		}
		return def
	}
	return value
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

// ParseSaveKnowledge разбирает аргументы save_knowledge.
//
// Терпимость к форме здесь намеренная. Маленькие модели (gemma E4B) при вызове с массивом
// регулярно присылают либо один объект вместо массива, либо один объект в корне без
// `entries` — и «нужен список» в ответ на «сохрани выводы» выглядит как отказ, хотя
// человек попросил понятную вещь. Принимаем все три формы, а предел знака проверяет
// сервис — разбор только структура.
func ParseSaveKnowledge(args map[string]any) ([]KnowledgeInput, error) {
	entries := make([]KnowledgeInput, 0, 4)
	appendEntry := func(item map[string]any) {
		entries = append(entries, KnowledgeInput{
			// Синонимы — не «на всякий случай», а по живому прогону (0.149.1): gemma E4B
			// прислала выводы в поле `content`, а `body` оставила пустым, и знание
			// отклонилось как «без текста». Поля, которые модель путает, принимаем все.
			Title:   argStringAny(item, "title", "name"),
			Summary: argStringAny(item, "summary", "note"),
			Body:    argStringAny(item, "body", "text", "content", "body_md", "knowledge"),
			Tags:    argStrings(item, "tags"),
		})
	}
	raw, has := args["entries"]
	// Ещё одна живая форма: `entries` пришёл СТРОКОЙ с JSON внутри (маленькие модели
	// сериализуют аргумент дважды). Разбираем, а не отказываем.
	if text, isString := raw.(string); isString {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(text), &decoded); err == nil {
			if inner, ok := decoded["entries"]; ok {
				raw = inner
			}
		}
	}
	switch value := raw.(type) {
	case []any:
		if len(value) == 0 {
			return nil, errors.New("entries пуст — сохранять нечего")
		}
		for index, item := range value {
			entry, isEntry := item.(map[string]any)
			if !isEntry {
				return nil, fmt.Errorf("знание №%d: ожидался объект с полями title, summary, body", index+1)
			}
			appendEntry(entry)
		}
	case map[string]any:
		// Один объект вместо пачки — частая ошибка, и она безвредна.
		appendEntry(value)
	default:
		if !has {
			// Ещё одна форма: title/body прямо в корне.
			appendEntry(args)
		} else {
			return nil, errors.New("entries должен быть списком знаний")
		}
	}
	if len(entries) == 0 {
		return nil, errors.New("не передано ни одного знания")
	}
	return entries, nil
}

// argStringAny читает первую непустую строку из перечисленных полей.
//
// Синонимы нужны из-за живой модели (0.149.1): gemma E4B положила тезисы в `content`, а
// `body` оставила пустым. Схема инструмента описывает одно имя, но модель — не компилятор,
// и отказ «нет текста» на просьбу «сохрани выводы» выглядит как поломка помощника.
func argStringAny(args map[string]any, names ...string) string {
	for _, name := range names {
		if value := argString(args, name); strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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
