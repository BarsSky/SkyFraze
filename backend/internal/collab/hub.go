// Package collab — WebSocket-relay для Yjs.
//
// Протокол:
//   1) клиент шлёт HTTP Upgrade на /api/projects/{id}/collab?token=<JWT>
//   2) после Upgrade — bidirectional поток бинарных Yjs-апдейтов (ws.BinaryMessage)
//   3) периодический snapshot каждой активной комнаты сохраняется в Postgres
//
// Hub держит in-memory rooms per project. CRDT разрешает конфликты на клиенте;
// сервер только маршрутизирует байты и сохраняет снапшоты.
package collab

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/events"
)

const (
	writeWait         = 10 * time.Second
	pongWait          = 60 * time.Second
	pingPeriod        = (pongWait * 9) / 10
	snapshotPeriod    = 30 * time.Second
	maxMessageSize    = 16 * 1024 * 1024
	closePolicyFailed = 4401
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

func NewHub(logger *slog.Logger, secret string, ev *events.Service) *Hub {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
	return &Hub{
		logger:   logger,
		secret:   secret,
		ev:       ev,
		upgrader: upgrader,
		rooms:    make(map[uuid.UUID]*Room),
	}
}

// Run — фоновая задача snapshot-периодичности.
func (h *Hub) Run(ctx context.Context) {
	t := time.NewTicker(snapshotPeriod)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
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
		if r.HasClients() {
			r.persistFromAnyClient(ctx, h.ev)
		}
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
	}
	room.mu.Lock()
	room.clients[c] = struct{}{}
	room.mu.Unlock()

	// отправим последний снапшот подключившемуся
	if state, err := h.ev.GetYjsState(context.Background(), userID, projectID); err == nil && len(state) > 0 {
		select {
		case c.send <- state:
		default:
		}
	}
	return c
}

func (h *Hub) leave(c *client) {
	c.room.mu.Lock()
	if _, ok := c.room.clients[c]; ok {
		delete(c.room.clients, c)
		close(c.closed)
	}
	c.room.mu.Unlock()
	h.removeIfEmpty(c.projectID)
}

// Room — одна комната.
type Room struct {
	projectID uuid.UUID

	mu      sync.RWMutex
	clients map[*client]struct{}
}

func (r *Room) HasClients() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients) > 0
}

// persistFromAnyClient — best-effort snapshot.
func (r *Room) persistFromAnyClient(_ context.Context, _ *events.Service) {
	// В MVP серверный merge Yjs-апдейтов не реализован (требует y-go bindings).
	// Реальный snapshot пишется из REST PUT /state.
	// Здесь — заглушка, которая лишь проверяет, что в комнате есть клиенты.
	_ = r
}

// broadcast — рассылает обновление всем клиентам в комнате кроме отправителя.
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
		c.room.broadcast(c, data)
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
