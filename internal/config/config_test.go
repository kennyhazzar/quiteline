package config

import "testing"

func TestValidateProductionRejectsWeakSecret(t *testing.T) {
	t.Parallel()

	cfg := Config{
		Production:         true,
		AuthEnabled:        true,
		AuthSecret:         "local-compose-secret-change-me",
		PostgresDSN:        "postgres://example",
		CORSAllowedOrigins: []string{"https://chat.example.com"},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want weak secret error")
	}
}

func TestValidateProductionRejectsHTTPOrigin(t *testing.T) {
	t.Parallel()

	cfg := Config{
		Production:         true,
		AuthEnabled:        true,
		AuthSecret:         "0123456789abcdef0123456789abcdef",
		PostgresDSN:        "postgres://example",
		CORSAllowedOrigins: []string{"http://chat.example.com"},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want http origin error")
	}
}

func TestValidateAllowsDevelopmentDefaults(t *testing.T) {
	t.Parallel()

	cfg := Config{
		Production:         false,
		AuthEnabled:        true,
		AuthSecret:         "local-compose-secret-change-me",
		CORSAllowedOrigins: []string{"http://localhost:3000"},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
}
