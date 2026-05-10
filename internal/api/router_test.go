package api

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"highload-ws-pubsub/internal/auth"
	"highload-ws-pubsub/internal/zk"
)

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

func TestCanPublishTopic(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := zk.NewMemoryStore()
	if _, err := store.CreateRoom(ctx, zk.Room{RoomID: "room-1", Name: "room", Members: []string{"user-1"}}); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	deps := Dependencies{
		ZKStore: store,
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	tests := []struct {
		name      string
		principal auth.Principal
		topic     string
		want      bool
	}{
		{name: "general topic denied", principal: auth.Principal{UserID: "user-1"}, topic: "general", want: false},
		{name: "own user topic", principal: auth.Principal{UserID: "user-1"}, topic: "user:user-1", want: true},
		{name: "other user topic", principal: auth.Principal{UserID: "user-1"}, topic: "user:user-2", want: false},
		{name: "room member", principal: auth.Principal{UserID: "user-1"}, topic: "room:room-1", want: true},
		{name: "room non member", principal: auth.Principal{UserID: "user-2"}, topic: "room:room-1", want: false},
		{name: "invalid room topic", principal: auth.Principal{UserID: "user-1"}, topic: "room:bad/path", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := canPublishTopic(ctx, deps, tt.principal, tt.topic); got != tt.want {
				t.Fatalf("canPublishTopic() = %v, want %v", got, tt.want)
			}
		})
	}
}
