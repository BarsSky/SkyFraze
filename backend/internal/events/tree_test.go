package events

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/store"
)

func mustUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	if err != nil {
		t.Fatalf("parse uuid %s: %v", s, err)
	}
	return id
}

var (
	idA = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	idB = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	idC = uuid.MustParse("33333333-3333-3333-3333-333333333333")
	idD = uuid.MustParse("44444444-4444-4444-4444-444444444444")
)

func ptr(id uuid.UUID) *uuid.UUID { return &id }

func TestNormalizeTree_Empty(t *testing.T) {
	out, err := NormalizeTree(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("expected empty result, got %d", len(out))
	}
}

func TestNormalizeTree_ValidNestingAndOrder(t *testing.T) {
	// Намеренно в «неправильном» порядке: дети раньше родителей.
	out, err := NormalizeTree([]NodeInput{
		{ID: idC, ParentID: ptr(idB)},
		{ID: idB, ParentID: ptr(idA)},
		{ID: idA},
		{ID: idD},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 4 {
		t.Fatalf("expected 4 nodes, got %d", len(out))
	}
	depths := map[uuid.UUID]int16{}
	for _, n := range out {
		depths[n.ID] = n.Depth
	}
	if depths[idA] != 0 || depths[idB] != 1 || depths[idC] != 2 || depths[idD] != 0 {
		t.Fatalf("unexpected depths: %+v", depths)
	}
	// Родители должны идти раньше детей (иначе вставка нарушит FK).
	for i := 1; i < len(out); i++ {
		if out[i-1].Depth > out[i].Depth {
			t.Fatalf("nodes are not sorted by depth: %+v", out)
		}
	}
}

func TestNormalizeTree_RejectsDuplicatesAndEmptyID(t *testing.T) {
	if _, err := NormalizeTree([]NodeInput{{ID: idA}, {ID: idA}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for duplicate id, got %v", err)
	}
	if _, err := NormalizeTree([]NodeInput{{ID: uuid.Nil}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for nil id, got %v", err)
	}
}

func TestNormalizeTree_RejectsSelfParent(t *testing.T) {
	_, err := NormalizeTree([]NodeInput{{ID: idA, ParentID: ptr(idA)}})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for self parent, got %v", err)
	}
}

func TestNormalizeTree_RejectsMissingParent(t *testing.T) {
	_, err := NormalizeTree([]NodeInput{{ID: idA, ParentID: ptr(idB)}})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for missing parent, got %v", err)
	}
}

func TestNormalizeTree_RejectsCycles(t *testing.T) {
	if _, err := NormalizeTree([]NodeInput{
		{ID: idA, ParentID: ptr(idB)},
		{ID: idB, ParentID: ptr(idA)},
	}); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for 2-cycle, got %v", err)
	}
	if _, err := NormalizeTree([]NodeInput{
		{ID: idA, ParentID: ptr(idC)},
		{ID: idB, ParentID: ptr(idA)},
		{ID: idC, ParentID: ptr(idB)},
	}); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for 3-cycle, got %v", err)
	}
}

func TestNormalizeTree_RejectsTooDeep(t *testing.T) {
	// Цепочка длиной MaxDepth + 2 (последний узел глубже допустимого).
	ids := make([]uuid.UUID, 0, MaxDepth+2)
	for i := 0; i <= MaxDepth+1; i++ {
		ids = append(ids, uuid.New())
	}
	nodes := make([]NodeInput, 0, len(ids))
	for i, id := range ids {
		n := NodeInput{ID: id}
		if i > 0 {
			n.ParentID = ptr(ids[i-1])
		}
		nodes = append(nodes, n)
	}
	if _, err := NormalizeTree(nodes); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for too deep tree, got %v", err)
	}
}

func TestNormalizeTree_AcceptsMaxDepth(t *testing.T) {
	ids := make([]uuid.UUID, 0, MaxDepth+1)
	for i := 0; i <= MaxDepth; i++ {
		ids = append(ids, uuid.New())
	}
	nodes := make([]NodeInput, 0, len(ids))
	for i, id := range ids {
		n := NodeInput{ID: id}
		if i > 0 {
			n.ParentID = ptr(ids[i-1])
		}
		nodes = append(nodes, n)
	}
	out, err := NormalizeTree(nodes)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != MaxDepth+1 {
		t.Fatalf("expected %d nodes, got %d", MaxDepth+1, len(out))
	}
}

func TestNormalizeTree_ReindexesPositionsPerGroup(t *testing.T) {
	// Порядок соседей задаётся входным порядком: b, c у корня и d у b.
	out, err := NormalizeTree([]NodeInput{
		{ID: idB, Position: 42},
		{ID: idC, Position: 7},
		{ID: idD, ParentID: ptr(idB), Position: 99},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	pos := map[uuid.UUID]int{}
	for _, n := range out {
		pos[n.ID] = n.Position
	}
	if pos[idB] != 0 || pos[idC] != 1 || pos[idD] != 0 {
		t.Fatalf("unexpected positions: %+v", pos)
	}
}

func TestBuildTree_NestsAndPromotesOrphans(t *testing.T) {
	parent := mustUUID(t, idA.String())
	orphanParent := uuid.New()
	evs := []store.Event{
		{ID: idA, Position: 0, Depth: 0, Title: "Глава"},
		{ID: idB, ParentID: &parent, Position: 0, Depth: 1, Title: "Подсобытие"},
		{ID: idC, ParentID: &orphanParent, Position: 1, Depth: 3, Title: "Сирота"},
		{ID: idD, Position: 2, Depth: 0, Title: "Вторая глава"},
	}
	tree := BuildTree(evs)
	if len(tree) != 3 {
		t.Fatalf("expected 3 roots (сирота поднимается в корень), got %d", len(tree))
	}
	if tree[0].ID != idA || len(tree[0].Children) != 1 || tree[0].Children[0].ID != idB {
		t.Fatalf("unexpected first root: %+v", tree[0])
	}
	if tree[1].ID != idC {
		t.Fatalf("expected orphan as second root, got %s", tree[1].ID)
	}
	if tree[1].Depth != 0 {
		t.Fatalf("orphan must be reported with depth 0, got %d", tree[1].Depth)
	}
	if tree[2].ID != idD {
		t.Fatalf("expected second chapter last, got %s", tree[2].ID)
	}
}

func TestDescendantsIDs(t *testing.T) {
	parent := idA
	child := idB
	evs := []store.Event{
		{ID: idA},
		{ID: idB, ParentID: &parent},
		{ID: idC, ParentID: &child},
		{ID: idD},
	}
	got := DescendantsIDs(evs, idA)
	if len(got) != 2 || !got[idB] || !got[idC] {
		t.Fatalf("unexpected descendants: %+v", got)
	}
	if got[idA] {
		t.Fatalf("descendants must not include the node itself")
	}
	if len(DescendantsIDs(evs, idD)) != 0 {
		t.Fatalf("leaf must have no descendants")
	}
}
