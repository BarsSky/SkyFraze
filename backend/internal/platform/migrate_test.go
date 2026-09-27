package platform

import (
	"testing"
	"testing/fstest"
)

func TestListMigrations_SortedAndFiltered(t *testing.T) {
	fsys := fstest.MapFS{
		"0001_init.up.sql":             {Data: []byte("SELECT 1")},
		"0002_events_hierarchy.up.sql": {Data: []byte("SELECT 2")},
		"0001_init.down.sql":           {Data: []byte("SELECT 3")},
		"migrations.go":                {Data: []byte("package migrations")},
		"nested/0010_extra.up.sql":     {Data: []byte("SELECT 4")},
	}
	got, err := listMigrations(fsys)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"0001_init.up.sql", "0002_events_hierarchy.up.sql"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

func TestListMigrations_Empty(t *testing.T) {
	got, err := listMigrations(fstest.MapFS{"readme.md": {Data: []byte("x")}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no migrations, got %v", got)
	}
}

// Регресс-тест на исходный баг: embed с паттерном migrations/*.sql давал
// FS-корень с одной директорией, поэтому список миграций оказывался пустым и
// схема не применялась вообще.
func TestListMigrations_DirectoryEntryIsNotAMigration(t *testing.T) {
	fsys := fstest.MapFS{
		"migrations/0001_init.up.sql": {Data: []byte("SELECT 1")},
	}
	got, err := listMigrations(fsys)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("вложенная директория не должна попадать в список миграций, got %v", got)
	}
}
