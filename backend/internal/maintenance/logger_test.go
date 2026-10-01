package maintenance_test

import (
	"io"
	"log/slog"
	"testing"
)

// testLogger — логгер уборщика без вывода: отчёт проверяем по структуре, а не по
// строкам в логе (строки видит оператор на стенде).
func testLogger(t *testing.T) *slog.Logger {
	t.Helper()
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}
