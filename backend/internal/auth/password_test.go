package auth

import "testing"

func TestHashPassword_TooShort(t *testing.T) {
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("expected error for short password")
	}
}

func TestHashPassword_Verify(t *testing.T) {
	hash, err := HashPassword("supersecret")
	if err != nil {
		t.Fatalf("hash err: %v", err)
	}
	if err := VerifyPassword(hash, "supersecret"); err != nil {
		t.Fatalf("verify same pwd should succeed: %v", err)
	}
	if err := VerifyPassword(hash, "wrongpass"); err == nil {
		t.Fatal("verify wrong pwd should fail")
	}
}
