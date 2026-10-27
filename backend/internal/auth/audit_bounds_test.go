package auth_test

// audit_bounds_test.go — верхние границы журнала входов (0.72.0).
//
// Срок хранения объём не ограничивает: бот, долбящийся в аккаунт, пишет тысячи строк в сутки.
// Здесь проверяются две границы — подавление повторов (одинаковое событие с того же адреса в
// пределах минуты пишется один раз) и потолок на человека (уборщик оставляет свежие записи).

import (
	"context"
	"testing"
	"time"

	"github.com/skyfraze/backend/internal/auth"
)

// Повтор того же события с того же адреса не пишется второй раз.
func TestLoginAuditSuppressesRepeats(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()

	// Три попытки с одним паролем подряд: в журнале должна остаться одна строка.
	for i := 0; i < 3; i++ {
		if _, _, err := e.svc.Login(ctx, "author@example.com", "WRONG", testMeta); err == nil {
			t.Fatal("ожидался отказ")
		}
	}
	list := e.entries(t)
	if len(list) != 1 {
		t.Fatalf("ожидалась одна запись вместо трёх: %+v", list)
	}
	if list[0].Outcome != "bad_password" {
		t.Fatalf("исход: %+v", list[0])
	}
}

// Другой адрес и другой исход — отдельные записи: подавление не должно склеивать разное.
func TestLoginAuditSuppressionIsSpecific(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	other := auth.LoginMeta{IP: "198.51.100.9", UserAgent: testMeta.UserAgent}

	if _, _, err := e.svc.Login(ctx, "author@example.com", "WRONG", testMeta); err == nil {
		t.Fatal("ожидался отказ")
	}
	if _, _, err := e.svc.Login(ctx, "author@example.com", "WRONG", other); err == nil {
		t.Fatal("ожидался отказ")
	}
	// Успешный вход — другой исход, он пишется даже сразу после отказа с того же адреса.
	if _, _, err := e.svc.Login(ctx, "author@example.com", "hunter22!", testMeta); err != nil {
		t.Fatalf("вход: %v", err)
	}
	list := e.entries(t)
	if len(list) != 3 {
		t.Fatalf("ожидались три записи (два адреса и успех): %+v", list)
	}
}

// Потолок на человека: уборщик оставляет свежие записи.
func TestTrimLoginAudit(t *testing.T) {
	e := setupAudit(t)
	ctx := context.Background()
	// Пять записей «вручную»: сервис подавляет повторы, а нам нужен именно объём.
	for i := 0; i < 5; i++ {
		if _, err := e.st.Pool.Exec(ctx,
			`INSERT INTO login_audit (user_id, outcome, factor, ip, created_at)
			 VALUES ($1, 'ok', 'password', $2, now() - make_interval(mins => $3))`,
			e.user, "203.0.113."+string(rune('1'+i)), 10-i); err != nil {
			t.Fatalf("запись %d: %v", i, err)
		}
	}
	trimmed, err := e.st.TrimLoginAudit(ctx, 2)
	if err != nil {
		t.Fatalf("подрезка: %v", err)
	}
	if trimmed != 3 {
		t.Fatalf("подрезано %d, ожидалось 3", trimmed)
	}
	list := e.entries(t)
	if len(list) != 2 {
		t.Fatalf("осталось %d записей, ожидалось 2: %+v", len(list), list)
	}
	// Остались СВЕЖИЕ: последняя вставка (i=4) была 6 минут назад — её адрес .5.
	if list[0].IP != "203.0.113.5" {
		t.Fatalf("оставлена не свежая запись: %+v", list)
	}
	// Нулевой предел ничего не трогает: это защита от «случайно очистить всё».
	if trimmed, err := e.st.TrimLoginAudit(ctx, 0); err != nil || trimmed != 0 {
		t.Fatalf("предел 0: обрезано %d, ошибка %v", trimmed, err)
	}
}

// Константы — часть контракта: их видит уборщик и документация.
func TestLoginAuditLimits(t *testing.T) {
	if auth.LoginAuditPerUser != 200 {
		t.Fatalf("потолок на человека: %d", auth.LoginAuditPerUser)
	}
	if auth.LoginAuditRetention != 90*24*time.Hour {
		t.Fatalf("срок хранения: %v", auth.LoginAuditRetention)
	}
}
