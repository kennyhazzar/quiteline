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
