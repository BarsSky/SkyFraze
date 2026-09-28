package store_test

import (
	"strings"
	"testing"

	"github.com/skyfraze/backend/internal/store"
)

func TestNormalizeUsername(t *testing.T) {
	cases := map[string]string{
		"Anna":             "anna",
		"@anna":            "anna",
		"  @Anna.Design  ": "anna.design",
		"anna_design":      "anna_design",
		"anna-design":      "anna-design",
		"a b c":            "abc",
		"!!!":              "",
		"аня":              "",
		"anna!":            "anna",
		".anna.":           "anna",
		"anna--":           "anna",
	}
	for in, want := range cases {
		if got := store.NormalizeUsername(in); got != want {
			t.Errorf("NormalizeUsername(%q) = %q, ожидалось %q", in, got, want)
		}
	}
	long := strings.Repeat("a", 40)
	if got := store.NormalizeUsername(long); len(got) != 32 {
		t.Errorf("длинный ник обрезан до %d символов, ожидалось 32", len(got))
	}
}

func TestValidUsername(t *testing.T) {
	// Пробелы по краям и @ в начале — то, что человек копирует из интерфейса:
	// они допустимы и просто отбрасываются при сохранении.
	valid := []string{"anna", "Anna", "@anna", " anna ", "anna.design", "a_1-b", strings.Repeat("a", 32)}
	for _, in := range valid {
		if !store.ValidUsername(in) {
			t.Errorf("ValidUsername(%q) = false, ожидалось true", in)
		}
	}
	invalid := []string{"an", "", "@", "аня", "anna!", "a b", "anna.", strings.Repeat("a", 33), "%"}
	for _, in := range invalid {
		if store.ValidUsername(in) {
			t.Errorf("ValidUsername(%q) = true, ожидалось false", in)
		}
	}
}
