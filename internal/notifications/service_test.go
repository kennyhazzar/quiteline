package notifications

import "testing"

func TestNormalizeVAPIDSubject(t *testing.T) {
	tests := map[string]string{
		"admin@example.com":         "admin@example.com",
		"mailto:admin@example.com":  "admin@example.com",
		" MAILTO:admin@example.com": "admin@example.com",
		"https://example.com/push":  "https://example.com/push",
	}

	for input, want := range tests {
		if got := normalizeVAPIDSubject(input); got != want {
			t.Fatalf("normalizeVAPIDSubject(%q) = %q, want %q", input, got, want)
		}
	}
}
