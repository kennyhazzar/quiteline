package ws

import "testing"

func TestNormalizeTopic(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "plain", input: "general", want: "general"},
		{name: "trim slashes", input: "/general/", want: "general"},
		{name: "reject spaces", input: "general chat", want: ""},
		{name: "reject tabs", input: "general\tchat", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeTopic(tt.input); got != tt.want {
				t.Fatalf("normalizeTopic(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestRoomIDFromTopic(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		id   string
		ok   bool
	}{
		{name: "room topic", in: "room:abc123", id: "abc123", ok: true},
		{name: "non room topic", in: "general", ok: false},
		{name: "empty room", in: "room:", ok: true},
		{name: "path traversal shape", in: "room:abc/def", ok: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			id, ok := roomIDFromTopic(tt.in)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if id != tt.id {
				t.Fatalf("id = %q, want %q", id, tt.id)
			}
		})
	}
}

func TestUserIDFromTopic(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		id   string
		ok   bool
	}{
		{name: "user topic", in: "user:abc123", id: "abc123", ok: true},
		{name: "non user topic", in: "room:abc123", ok: false},
		{name: "empty user", in: "user:", ok: true},
		{name: "path traversal shape", in: "user:abc/def", ok: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			id, ok := userIDFromTopic(tt.in)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if id != tt.id {
				t.Fatalf("id = %q, want %q", id, tt.id)
			}
		})
	}
}
