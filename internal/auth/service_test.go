package auth

import (
	"testing"
	"time"

	"highload-ws-pubsub/internal/config"
)

func TestIssueAndVerifyToken(t *testing.T) {
	t.Parallel()

	service := NewService(config.Config{
		AuthEnabled:  true,
		AuthIssuer:   "test",
		AuthTokenTTL: time.Hour,
		AuthSecret:   "secret",
		APIKeys:      map[string]string{"frontend": "dev-secret"},
	}, nil)

	token, issued, err := service.IssueToken("frontend", "dev-secret")
	if err != nil {
		t.Fatalf("IssueToken() error = %v", err)
	}
	if token == "" {
		t.Fatal("IssueToken() returned empty token")
	}

	verified, err := service.VerifyToken(token)
	if err != nil {
		t.Fatalf("VerifyToken() error = %v", err)
	}
	if verified.ClientID != issued.ClientID {
		t.Fatalf("ClientID = %q, want %q", verified.ClientID, issued.ClientID)
	}
	if !service.HasScope(verified, "publish") {
		t.Fatal("verified principal does not have publish scope")
	}
}

func TestIssueTokenRejectsInvalidCredentials(t *testing.T) {
	t.Parallel()

	service := NewService(config.Config{
		AuthIssuer:   "test",
		AuthTokenTTL: time.Hour,
		AuthSecret:   "secret",
		APIKeys:      map[string]string{"frontend": "dev-secret"},
	}, nil)

	if _, _, err := service.IssueToken("frontend", "wrong"); err == nil {
		t.Fatal("IssueToken() error = nil, want invalid credentials")
	}
}
