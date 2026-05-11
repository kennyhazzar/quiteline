package notifications

import "errors"

var (
	ErrBadRequest = errors.New("bad request")
	ErrNotFound   = errors.New("not found")
)
