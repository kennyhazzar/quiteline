package api

import "testing"

func TestTopicFromPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		path  string
		topic string
		ok    bool
	}{
		{name: "valid", path: "/v1/topics/general/messages", topic: "general", ok: true},
		{name: "nested topic", path: "/v1/topics/chat/room-1/messages", topic: "chat/room-1", ok: true},
		{name: "missing suffix", path: "/v1/topics/general", ok: false},
		{name: "empty topic", path: "/v1/topics//messages", ok: false},
		{name: "space", path: "/v1/topics/general chat/messages", ok: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			topic, ok := topicFromPath(tt.path)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if topic != tt.topic {
				t.Fatalf("topic = %q, want %q", topic, tt.topic)
			}
		})
	}
}
