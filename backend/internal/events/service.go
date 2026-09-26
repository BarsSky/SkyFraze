package events

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/store"
)

var ErrForbidden = errors.New("forbidden")

type Service struct {
	store *store.Store
	proj  *projects.Service
}

func New(s *store.Store, proj *projects.Service) *Service {
	return &Service{store: s, proj: proj}
}

// GetYjsState — возвращает последний Yjs-снапшот (для фронта при коннекте).
func (s *Service) GetYjsState(ctx context.Context, userID, projectID uuid.UUID) ([]byte, error) {
	if _, err := s.proj.Get(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.GetYjsState(ctx, projectID)
}

// SaveYjsState — серверный relay сохраняет снапшоты периодически.
func (s *Service) SaveYjsState(ctx context.Context, userID, projectID uuid.UUID, state []byte) error {
	if _, err := s.proj.Get(ctx, userID, projectID); err != nil {
		return err
	}
	return s.store.SaveYjsState(ctx, projectID, state)
}

func (s *Service) List(ctx context.Context, userID, projectID uuid.UUID) ([]store.Event, error) {
	if _, err := s.proj.Get(ctx, userID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListEvents(ctx, projectID)
}
