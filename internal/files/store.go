package files

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"time"
)

type StoredFile struct {
	FileID string `json:"fileId"`
	Size   int64  `json:"size"`
}

type Store interface {
	Put(ctx context.Context, reader io.Reader, size int64) (StoredFile, error)
	Get(ctx context.Context, fileID string) (io.ReadCloser, int64, error)
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}
