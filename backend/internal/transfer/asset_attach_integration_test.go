package transfer_test

// asset_attach_integration_test.go — привязка вложения к кадру через transfer.
//
// Два пути, и оба важны:
//   - живая комната: правит документ, который видят редакторы (проверяем, что transfer
//     идёт именно этим путём и переводит исход комнаты в понятный отказ);
//   - без комнаты: правит снапшот и перестраивает проекцию. Этот путь реально
//     используется, когда проект никто не открыл (CLI, выключенный WebSocket).

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/collab/yjs"
	"github.com/skyfraze/backend/internal/store"
	"github.com/skyfraze/backend/internal/transfer"
)

// storeImage кладёт картинку в проект так, как это делает помощник: сначала файл, потом
// привязка.
func storeImage(t *testing.T, e *env, owner, projectID uuid.UUID) *store.Asset {
	t.Helper()
	svc := assets.New(e.st, e.obj, e.proj)
	asset, err := svc.Upload(context.Background(), owner, projectID, assets.UploadOpts{
		Filename:    "иллюстрация.png",
		ContentType: "image/png",
		Size:        int64(len(tinyPNGForAttach)),
		Reader:      bytes.NewReader(tinyPNGForAttach),
	})
	if err != nil {
		t.Fatalf("сохранение картинки: %v", err)
	}
	return asset
}

// tinyPNGForAttach — настоящий PNG 1×1: сервер пережимает картинки, и на «abc» он бы
// отказал по формату.
var tinyPNGForAttach = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
	0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0xF0,
	0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0xAB, 0xCE, 0x36, 0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
	0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
}

func TestAttachAssetToEventSnapshotPath(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Иллюстрации", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	// Кадр заводим в документе (как это делает редактор), а не только в таблице: иначе
	// привязывать было бы не к чему.
	chapter := uuid.New()
	state := yjs.NewDoc()
	if err := state.SeedEvents([]yjs.EventSeed{{ID: chapter.String(), Title: "Пролог", Body: "Текст."}}); err != nil {
		t.Fatalf("засев: %v", err)
	}
	if _, err := e.st.SaveProjectEventStateServer(ctx, project.ID, owner, state.EncodeState()); err != nil {
		t.Fatalf("снапшот: %v", err)
	}
	asset := storeImage(t, e, owner, project.ID)

	// Живой комнаты нет — transfer должен сам записать снапшот.
	warning, err := e.transfer.AttachAssetToEvent(ctx, owner, owner, project.ID,
		chapter.String(), asset.ID.String(), true)
	if err != nil {
		t.Fatalf("привязка: %v", err)
	}
	if warning != "" {
		t.Logf("предупреждение: %s", warning)
	}

	// Файл лежит в проекте — его видно в списке вложений.
	list, err := e.st.ListAssets(ctx, project.ID)
	if err != nil {
		t.Fatalf("вложения проекта: %v", err)
	}
	if len(list) != 1 || list[0].ID != asset.ID {
		t.Fatalf("вложения: %+v", list)
	}
	// И привязка живёт в документе: читаем снапшот заново.
	doc, err := yjs.FromState(mustState(t, e, project.ID))
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	if usage := doc.AssetUsage(asset.ID.String()); usage != 1 {
		t.Fatalf("вложение не привязалось: использование %d", usage)
	}
	events := doc.Events()
	if len(events) != 1 || events[0].Background != asset.ID.String() {
		t.Errorf("фон кадра: %+v", events)
	}
}

func TestAttachAssetToEventLivePath(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	project, err := e.proj.Create(ctx, owner, "Живая привязка", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	asset := storeImage(t, e, owner, project.ID)

	live := &stubLive{attachFound: true}
	e.transfer.UseLiveDoc(live)
	if _, err := e.transfer.AttachAssetToEvent(ctx, owner, owner, project.ID,
		uuid.NewString(), asset.ID.String(), true); err != nil {
		t.Fatalf("привязка через комнату: %v", err)
	}
	if !live.attached {
		t.Fatal("с живой комнатой transfer должен идти её путём, а не писать снапшот")
	}
	if !live.attachBgFlag {
		t.Error("просьба сделать фоном потерялась")
	}

	// Комната не нашла кадр — это отказ словами, а не «привязали в никуда».
	live.attachFound = false
	_, err = e.transfer.AttachAssetToEvent(ctx, owner, owner, project.ID,
		uuid.NewString(), asset.ID.String(), false)
	if !errors.Is(err, transfer.ErrEventNotFound) {
		t.Fatalf("ожидался ErrEventNotFound, получено %v", err)
	}
}

func TestAttachAssetRequiresEditor(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	owner := e.user(t, "owner@example.com")
	viewer := e.user(t, "viewer@example.com")
	project, err := e.proj.Create(ctx, owner, "Права", "")
	if err != nil {
		t.Fatalf("проект: %v", err)
	}
	if err := e.st.AddMembership(ctx, project.ID, viewer, store.RoleViewer); err != nil {
		t.Fatalf("участие: %v", err)
	}
	asset := storeImage(t, e, owner, project.ID)

	_, err = e.transfer.AttachAssetToEvent(ctx, viewer, viewer, project.ID,
		uuid.NewString(), asset.ID.String(), false)
	if !errors.Is(err, transfer.ErrForbidden) {
		t.Fatalf("читателю привязывать нельзя: %v", err)
	}
}

// mustState читает снапшот проекта (или падает: без снапшота проверять нечего).
func mustState(t *testing.T, e *env, projectID uuid.UUID) []byte {
	t.Helper()
	state, err := e.st.GetProjectEventState(context.Background(), projectID)
	if err != nil || state == nil {
		t.Fatalf("снапшот: %v", err)
	}
	return state.YjsState
}
