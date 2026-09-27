package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/auth"
	"github.com/skyfraze/backend/internal/platform"
	"github.com/skyfraze/backend/internal/platform/testdb"
	"github.com/skyfraze/backend/internal/store"
)

func setupService(t *testing.T) (*auth.Service, *store.Store, func()) {
	t.Helper()
	ctx := context.Background()
	pool := testdb.Setup(t, "auth")

	// Тесты здесь проверяют механику register/login/refresh, а не режим доступа:
	// переводим инсталляцию в открытую регистрацию, иначе /register отвечает 403.
	st := store.New(pool)
	if err := st.SetSetting(ctx, store.SettingRegistrationMode, store.RegistrationModeOpen, uuid.Nil); err != nil {
		t.Fatalf("registration mode: %v", err)
	}
	testdb.Truncate(t, pool,
		"registration_requests", "app_settings", "project_ratings", "project_views",
		"project_event_state", "sessions", "invitations", "event_assets", "assets",
		"events", "team_memberships", "projects", "users")
	// Truncate снёс и настройку — возвращаем открытый режим после очистки.
	if err := st.SetSetting(ctx, store.SettingRegistrationMode, store.RegistrationModeOpen, uuid.Nil); err != nil {
		t.Fatalf("registration mode: %v", err)
	}

	svc := auth.New(st, "test-secret-please-change")
	return svc, st, func() { pool.Close() }
}

func TestService_Register(t *testing.T) {
	svc, _, teardown := setupService(t)
	defer teardown()

	u, tok, err := svc.Register(context.Background(), "Alice@Example.com", "hunter22!", "Alice")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if u.Email != "alice@example.com" {
		t.Errorf("email lowercased expected, got %q", u.Email)
	}
	if tok.Access == "" || tok.Refresh == "" {
		t.Error("tokens missing")
	}
	if tok.AccessExp.Before(time.Now().Add(14 * time.Minute)) {
		t.Errorf("access TTL too short: %v", tok.AccessExp.Sub(time.Now()))
	}
}

func TestService_Register_DuplicateEmail(t *testing.T) {
	svc, _, teardown := setupService(t)
	defer teardown()

	_, _, err := svc.Register(context.Background(), "bob@example.com", "hunter22!", "Bob")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	_, _, err = svc.Register(context.Background(), "bob@example.com", "hunter22!", "Bob 2")
	if err != auth.ErrEmailTaken {
		t.Errorf("expected ErrEmailTaken, got %v", err)
	}
}

func TestService_Login_WrongPassword(t *testing.T) {
	svc, _, teardown := setupService(t)
	defer teardown()

	if _, _, err := svc.Register(context.Background(), "carol@example.com", "hunter22!", "Carol"); err != nil {
		t.Fatal(err)
	}
	_, _, err := svc.Login(context.Background(), "carol@example.com", "WRONG")
	if err != auth.ErrInvalidCreds {
		t.Errorf("expected ErrInvalidCreds, got %v", err)
	}
}

func TestService_Refresh_Roundtrip(t *testing.T) {
	svc, _, teardown := setupService(t)
	defer teardown()

	_, tok1, err := svc.Register(context.Background(), "dan@example.com", "hunter22!", "Dan")
	if err != nil {
		t.Fatal(err)
	}
	tok2, err := svc.Refresh(context.Background(), tok1.Refresh)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if tok2.Access == "" {
		t.Error("empty access token in tok2")
	}
	if tok2.Refresh == "" {
		t.Error("empty refresh token in tok2")
	}
	if tok2.Refresh == tok1.Refresh {
		t.Error("tok2.Refresh should differ from tok1.Refresh")
	}
	if _, err := svc.Refresh(context.Background(), tok1.Refresh); err == nil {
		t.Error("expected error replaying revoked refresh")
	}
}

type tokensResp struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
}

type authResp struct {
	Tokens tokensResp `json:"tokens"`
}

func TestHandler_EndToEnd(t *testing.T) {
	svc, st, teardown := setupService(t)
	defer teardown()

	logger := platform.NewLogger("test")
	h := auth.NewHandler(svc, st, logger)

	mux := http.NewServeMux()
	mux.Handle("POST /api/auth/register", http.HandlerFunc(h.Register))
	mux.Handle("POST /api/auth/login", http.HandlerFunc(h.Login))
	mux.Handle("GET /api/auth/me", svc.WithUser(http.HandlerFunc(h.Me)))

	srv := httptest.NewServer(mux)
	defer srv.Close()

	body := `{"email":"e@e.com","password":"hunter22!","display_name":"E"}`
	resp, err := http.Post(srv.URL+"/api/auth/register", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 201 {
		t.Fatalf("register status: %d", resp.StatusCode)
	}
	var reg authResp
	if err := json.NewDecoder(resp.Body).Decode(&reg); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if reg.Tokens.Access == "" {
		t.Fatal("empty access token")
	}

	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+reg.Tokens.Access)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp2.StatusCode != 200 {
		t.Fatalf("/me status: %d", resp2.StatusCode)
	}
	resp2.Body.Close()

	resp3, err := http.Get(srv.URL + "/api/auth/me")
	if err != nil {
		t.Fatal(err)
	}
	if resp3.StatusCode != 401 {
		t.Errorf("/me no token: %d", resp3.StatusCode)
	}
	resp3.Body.Close()
}
