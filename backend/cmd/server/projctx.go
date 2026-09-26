package main

import (
	"context"
	"net/http"
)

type ctxKey string

const projectIDKey ctxKey = "project_id"

func withProjectID(r *http.Request, id string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), projectIDKey, id))
}
