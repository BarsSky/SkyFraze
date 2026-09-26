package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestIssueParseAccess(t *testing.T) {
	uid := uuid.New()
	secret := "test-secret"
	tok, err := IssueAccess(secret, uid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := ParseAccess(secret, tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.UserID != uid {
		t.Errorf("user id mismatch: %s vs %s", claims.UserID, uid)
	}
}

func TestParseAccess_WrongSecret(t *testing.T) {
	uid := uuid.New()
	tok, _ := IssueAccess("secret1", uid)
	if _, err := ParseAccess("secret2", tok); err == nil {
		t.Fatal("expected parse error with wrong secret")
	}
}

func TestIssueParseRefresh(t *testing.T) {
	uid := uuid.New()
	tok, jti, err := IssueRefresh("s", uid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	gotUID, gotJTI, err := ParseRefresh("s", tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if gotUID != uid {
		t.Errorf("uid mismatch: %s vs %s", gotUID, uid)
	}
	if gotJTI != jti {
		t.Errorf("jti mismatch: %s vs %s", gotJTI, jti)
	}
}

func TestParseRefresh_AccessTokenRejected(t *testing.T) {
	uid := uuid.New()
	accessTok, _ := IssueAccess("s", uid)
	if _, _, err := ParseRefresh("s", accessTok); err == nil {
		t.Fatal("access token should not parse as refresh")
	}
}

func TestClaims_AccessExpiresAfter15Min(t *testing.T) {
	uid := uuid.New()
	tok, err := IssueAccess("s", uid)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseAccess("s", tok)
	if err != nil {
		t.Fatal(err)
	}
	if !c.ExpiresAt.After(time.Now().Add(14 * time.Minute)) {
		t.Errorf("access ttl should be ~15m, got %v", c.ExpiresAt.Time.Sub(time.Now()))
	}
}
