package files

import (
	"context"
	"io"

	"highload-ws-pubsub/internal/config"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type S3Store struct {
	client *minio.Client
	bucket string
}

func NewS3Store(ctx context.Context, cfg config.Config) (*S3Store, error) {
	client, err := minio.New(cfg.S3Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""),
		Secure: cfg.S3UseSSL,
	})
	if err != nil {
		return nil, err
	}
	exists, err := client.BucketExists(ctx, cfg.S3Bucket)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.S3Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, err
		}
	}
	return &S3Store{client: client, bucket: cfg.S3Bucket}, nil
}

func (s *S3Store) Put(ctx context.Context, reader io.Reader, size int64) (StoredFile, error) {
	fileID := newID()
	_, err := s.client.PutObject(ctx, s.bucket, fileID, reader, size, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		return StoredFile{}, err
	}
	return StoredFile{FileID: fileID, Size: size}, nil
}

func (s *S3Store) Get(ctx context.Context, fileID string) (io.ReadCloser, int64, error) {
	object, err := s.client.GetObject(ctx, s.bucket, fileID, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	info, err := object.Stat()
	if err != nil {
		_ = object.Close()
		return nil, 0, err
	}
	return object, info.Size, nil
}
