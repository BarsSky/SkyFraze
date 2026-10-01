// Package collab — WebSocket-relay для Yjs с серверным слиянием.
//
// Протокол:
//  1. клиент шлёт HTTP Upgrade на /api/projects/{id}/collab?token=<JWT>
//  2. после Upgrade — bidirectional поток бинарных Yjs-апдейтов (ws.BinaryMessage)
//  3. комната держит СВОЙ документ: апдейты клиентов применяются к нему, а в базу
//     снапшот пишет один писатель — сервер (см. persist)
//
// До Фазы 3 сервер только маршрутизировал байты, а снапшот писал каждый клиент
// своим debounce'ом: N вкладок конкурировали за одну ревизию (шторм 409), каждая
// перезаписывала yjs_state целиком. Теперь серверный документ — источник правды
// для снапшота, а клиенты пишут по REST только если realtime у них не поднялся.
package collab

import (
	"bytes"
	"context"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/events"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	snapshotPeriod = 30 * time.Second
	// flushPeriod — как часто сервер сохраняет слитое состояние, если в комнате
	// что-то менялось. Заметно чаще прежних 30 с: клиенты почти перестали писать
	// сами, и задержка сохранения теперь и есть окно потери правок при падении
	// сервера. Пишем только «грязные» комнаты, поэтому цена — один UPDATE.
	flushPeriod       = 5 * time.Second
	maxMessageSize    = 16 * 1024 * 1024
	closePolicyFailed = 4401
	// presencePrefix — начало кадра присутствия (см. frontend/src/collab/awareness.ts).
	// Присутствие едет тем же сокетом, что и CRDT, но документом не является:
	// такие кадры только релеятся, применять их к серверному документу нельзя.
	presencePrefix = "sfp1:"
)

// Hub — реестр комнат.
type Hub struct {
	logger   *slog.Logger
	secret   string
	ev       *events.Service
	upgrader websocket.Upgrader

	mu    sync.RWMutex
	rooms map[uuid.UUID]*Room
}

// NewHub — allowedOrigins: список origin'ов из CORS_ORIGINS (comma-separated).
//
// CheckOrigin раньше возвращал true всегда (любой сайт мог открыть WS с токеном
// жертвы в query). Теперь допускаются только свои origin'ы; пустой Origin
// (не-браузерные клиенты, тесты, CLI) пропускается — их всё равно защищает
// только токен, а Origin в браузере подделать нельзя.
//
// Важное дополнение: помимо списка допускается origin, совпадающий с хостом самого
// запроса. Без этого приложение работало только по тем адресам, что перечислены в
// CORS_ORIGINS: открыв стенд по IP, домену или с телефона, пользователь получал
// «пустой» проект — WebSocket отклонялся, снапшот не приходил, стадия считала
// таймлайн пустым. Запрос на тот же хост — это и есть легитимный сценарий, а
// подделывать Host в браузере нельзя (в отличие от Origin, который тоже проверяется).
func NewHub(logger *slog.Logger, secret string, ev *events.Service, allowedOrigins string) *Hub {
	allowed := parseOrigins(allowedOrigins)
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			if allowed[origin] {
				return true
			}
			return sameHost(origin, r)
		},
	}
	return &Hub{
		logger:   logger,
		secret:   secret,
		ev:       ev,
		upgrader: upgrader,
		rooms:    make(map[uuid.UUID]*Room),
	}
}

// sameHost сравнивает ИМЯ хоста origin'а с именем хоста запроса.
//
// Сравнивать «как есть» нельзя: за reverse proxy (nginx proxy manager и любой
// другой) заголовок Host доезжает без порта, а Origin браузер присылает с портом
// (`https://host:8443`) — строки не совпадали, и WebSocket получал 403. Порт и
// схема к делу не относятся: важно, что браузер обращается к тому же хосту, а
// подделать Host в браузере нельзя. Дополнительно смотрим X-Forwarded-Host —
// некоторые прокси переписывают Host на имя апстрима.
func sameHost(origin string, r *http.Request) bool {
	want := hostOnly(origin)
	if want == "" {
		return false
	}
	for _, candidate := range []string{r.Host, r.Header.Get("X-Forwarded-Host")} {
		if hostOnly(candidate) == want {
			return true
		}
	}
	return false
}

// hostOnly приводит «https://Host:port/path» к «host» (нижний регистр, без схемы,
// порта и пути). IPv6 в скобках сохраняем как есть.
func hostOnly(value string) string {
	v := strings.ToLower(strings.TrimSpace(value))
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+3:]
	}
	if i := strings.IndexAny(v, "/?#"); i >= 0 {
		v = v[:i]
	}
	if strings.HasPrefix(v, "[") { // [::1]:8443
		if i := strings.Index(v, "]"); i >= 0 {
			return v[:i+1]
		}
		return v
	}
	// X-Forwarded-Host может содержать список через запятую — берём первый.
	if i := strings.Index(v, ","); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	if i := strings.LastIndex(v, ":"); i >= 0 {
		v = v[:i]
	}
	return v
}

// parseOrigins разбирает "http://a, http://b" в множество.
func parseOrigins(s string) map[string]bool {
	out := map[string]bool{}
	for _, o := range strings.Split(s, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			out[o] = true
		}
	}
	return out
}

// Run — фоновая задача сохранения снапшотов.
func (h *Hub) Run(ctx context.Context) {
	t := time.NewTicker(flushPeriod)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			// Последнее сохранение при остановке: иначе правки за последний
			// flushPeriod исчезли бы вместе с процессом.
			h.flushAll(context.Background())
			return
		case <-t.C:
			h.snapshotActiveRooms(ctx)
		}
	}
}

func (h *Hub) snapshotActiveRooms(ctx context.Context) {
	h.mu.RLock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.RUnlock()
	for _, r := range rooms {
		r.persistFromAnyClient(ctx, h.ev, h.logger)
	}
}

func (h *Hub) flushAll(ctx context.Context) {
	h.mu.RLock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.RUnlock()
	for _, r := range rooms {
		r.persistFromAnyClient(ctx, h.ev, h.logger)
	}
}

func (h *Hub) getOrCreate(projectID uuid.UUID) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[projectID]; ok {
		return r
	}
	r := &Room{
		projectID: projectID,
		clients:   make(map[*client]struct{}),
	}
	h.rooms[projectID] = r
	return r
}

func (h *Hub) removeIfEmpty(projectID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[projectID]
	if !ok {
		return
	}
	r.mu.RLock()
	empty := len(r.clients) == 0
	r.mu.RUnlock()
	if empty {
		delete(h.rooms, projectID)
	}
}

// HandleWS — http.Handler для /api/projects/{id}/collab.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	claims, err := auth.ParseAccess(h.secret, tok)
	if err != nil || claims == nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	pid, err := uuid.Parse(projectIDFromPath(r.URL.Path))
	if err != nil {
		http.Error(w, "invalid project id", http.StatusBadRequest)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("ws upgrade", "err", err)
		return
	}
	c := h.addClient(conn, claims.UserID, pid)
	if c == nil {
		_ = conn.Close()
		return
	}
	go c.writer()
	go c.reader(h)
}

// upgraderForTests возвращает Upgrader для интеграционных тестов.
// Не используется в production — main.go регистрирует HandleWS напрямую.
func (h *Hub) Upgrader() websocket.Upgrader { return h.upgrader }

func (h *Hub) addClient(conn *websocket.Conn, userID, projectID uuid.UUID) *client {
	room := h.getOrCreate(projectID)
	c := &client{
		conn:      conn,
		send:      make(chan []byte, 64),
		userID:    userID,
		projectID: projectID,
		room:      room,
		closed:    make(chan struct{}),
		// Право записи выясняем один раз при подключении: апдейты наблюдателя к
		// серверному документу не применяются, иначе он обошёл бы проверку прав.
		canWrite: h.ev.CanEdit(context.Background(), userID, projectID),
	}
	room.mu.Lock()
	room.clients[c] = struct{}{}
	room.mu.Unlock()

	// Серверный документ комнаты: из него пишется снапшот и в него применяются
	// апдейты клиентов. Загружаем до первого сообщения — иначе первый апдейт
	// пришлось бы буферизовать «до загрузки».
	room.ensureDoc(context.Background(), h.ev, userID, projectID)

	// Подключившемуся отдаём состояние КОМНАТЫ: в нём уже есть серверная миграция
	// текста (title_text/body_text), которой в снапшоте базы может ещё не быть.
	// Если документа нет (не загрузился) — отдаём снапшот из базы, как раньше:
	// клиент всё равно пришлёт своё состояние, и слияние произойдёт у него.
	if state := room.state(); len(state) > 0 {
		select {
		case c.send <- state:
		default:
		}
	} else if state, _, err := h.ev.GetYjsState(context.Background(), userID, projectID); err == nil && len(state) > 0 {
		select {
		case c.send <- state:
		default:
		}
	}
	return c
}

func (h *Hub) leave(c *client) {
	c.room.mu.Lock()
	removed := false
	if _, ok := c.room.clients[c]; ok {
		delete(c.room.clients, c)
		close(c.closed)
		removed = true
	}
	empty := len(c.room.clients) == 0
	c.room.mu.Unlock()

	if removed && empty {
		// Последний ушёл — сохраняем сразу, не дожидаясь тика: комната вот-вот
		// исчезнет из реестра, и её «грязное» состояние иначе потерялось бы.
		c.room.persistFromAnyClient(context.Background(), h.ev, h.logger)
	}
	h.removeIfEmpty(c.projectID)
}

// Room — одна комната.
type Room struct {
	projectID uuid.UUID

	mu      sync.RWMutex
	clients map[*client]struct{}

	// Серверная копия документа (Фаза 3). docMu защищает документ, флаг «есть что
	// сохранять» и автора последней правки; clients/му — отдельная блокировка,
	// потому что рассылка идёт под ней, а применение апдейта — нет.
	docMu  sync.Mutex
	doc    *yjs.Doc
	dirty  bool
	lastBy uuid.UUID
	// loading предотвращает параллельные загрузки документа, когда в комнату
	// одновременно заходят несколько клиентов.
	loading bool
	// migratedEvents — сколько событий было при последней проверке миграции текста.
	migratedEvents int
	// projectionSignature — подпись последней удачной проекции дерева: по ней
	// понимаем, что структура и текст не менялись и писать в таблицу нечего.
	projectionSignature string
}

func (r *Room) HasClients() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients) > 0
}

// ensureDoc загружает снапшот проекта в серверный документ (один раз на комнату).
//
// Ошибку загрузки не запоминаем навсегда: если база мигнула, следующий вошедший
// клиент попробует снова, а комната без документа просто ничего не сохраняет —
// клиенты в этом случае пишут снапшот по REST, как до Фазы 3.
func (r *Room) ensureDoc(ctx context.Context, ev *events.Service, userID, projectID uuid.UUID) {
	r.docMu.Lock()
	if r.doc != nil || r.loading {
		r.docMu.Unlock()
		return
	}
	r.loading = true
	r.docMu.Unlock()

	state, _, err := ev.GetYjsState(ctx, userID, projectID)
	var doc *yjs.Doc
	if err == nil {
		doc, err = yjs.FromState(state)
	}

	r.docMu.Lock()
	r.loading = false
	if err != nil {
		r.docMu.Unlock()
		return
	}
	r.doc = doc
	r.migratedEvents = doc.EventCount()
	// Миграция старого текста — здесь, а не на клиенте: сервер единственный
	// писатель, поэтому ветка Y.Text на ключе ровно одна. Клиент, создавший её
	// сам, рисковал проиграть LWW соседу, сделавшему то же самое одновременно.
	if created := doc.EnsureTextFields(); created > 0 {
		r.dirty = true
	}
	r.docMu.Unlock()
}

// state — полное состояние документа комнаты (пусто, если документ не загружен).
func (r *Room) state() []byte {
	r.docMu.Lock()
	defer r.docMu.Unlock()
	if r.doc == nil {
		return nil
	}
	return r.doc.EncodeState()
}

// applyUpdate применяет апдейт клиента к серверному документу.
//
// Ошибка означает, что апдейт не наш (битый или чужой формат): рассылать его
// дальше нельзя — у остальных он тоже не применится, а клиент считал бы, что
// правку приняли. Валидные, но «ранние» апдейты (не хватает причин-предков) Yjs
// ставит в очередь и применит позже, так что отдельного случая для них нет.
//
// Второе возвращаемое значение — «сервер мигрировал текст»: событие появилось без
// `title_text`/`body_text` (засев из базы, импорт, старое событие), и поля завёл
// сервер. Такую правку нужно разослать всем: иначе клиент остался бы со скалярной
// строкой и, начав печатать, создал бы свою ветку `Y.Text` — то есть ровно ту
// гонку, из-за которой миграция и переехала на сервер.
func (r *Room) applyUpdate(by uuid.UUID, data []byte) (bool, error) {
	r.docMu.Lock()
	defer r.docMu.Unlock()
	if r.doc == nil {
		// Документа нет (не загрузился): не мешаем релею работать как раньше.
		return false, nil
	}
	if err := r.doc.Apply(data); err != nil {
		return false, err
	}
	r.dirty = true
	r.lastBy = by

	// Миграция перепроверяется только при изменении числа событий: полный обход
	// документа на каждой букве не нужен, а появление события её как раз и требует.
	migrated := false
	if count := r.doc.EventCount(); count != r.migratedEvents {
		if created := r.doc.EnsureTextFields(); created > 0 {
			r.dirty = true
			migrated = true
		}
		r.migratedEvents = count
	}
	return migrated, nil
}

// projectionPayload собирает узлы проекции из серверного документа и их подпись.
//
// Повторяет то, что клиент делал в `yFlatTree`: порядок — как в массиве, родитель —
// из `parent_id`. Дополнительно чиним структуру, которую `NormalizeTree` иначе
// отвергнет: родитель вне набора и циклы поднимаются в корень. Клиент делал это у
// себя (`yRepairHierarchy`), но проекция теперь идёт с сервера, и «застрявшее»
// дерево остановило бы синхронизацию таблицы событий целиком.
func projectionPayload(doc *yjs.Doc) ([]events.NodeInput, string) {
	rows := doc.Events()
	ids := make(map[uuid.UUID]bool, len(rows))
	for _, e := range rows {
		if id, err := uuid.Parse(e.ID); err == nil {
			ids[id] = true
		}
	}

	h := fnv.New64a()
	nodes := make([]events.NodeInput, 0, len(rows))

	for _, e := range rows {
		id, err := uuid.Parse(e.ID)
		if err != nil {
			continue
		}
		var parent *uuid.UUID
		if pid, err := uuid.Parse(e.ParentID); err == nil && pid != id && ids[pid] {
			parent = &pid
		}
		nodes = append(nodes, events.NodeInput{
			ID:       id,
			ParentID: parent,
			Position: e.Position,
			Title:    e.Title,
			Body:     e.Body,
			EventDate: events.EventDatePatch{
				Set:   true,
				Value: parseEventDate(e.EventDate),
			},
		})
	}

	// Циклы: узел, чей предок указывает на него, поднимаем в корень.
	nodes = repairProjectionNodes(nodes)
	for _, n := range nodes {
		parent := ""
		if n.ParentID != nil {
			parent = n.ParentID.String()
		}
		date := ""
		if n.EventDate.Value != nil {
			date = n.EventDate.Value.Format("2006-01-02")
		}
		// Подпись по всему, что попадает в таблицу событий: и структура, и текст,
		// и дата. Если ничего не изменилось — проекцию не пишем.
		fmt.Fprintf(h, "%s|%s|%d|%s|%s|%s\n", n.ID, parent, n.Position, n.Title, n.Body, date)
	}
	return nodes, strconv.FormatUint(h.Sum64(), 16)
}

// repairProjectionNodes поднимает в корень узлы, которых нормализация не примет:
// родителя нет в наборе (сирота) или цепочка родителей замыкается на сам узел.
func repairProjectionNodes(nodes []events.NodeInput) []events.NodeInput {
	ids := make(map[uuid.UUID]bool, len(nodes))
	parentOf := make(map[uuid.UUID]uuid.UUID, len(nodes))
	for _, n := range nodes {
		ids[n.ID] = true
	}
	for _, n := range nodes {
		if n.ParentID != nil && ids[*n.ParentID] && *n.ParentID != n.ID {
			parentOf[n.ID] = *n.ParentID
		} else {
			parentOf[n.ID] = uuid.Nil
		}
	}

	for i := range nodes {
		seen := map[uuid.UUID]bool{nodes[i].ID: true}
		cur := parentOf[nodes[i].ID]
		for cur != uuid.Nil {
			if seen[cur] {
				parentOf[nodes[i].ID] = uuid.Nil
				break
			}
			seen[cur] = true
			next, ok := parentOf[cur]
			if !ok {
				// Родитель вне набора — сирота, поднимаем в корень.
				parentOf[nodes[i].ID] = uuid.Nil
				break
			}
			cur = next
		}
	}

	for i := range nodes {
		if parentOf[nodes[i].ID] == uuid.Nil {
			nodes[i].ParentID = nil
			continue
		}
		parent := parentOf[nodes[i].ID]
		nodes[i].ParentID = &parent
	}
	return nodes
}

// parseEventDate читает дату из CRDT («YYYY-MM-DD»). Пустая или непонятная строка
// означает «даты нет» — сервер дату не выдумывает.
func parseEventDate(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return nil
	}
	return &parsed
}

// broadcastState рассылает всем в комнате полное состояние документа.
//
// Нужно после серверной миграции текста и при подключении: разницы по вектору
// состояния мы пока не считаем, а состояние проекта — десятки килобайт, и такие
// рассылки редки (появление события, миграция).
func (r *Room) broadcastState() {
	state := r.state()
	if len(state) == 0 {
		return
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for c := range r.clients {
		select {
		case c.send <- state:
		default:
			// Тот же принцип, что и в broadcast: медленный клиент переподключится
			// и получит состояние заново, вместо того чтобы остаться с устаревшим.
			_ = c.conn.Close()
		}
	}
}

// persistFromAnyClient сохраняет слитое состояние комнаты в базу (один писатель)
// и переносит структуру в реляционную проекцию.
//
// Флаг «грязно» снимается ДО записи: апдейт, пришедший во время сохранения, снова
// его поставит, и следующий тик запишет и его. Обратный порядок потерял бы правку,
// пришедшую в окне между кодированием и записью.
func (r *Room) persistFromAnyClient(ctx context.Context, ev *events.Service, logger *slog.Logger) {
	r.docMu.Lock()
	doc, dirty, by := r.doc, r.dirty, r.lastBy
	if doc == nil {
		r.docMu.Unlock()
		return
	}
	// Проекцию читаем из того же состояния, что уходит в снапшот: иначе они
	// разъехались бы (в снапшоте одна структура, в таблице событий другая).
	nodes, signature := projectionPayload(doc)
	r.docMu.Unlock()

	if dirty {
		r.docMu.Lock()
		state := doc.EncodeState()
		r.dirty = false
		r.docMu.Unlock()
		if _, err := ev.SaveYjsStateServer(ctx, r.projectID, by, state); err != nil {
			// Не сохранилось — вернуть флаг: следующий тик попробует снова.
			r.docMu.Lock()
			r.dirty = true
			r.docMu.Unlock()
			logger.Warn("collab: snapshot save failed", "project", r.projectID, "err", err)
		}
	}

	// Проекция дерева (Фаза 4): строки `events` собираются из серверного документа,
	// поэтому клиент больше не обязан присылать структуру. Подпись сравниваем с
	// прошлой — на каждом тике переписывать все строки проекта незачем; текст
	// заголовков и тел входит в подпись, так что правки текста тоже доезжают.
	r.docMu.Lock()
	unchanged := signature == r.projectionSignature
	r.docMu.Unlock()
	if unchanged {
		return
	}

	if err := ev.ProjectTreeServer(ctx, r.projectID, by, nodes); err != nil {
		// Дерево не прошло проверку (цикл, глубина, чужой родитель) или база
		// недоступна: оставляем прошлую проекцию и попробуем на следующем тике.
		// Подпись НЕ обновляем — иначе повторной попытки не будет.
		logger.Warn("collab: tree projection failed", "project", r.projectID, "err", err)
		return
	}
	logger.Debug("collab: tree projected", "project", r.projectID, "events", len(nodes))
	r.docMu.Lock()
	r.projectionSignature = signature
	r.docMu.Unlock()
}

// broadcast — рассылает обновление всем клиентам в комнате кроме отправителя.
//
// Если у клиента переполнен буфер отправки (медленная сеть, замерший скрипт), его
// соединение рвётся, а не «проглатывает» апдейт: молча потерянная дельта оставила
// бы вкладку с устаревшим документом до перезагрузки, а после разрыва клиент
// переподключается и получает состояние комнаты целиком.
func (r *Room) broadcast(from *client, msg []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for c := range r.clients {
		if c == from {
			continue
		}
		select {
		case c.send <- msg:
		default:
			_ = c.conn.Close()
		}
	}
}

// client — одно WS-соединение.
type client struct {
	conn      *websocket.Conn
	send      chan []byte
	userID    uuid.UUID
	projectID uuid.UUID
	room      *Room
	closed    chan struct{}
	// canWrite — роль editor+ на момент подключения. Наблюдателю CRDT-апдейты
	// писать нельзя: это был бы обход проверки прав REST-ручек.
	canWrite bool
}

func (c *client) reader(h *Hub) {
	defer func() {
		h.leave(c)
		_ = c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		mt, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		// любые сообщения (text/binary) — relay
		_ = mt
		if len(data) == 0 {
			continue
		}
		// Кадр присутствия документом не является: он едет тем же сокетом и
		// релеится всем — в том числе от наблюдателя, который тоже присутствует в
		// проекте, хоть и не пишет.
		if bytes.HasPrefix(data, []byte(presencePrefix)) {
			c.room.broadcast(c, data)
			continue
		}
		// Наблюдатель прав не имеет: его апдейты не применяем и не рассылаем —
		// иначе он менял бы документ в обход проверки прав REST-ручек.
		if !c.canWrite {
			h.logger.Warn("collab: update from read-only client ignored",
				"project", c.projectID, "user", c.userID, "bytes", len(data))
			continue
		}
		// Апдейт сначала применяется к серверному документу (из него пишется
		// снапшот), и только применённый уходит остальным: битые байты им тоже
		// не подойдут, а клиент-отправитель считал бы правку принятой.
		migrated, err := c.room.applyUpdate(c.userID, data)
		if err != nil {
			// Отброшенный апдейт — всегда повод посмотреть: у клиента правка
			// есть, а в снапшот она не попадёт.
			h.logger.Warn("collab: update rejected",
				"project", c.projectID, "user", c.userID, "bytes", len(data), "err", err)
			continue
		}
		c.room.broadcast(c, data)
		if migrated {
			// Сервер завёл текстовые поля — об этом должны узнать все, иначе клиент
			// продолжит писать в скалярную строку и создаст свою ветку Y.Text.
			c.room.broadcastState()
		}
	}
}

func (c *client) writer() {
	tick := time.NewTicker(pingPeriod)
	defer func() {
		tick.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
		case <-tick.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.closed:
			return
		}
	}
}

// projectIDFromPath — последний значимый сегмент пути /api/projects/{id}/collab.
func projectIDFromPath(p string) string {
	s := strings.TrimPrefix(p, "/api/projects/")
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	return s
}
