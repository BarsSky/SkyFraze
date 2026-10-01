// Package maintenance — уборка хранилища и отчёт о размерах.
//
// Зачем отдельный пакет. «Проект удалён, а файлы остались» и «файл записан, а
// строки в базе нет» — это не ошибка одного обработчика, а состояние системы,
// которое надо периодически приводить в порядок: удаление проекта может не дойти
// до хранилища (упал процесс между шагами), импорт может оборваться между записью
// файлов и строкой в `assets`. Поэтому здесь живут:
//
//	Report — где именно лежит место (первый шаг плана docs/storage-compression.md);
//	Sweep  — удаление файлов, на которые никто не ссылается, и отчёт о строках,
//	         у которых файла нет (их не удаляем: это содержимое проекта);
//	Run    — фон: отчёт после старта и уборка раз в сутки.
//
// Уборка никогда не удаляет то, что моложе Grace: импорт пишет файлы пачкой, и
// между Put и строкой в `assets` проходит время.
package maintenance

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/skyfraze/backend/internal/assets"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

// Значения по умолчанию: сутки «карантина» для свежих файлов и сутки между
// уборками. Уборка — редкая операция, чаще незачем: она обходит весь каталог
// хранилища.
const (
	defaultGrace      = 24 * time.Hour
	defaultInterval   = 24 * time.Hour
	defaultStartDelay = 2 * time.Minute
	defaultExamples   = 20
)

// Options — настройки уборщика; нулевые значения заменяются значениями по умолчанию.
type Options struct {
	// Grace — файл без строки `assets` моложе этого возраста не трогаем.
	Grace time.Duration
	// Interval — период фоновой уборки.
	Interval time.Duration
	// StartDelay — пауза после старта: сервер в эти секунды занят миграциями и
	// первыми запросами, а уборка обходит весь каталог.
	StartDelay time.Duration
	// Examples — сколько примеров показывать в отчёте.
	Examples int
}

// Recompressor — тот, кто умеет пережимать уже загруженные картинки (реализует
// assets.Service). Интерфейс объявлен здесь, а работа с файлами живёт в пакете
// вложений: уборщик только ходит по хранилищу и показывает отчёт.
type Recompressor interface {
	RecompressStored(ctx context.Context, projectID *uuid.UUID, apply bool) (*assets.RecompressReport, error)
}

// UseRecompressor подключает пережатие уже загруженных файлов (ручка админки).
func (s *Sweeper) UseRecompressor(recompressor Recompressor) { s.recompressor = recompressor }

// Sweeper — уборщик хранилища.
type Sweeper struct {
	store        *store.Store
	obj          storage.ObjectStore
	logger       *slog.Logger
	opts         Options
	recompressor Recompressor
}

func New(st *store.Store, obj storage.ObjectStore, logger *slog.Logger, opts Options) *Sweeper {
	if opts.Grace <= 0 {
		opts.Grace = defaultGrace
	}
	if opts.Interval <= 0 {
		opts.Interval = defaultInterval
	}
	if opts.StartDelay <= 0 {
		opts.StartDelay = defaultStartDelay
	}
	if opts.Examples <= 0 {
		opts.Examples = defaultExamples
	}
	return &Sweeper{store: st, obj: obj, logger: logger, opts: opts}
}

// FileEntry — файл или строка, попавшие в отчёт как проблемные.
type FileEntry struct {
	Key      string    `json:"key"`
	Size     int64     `json:"size,omitempty"`
	Modified time.Time `json:"modified,omitempty"`
	Project  string    `json:"project,omitempty"`
}

// Report — отчёт о размерах и о расхождениях хранилища с базой.
type Report struct {
	ScannedAt time.Time `json:"scanned_at"`
	// Длительность обхода каталога — чтобы понимать цену фоновой уборки.
	ScanMillis int64 `json:"scan_ms"`

	DatabaseBytes int64             `json:"database_bytes"`
	Tables        []store.TableSize `json:"tables"`
	Projects      int64             `json:"projects"`

	SnapshotCount int64 `json:"snapshot_count"`
	SnapshotBytes int64 `json:"snapshot_bytes"`
	EventRows     int64 `json:"event_rows"`
	EventTextSize int64 `json:"event_text_bytes"`
	AssetRows     int64 `json:"asset_rows"`
	AssetBytes    int64 `json:"asset_bytes"`

	// Файлы в хранилище и сверка с базой.
	FileCount int   `json:"file_count"`
	FileBytes int64 `json:"file_bytes"`
	// OrphanFiles/OrphanBytes — что НАШЛОСЬ в этом проходе: файлы без строк в
	// `assets`, старше карантина. В уборке часть из них тут же удаляется — сколько
	// именно, видно в RemovedFiles/RemovedBytes (поэтому «осиротевших» в ответе
	// уборки не ноль, даже когда после неё их не осталось).
	OrphanFiles  int   `json:"orphan_files"`
	OrphanBytes  int64 `json:"orphan_bytes"`
	PendingFiles int   `json:"pending_files"` // без строки, но свежие: их не трогаем
	MissingFiles int   `json:"missing_files"` // строка есть, файла нет

	OrphanExamples  []FileEntry `json:"orphan_examples,omitempty"`
	MissingExamples []FileEntry `json:"missing_examples,omitempty"`

	// Чего уборка добилась в этом проходе (в Report — ноль).
	RemovedFiles int   `json:"removed_files"`
	RemovedBytes int64 `json:"removed_bytes"`
	FailedFiles  int   `json:"failed_files"`
}

// Report осматривает базу и хранилище, ничего не удаляя.
func (s *Sweeper) Report(ctx context.Context) (*Report, error) {
	return s.scan(ctx, false)
}

// Sweep делает то же самое и удаляет файлы, на которые никто не ссылается.
func (s *Sweeper) Sweep(ctx context.Context) (*Report, error) {
	return s.scan(ctx, true)
}

func (s *Sweeper) scan(ctx context.Context, remove bool) (*Report, error) {
	started := time.Now()
	report := &Report{ScannedAt: started.UTC()}

	stats, err := s.store.StorageStats(ctx)
	if err != nil {
		return nil, err
	}
	report.DatabaseBytes = stats.DatabaseBytes
	report.Tables = stats.Tables
	report.Projects = stats.Projects
	report.SnapshotCount = stats.SnapshotCount
	report.SnapshotBytes = stats.SnapshotBytes
	report.EventRows = stats.EventRows
	report.EventTextSize = stats.EventTextBytes
	report.AssetRows = stats.AssetRows
	report.AssetBytes = stats.AssetBytes

	// Ключи вложений: с чем сверяем каталог.
	keys, err := s.store.AssetKeys(ctx)
	if err != nil {
		return nil, err
	}

	files, err := s.obj.List(ctx, "")
	if err != nil {
		return nil, err
	}
	report.ScanMillis = time.Since(started).Milliseconds()
	report.FileCount = len(files)

	present := make(map[string]bool, len(files))
	orphans := make([]FileEntry, 0, len(report.OrphanExamples))
	for _, file := range files {
		report.FileBytes += file.Size
		present[file.Key] = true
		if _, ok := keys[file.Key]; ok {
			continue
		}
		// Файла нет среди вложений. Свежий — значит, запись ещё идёт (импорт):
		// удалять его нельзя, иначе мы бы ломали чужой незавершённый импорт.
		if time.Since(file.ModTime) < s.opts.Grace {
			report.PendingFiles++
			continue
		}
		report.OrphanFiles++
		report.OrphanBytes += file.Size
		if len(report.OrphanExamples) < s.opts.Examples {
			orphans = append(orphans, FileEntry{Key: file.Key, Size: file.Size, Modified: file.ModTime.UTC()})
		}
		if !remove {
			continue
		}
		if err := s.obj.Delete(ctx, file.Key); err != nil {
			s.logger.Warn("storage sweep: delete failed", "key", file.Key, "err", err)
			report.FailedFiles++
			continue
		}
		report.RemovedFiles++
		report.RemovedBytes += file.Size
	}
	report.OrphanExamples = orphans

	// Обратная сторона: строка `assets` есть, файла нет. Это содержимое проекта, и
	// удалять его молча нельзя — сообщаем, решение за человеком.
	missing := make([]FileEntry, 0, len(report.MissingExamples))
	for key, projectID := range keys {
		if present[key] {
			continue
		}
		report.MissingFiles++
		if len(missing) < s.opts.Examples {
			missing = append(missing, FileEntry{Key: key, Project: projectID.String()})
		}
	}
	// Порядок примеров — стабильный: отчёты сравнивают между собой.
	sort.Slice(missing, func(i, j int) bool { return missing[i].Key < missing[j].Key })
	report.MissingExamples = missing

	return report, nil
}

// Run — фоновая уборка: отчёт после старта и уборка раз в Interval.
//
// Удаление не запускаем сразу на старте: сервер только что поднялся, а уборка
// обходит весь каталог — пусть сначала отработают запросы, а первый проход будет
// только отчётом (по нему видно, есть ли что убирать вообще).
func (s *Sweeper) Run(ctx context.Context) {
	report, err := s.waitAndReport(ctx)
	if err == nil {
		s.logReport(report, false)
	} else if ctx.Err() == nil {
		s.logger.Warn("storage report failed", "err", err)
	}

	ticker := time.NewTicker(s.opts.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			swept, err := s.Sweep(ctx)
			if err != nil {
				if ctx.Err() == nil {
					s.logger.Warn("storage sweep failed", "err", err)
				}
				continue
			}
			s.logReport(swept, true)
		}
	}
}

func (s *Sweeper) waitAndReport(ctx context.Context) (*Report, error) {
	timer := time.NewTimer(s.opts.StartDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
	}
	return s.Report(ctx)
}

// logReport пишет отчёт в лог: это единственный способ увидеть тренд размеров, не
// заходя в админку (там отчёт отдаётся по запросу).
func (s *Sweeper) logReport(report *Report, swept bool) {
	attrs := []any{
		"database_bytes", report.DatabaseBytes,
		"snapshot_bytes", report.SnapshotBytes,
		"event_text_bytes", report.EventTextSize,
		"assets", report.AssetRows,
		"asset_bytes", report.AssetBytes,
		"files", report.FileCount,
		"file_bytes", report.FileBytes,
		"orphans", report.OrphanFiles,
		"pending", report.PendingFiles,
		"missing", report.MissingFiles,
		"scan_ms", report.ScanMillis,
	}
	if swept {
		attrs = append(attrs, "removed_files", report.RemovedFiles, "removed_bytes", report.RemovedBytes)
		s.logger.Info("storage sweep done", attrs...)
		return
	}
	s.logger.Info("storage report", attrs...)
}

// --- HTTP: /api/admin/storage ---
//
// Права проверяет админ-роутер: он вызывает эти ручки только после requireAdmin,
// поэтому здесь ни токена, ни роли не читаем.

// Storage — GET /api/admin/storage: отчёт без изменений.
func (s *Sweeper) Storage(w http.ResponseWriter, r *http.Request) {
	report, err := s.Report(r.Context())
	if err != nil {
		s.logger.Error("storage report", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage report failed"})
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// SweepStorage — POST /api/admin/storage/sweep: уборка по требованию.
func (s *Sweeper) SweepStorage(w http.ResponseWriter, r *http.Request) {
	report, err := s.Sweep(r.Context())
	if err != nil {
		s.logger.Error("storage sweep", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage sweep failed"})
		return
	}
	s.logReport(report, true)
	writeJSON(w, http.StatusOK, report)
}

// RecompressStorage — POST /api/admin/storage/recompress: пережать уже загруженные
// картинки (jpeg/png → webp). Без `?apply=1` это сухой прогон: считает выигрыш и
// ничего не пишет — по нему видно, стоит ли запускать.
func (s *Sweeper) RecompressStorage(w http.ResponseWriter, r *http.Request) {
	if s.recompressor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "recompression is not wired"})
		return
	}
	apply := r.URL.Query().Get("apply") == "1"
	report, err := s.recompressor.RecompressStored(r.Context(), nil, apply)
	if err != nil {
		s.logger.Error("storage recompress", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "recompress failed"})
		return
	}
	s.logger.Info("storage recompress done",
		"files", report.Files, "images", report.Images, "changed", report.Changed,
		"skipped", report.Skipped, "damaged", report.Damaged, "failed", report.Failed,
		"bytes_from", report.BytesFrom, "bytes_to", report.BytesTo,
		"applied", report.Applied)
	writeJSON(w, http.StatusOK, report)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
