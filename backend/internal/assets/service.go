package assets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/skyfraze/backend/internal/media"
	"github.com/skyfraze/backend/internal/projects"
	"github.com/skyfraze/backend/internal/storage"
	"github.com/skyfraze/backend/internal/store"
)

var (
	ErrTooLarge = errors.New("file too large")
	ErrBadMime  = errors.New("unsupported mime type")
)

// QuotaError — в проекте не осталось места под файл. Ошибка нарочно «говорящая»:
// её текст показывают человеку в панели редактора, поэтому в нём и занятое место,
// и предел, и вес файла — чтобы было понятно, что удалять.
type QuotaError struct {
	Used     int64
	Limit    int64
	Incoming int64
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("в проекте занято %s из %s — файл на %s не помещается",
		HumanBytes(e.Used), HumanBytes(e.Limit), HumanBytes(e.Incoming))
}

// InUseError — файл прикреплён к кадрам, удалять его нельзя.
type InUseError struct {
	Events int
}

func (e *InUseError) Error() string {
	if e.Events == 1 {
		return "файл прикреплён к кадру — сначала открепите его"
	}
	return fmt.Sprintf("файл прикреплён к %d кадрам — сначала открепите его", e.Events)
}

// QuotaExceeded — можно ли считать ошибку превышением квоты (для HTTP-кода).
func QuotaExceeded(err error) bool {
	var quota *QuotaError
	return errors.As(err, &quota)
}

// HumanBytes — размер по-человечески: «9.4 МБ», «512 КБ». Нужен в сообщениях о
// квоте: «занято 9437184 из 10485760» человеку ничего не говорит.
func HumanBytes(bytes int64) string {
	switch {
	case bytes >= 1<<30:
		return fmt.Sprintf("%.1f ГБ", float64(bytes)/(1<<30))
	case bytes >= 1<<20:
		return fmt.Sprintf("%.1f МБ", float64(bytes)/(1<<20))
	case bytes >= 1<<10:
		return fmt.Sprintf("%.0f КБ", float64(bytes)/(1<<10))
	}
	return fmt.Sprintf("%d Б", bytes)
}

const maxAssetSize = 50 * 1024 * 1024 // 50 MB

// MaxAssetSize — предел размера одного вложения. Экспортирован, потому что его
// обязаны соблюдать все пути, создающие вложения: загрузка из интерфейса и импорт
// проекта (папка md с картинками), иначе импорт создал бы файл, который сервер
// потом отказывается принять.
const MaxAssetSize = maxAssetSize

// ObjectKey — ключ файла в хранилище: каталог проекта плюс случайный идентификатор
// с расширением файла. Одна схема для загрузки из интерфейса и для импорта: файлы
// проекта лежат вместе, а расширение нужно, чтобы отдача по ключу не теряла тип.
func ObjectKey(projectID uuid.UUID, filename string) string {
	return fmt.Sprintf("%s/%s", projectID.String(), uuid.NewString()+extFromFilename(filename))
}

type Service struct {
	store  *store.Store
	obj    storage.ObjectStore
	proj   *projects.Service
	logger *slog.Logger
	// quota — предел суммы вложений проекта (0 — без предела). Считается по
	// строкам `assets`, то есть по весу ПОСЛЕ пережатия: картинка на 8 МБ,
	// приехавшая как 300 КБ webp, занимает 300 КБ.
	quota int64
	// usage — кто умеет сказать, прикреплён ли файл к кадрам (реализует
	// collab.Hub). Без него удаление файла запрещено: проверять ссылки нечем, а
	// удалять прикреплённое нельзя.
	usage UsageChecker
}

// UsageChecker — расход файла по документу проекта.
//
// Интерфейс объявлен здесь, а реализует его хаб: вложения не должны зависеть от
// collab (иначе сервис файлов и realtime сцепятся намертво).
type UsageChecker interface {
	AssetUsage(ctx context.Context, projectID, assetID uuid.UUID) (int, error)
}

func New(s *store.Store, obj storage.ObjectStore, proj *projects.Service) *Service {
	return &Service{store: s, obj: obj, proj: proj, logger: slog.Default()}
}

// UseQuota задаёт предел суммы вложений проекта; 0 или меньше — без предела.
func (s *Service) UseQuota(limit int64) {
	if limit > 0 {
		s.quota = limit
	}
}

// UseUsage подключает проверку ссылок в документе (нужна удалению файла).
func (s *Service) UseUsage(checker UsageChecker) { s.usage = checker }

// Quota — текущий предел (0 — без предела): отчёт админки показывает его людям.
func (s *Service) Quota() int64 { return s.quota }

// UseLogger подключает логгер сервиса. Нужен только для одного: сообщить, что
// картинку не удалось пережать и файл сохранён как есть (см. storeImage). Без него
// пишем в slog по умолчанию — молча терять причину нельзя.
func (s *Service) UseLogger(logger *slog.Logger) {
	if logger != nil {
		s.logger = logger
	}
}

// UploadOpts — параметры загрузки.
type UploadOpts struct {
	Filename    string
	ContentType string
	Size        int64
	Reader      io.Reader
}

// Upload — загружает файл, сохраняет метаданные.
//
// Растровые картинки (jpeg/png) пережимаются в WebP: страница показывает их
// ограниченного размера, а платит за вес сервер (см. internal/media). Остальные
// файлы пишутся как есть, потоком.
//
// Файл с тем же содержимым второй раз не пишется: хеш считается по содержимому во
// время записи, и если такой файл уже есть (в любом проекте), новая строка вложений
// ссылается на существующий объект хранилища. Метаданные при этом свои: имя файла,
// владелец и проект у каждой строки собственные (миграция 0007).
func (s *Service) Upload(ctx context.Context, actorID, projectID uuid.UUID, opts UploadOpts) (*store.Asset, error) {
	// проверим доступ к проекту
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	if opts.Size > maxAssetSize {
		return nil, ErrTooLarge
	}
	mime := NormalizeMime(opts.ContentType, opts.Filename)
	if !MimeAllowed(mime) {
		return nil, ErrBadMime
	}

	// Картинку, которую умеем пережать, читаем в память целиком: декодировать её
	// потоком нельзя. Предел тот же, что у пережатия (20 МБ), поэтому пик памяти
	// ограничен; всё остальное (pdf, видео, большие файлы) идёт потоком, как раньше.
	if media.Recompressible(mime, opts.Size) {
		data, err := io.ReadAll(io.LimitReader(opts.Reader, media.MaxSourceBytes+1))
		if err != nil {
			return nil, fmt.Errorf("read upload: %w", err)
		}
		return s.storeImage(ctx, projectID, actorID, opts.Filename, mime, data)
	}

	return s.storeStream(ctx, projectID, actorID, putFile{
		Name: opts.Filename,
		Mime: mime,
		Kind: KindOf(mime, opts.Filename),
		Size: opts.Size,
	}, opts.Reader)
}

// storeImage пережимает картинку (если это даёт выигрыш) и кладёт результат.
//
// Дедупликация считается по хешу ЗАПИСАННЫХ байтов: после пережатия они другие, и
// две загрузки одного и того же фото должны сойтись в один файл именно в новом виде.
func (s *Service) storeImage(
	ctx context.Context, projectID, owner uuid.UUID, filename, mime string, data []byte,
) (*store.Asset, error) {
	result, err := media.Recompress(filename, mime, data)
	if err != nil {
		// Пережатие — улучшение, а не условие приёма: не получилось — храним исходник.
		s.logger.Warn("asset recompress failed", "filename", filename, "err", err)
		result = media.Result{Data: data, Mime: mime, Filename: filename}
	}
	return s.storeBytes(ctx, projectID, owner, putFile{
		Name:   result.Filename,
		Mime:   result.Mime,
		Kind:   KindOf(result.Mime, result.Filename),
		Size:   int64(len(result.Data)),
		Width:  positiveOrNil(result.Width),
		Height: positiveOrNil(result.Height),
	}, result.Data)
}

// putFile — то, что попадёт в строку `assets` (без содержимого).
type putFile struct {
	Name   string
	Mime   string
	Kind   string
	Size   int64
	Width  *int
	Height *int
}

// storeBytes записывает готовые байты и, если файл с таким содержимым уже есть в
// любом проекте, второй раз его не пишет: строка начнёт ссылаться на существующий
// объект (дедупликация, миграция 0007).
func (s *Service) storeBytes(
	ctx context.Context, projectID, owner uuid.UUID, file putFile, data []byte,
) (*store.Asset, error) {
	if err := s.checkQuota(ctx, projectID, file.Size); err != nil {
		return nil, err
	}

	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])

	existing, err := s.store.FindAssetByHash(ctx, hash)
	if err != nil {
		return nil, err
	}
	key := ""
	if existing != nil {
		key = existing.S3Key
	} else {
		key = ObjectKey(projectID, file.Name)
		if err := s.obj.Put(ctx, key, file.Mime, bytes.NewReader(data), int64(len(data))); err != nil {
			return nil, fmt.Errorf("store put: %w", err)
		}
	}

	asset, err := s.insertAsset(ctx, projectID, owner, file, key, hash)
	if err != nil {
		if existing == nil {
			_ = s.obj.Delete(ctx, key)
		}
		return nil, err
	}
	return asset, nil
}

// storeStream — путь для больших и не-картиночных файлов: пишем потоком, хешируя на
// лету, и только потом смотрим, нет ли такого же файла. Если есть — свой удаляем, а
// строка ссылается на существующий: лишняя запись на диск дешевле, чем чтение
// 50 МБ в память ради хеша до записи.
func (s *Service) storeStream(
	ctx context.Context, projectID, owner uuid.UUID, file putFile, r io.Reader,
) (*store.Asset, error) {
	// Квоту проверяем до записи: размер не-картиночного файла не меняется, поэтому
	// заявленный вес — это и есть то, что окажется в строке и на диске.
	if err := s.checkQuota(ctx, projectID, file.Size); err != nil {
		return nil, err
	}
	hasher := sha256.New()
	key := ObjectKey(projectID, file.Name)
	if err := s.obj.Put(ctx, key, file.Mime, io.TeeReader(r, hasher), file.Size); err != nil {
		return nil, fmt.Errorf("store put: %w", err)
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	existing, err := s.store.FindAssetByHash(ctx, hash)
	if err != nil {
		_ = s.obj.Delete(ctx, key)
		return nil, err
	}
	if existing != nil {
		_ = s.obj.Delete(ctx, key)
		key = existing.S3Key
	}

	asset, err := s.insertAsset(ctx, projectID, owner, file, key, hash)
	if err != nil && existing == nil {
		_ = s.obj.Delete(ctx, key)
		return nil, err
	}
	return asset, err
}

// checkQuota решает, помещается ли файл в проект.
//
// Место считаем по строкам `assets` проекта, то есть по весу уже пережатых файлов:
// загруженное фото на 8 МБ приезжает как 300 КБ и столько и занимает. Дедупликация
// квоту не уменьшает: файл, который уже есть в хранилище, всё равно становится
// вложением проекта — проект получает его в своё содержимое.
//
// Проверка не транзакционная: две одновременные загрузки могут обе увидеть место и
// вместе перебрать предел на один файл. Это осознанно — квота защищает диск от
// «проект на гигабайт», а не считает байты до последнего; отдельная блокировка на
// каждый upload стоила бы дороже.
func (s *Service) checkQuota(ctx context.Context, projectID uuid.UUID, incoming int64) error {
	if s.quota <= 0 {
		return nil
	}
	used, err := s.store.SumProjectAssetBytes(ctx, projectID)
	if err != nil {
		return err
	}
	if used+incoming > s.quota {
		return &QuotaError{Used: used, Limit: s.quota, Incoming: incoming}
	}
	return nil
}

// Usage — сколько занято и каков предел: нужно интерфейсу, чтобы показать
// «8.4 МБ из 10 МБ» до того, как человек упрётся в отказ, и чтобы было видно, что
// удаление файла освобождает место.
func (s *Service) Usage(ctx context.Context, actorID, projectID uuid.UUID) (used, limit int64, err error) {
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return 0, 0, err
	}
	used, err = s.store.SumProjectAssetBytes(ctx, projectID)
	return used, s.quota, err
}

// Delete убирает вложение проекта: строку и, если на файл больше никто не
// ссылается, сам файл (дедупликация: один и тот же объект бывает у нескольких
// проектов и строк).
//
// Файл, прикреплённый к кадрам, удалить нельзя: в CRDT-документе осталась бы
// ссылка на несуществующий объект, и кадр показывал бы пустое место. Сначала
// человек открепляет файл от кадров (кнопка «открепить» в редакторе), потом
// удаляет. Так порядок действий виден, а не «файл исчез вместе с картинкой».
func (s *Service) Delete(ctx context.Context, actorID, assetID uuid.UUID) error {
	asset, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		return err
	}
	if err := s.proj.RequireEditor(ctx, actorID, asset.ProjectID); err != nil {
		return err
	}
	if s.usage != nil {
		usage, err := s.usage.AssetUsage(ctx, asset.ProjectID, assetID)
		if err != nil {
			return err
		}
		if usage > 0 {
			return &InUseError{Events: usage}
		}
	}
	if err := s.store.DeleteAsset(ctx, assetID); err != nil {
		return err
	}
	// Файл убираем после строки: «сколько осталось ссылок» — это и есть ответ на
	// вопрос, нужен ли он ещё кому-нибудь. Ошибка уборки запрос не валит —
	// потерянный файл найдёт уборщик хранилища.
	if _, err := s.DeleteUnreferencedFiles(ctx, []string{asset.S3Key}); err != nil {
		s.logger.Warn("asset delete: file not removed", "key", asset.S3Key, "err", err)
	}
	return nil
}

// insertAsset создаёт строку вложения для уже записанного файла.
func (s *Service) insertAsset(
	ctx context.Context, projectID, owner uuid.UUID, file putFile, key, hash string,
) (*store.Asset, error) {
	asset := &store.Asset{
		ProjectID:   projectID,
		OwnerID:     owner,
		Filename:    file.Name,
		Mime:        file.Mime,
		Size:        file.Size,
		S3Key:       key,
		Kind:        file.Kind,
		Width:       file.Width,
		Height:      file.Height,
		ContentHash: &hash,
	}
	if err := s.store.CreateAsset(ctx, asset); err != nil {
		return nil, err
	}
	return asset, nil
}

// positiveOrNil — размеры картинки в строку вложения: ноль означает «неизвестно».
func positiveOrNil(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

// StoreFileOptions — готовый файл для записи в проект (импорт папки с md).
type StoreFileOptions struct {
	ProjectID uuid.UUID
	OwnerID   uuid.UUID
	Filename  string
	Mime      string
	Kind      string
	Data      []byte
}

// StoreFile кладёт в проект готовый файл — тем же путём, что и загрузка из
// интерфейса: с пережатием картинок и с дедупликацией по содержимому. Иначе импорт
// обходил бы и то, и другое: файл лежал бы дважды и в исходном весе.
func (s *Service) StoreFile(ctx context.Context, opts StoreFileOptions) (*store.Asset, error) {
	if opts.Mime == "" {
		opts.Mime = MimeOf(opts.Filename)
	}
	if opts.Kind == "" {
		opts.Kind = KindOf(opts.Mime, opts.Filename)
	}
	if media.Recompressible(opts.Mime, int64(len(opts.Data))) {
		return s.storeImage(ctx, opts.ProjectID, opts.OwnerID, opts.Filename, opts.Mime, opts.Data)
	}
	return s.storeBytes(ctx, opts.ProjectID, opts.OwnerID, putFile{
		Name: opts.Filename,
		Mime: opts.Mime,
		Kind: opts.Kind,
		Size: int64(len(opts.Data)),
	}, opts.Data)
}

// Open — открывает поток для скачивания (после авторизации).
func (s *Service) Open(ctx context.Context, actorID, assetID uuid.UUID) (io.ReadCloser, *store.Asset, error) {
	a, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := s.proj.Get(ctx, actorID, a.ProjectID); err != nil {
		return nil, nil, err
	}
	rc, err := s.obj.Get(ctx, a.S3Key)
	if err != nil {
		return nil, nil, err
	}
	return rc, a, nil
}

// OpenPublic — публичное чтение ассета: доступно без авторизации, но ТОЛЬКО если
// проект, которому принадлежит файл, опубликован (projects.is_public). Это тот же
// контур, что и публичная история: снятие с публикации закрывает и картинки.
func (s *Service) OpenPublic(ctx context.Context, assetID uuid.UUID) (io.ReadCloser, *store.Asset, error) {
	a, err := s.store.GetAsset(ctx, assetID)
	if err != nil {
		return nil, nil, err
	}
	p, err := s.store.GetProject(ctx, a.ProjectID)
	if err != nil {
		return nil, nil, err
	}
	if !p.IsPublic {
		return nil, nil, store.ErrNotFound
	}
	rc, err := s.obj.Get(ctx, a.S3Key)
	if err != nil {
		return nil, nil, err
	}
	return rc, a, nil
}

// List — вложения проекта (для списка файлов и для уборки).
func (s *Service) List(ctx context.Context, actorID, projectID uuid.UUID) ([]store.Asset, error) {
	if _, err := s.proj.Get(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.store.ListAssets(ctx, projectID)
}

// RecompressReport — что дал проход по уже загруженным файлам.
//
// «Пропущено» и «битый» — разные вещи, и путать их нельзя: по отчёту решают,
// стоит ли вообще запускать пережатие. Если свести оба случая в одно число,
// вывод «пережатие не выигрывает на PNG» может оказаться выводом «эти PNG не
// декодируются» — а это уже вопрос к содержимому хранилища, а не к кодировщику.
type RecompressReport struct {
	// Files — сколько уникальных файлов в хранилище просмотрено.
	Files int `json:"files"`
	// Images — из них растровых картинок подходящего размера, то есть тех, что
	// вообще подлежат пережатию. Остальное (svg, pdf, аудио, слишком большие
	// файлы) дальше не считается: пережимать там нечего.
	Images int `json:"images"`
	// Changed — сколько файлов стало меньше (и было переписано, если Applied).
	Changed int `json:"changed"`
	// Skipped — картинка разобралась, но webp не меньше исходника.
	Skipped int `json:"skipped"`
	// Damaged — картинку не удалось декодировать или закодировать. Это не беда
	// хранения: файл остаётся как есть. Но и не «нет выигрыша» — поэтому отдельно.
	Damaged int `json:"damaged"`
	// Failed — не удалось прочитать или записать: файл остался как был.
	Failed int `json:"failed"`
	// DamagedExamples — несколько ключей битых файлов: без них по одному числу
	// непонятно, что именно лежит в хранилище.
	DamagedExamples []string `json:"damaged_examples,omitempty"`
	// BytesFrom/BytesTo — вес изменённых файлов до и после.
	BytesFrom int64 `json:"bytes_from"`
	BytesTo   int64 `json:"bytes_to"`
	// Applied — false означает «только посчитали» (сухой прогон).
	Applied bool `json:"applied"`
}

// recompressExamples — сколько битых файлов показывать в отчёте.
const recompressExamples = 10

// RecompressStored пережимает уже загруженные картинки: то, что загружено до
// появления пережатия, осталось в исходном весе.
//
// projectID ограничивает проход одним проектом (nil — все). Сухой прогон
// (apply=false) считает выигрыш и ничего не пишет — по нему видно, стоит ли
// запускать; так же устроена уборка хранилища.
//
// Файл переписывается под НОВЫМ ключом (расширение в ключе должно соответствовать
// содержимому), а строки начинают на него ссылаться. Если пережатое содержимое уже
// есть в хранилище (та же картинка попала в проект дважды), строки переводятся на
// существующий файл: дедупликация продолжает работать и после пережатия.
func (s *Service) RecompressStored(ctx context.Context, projectID *uuid.UUID, apply bool) (*RecompressReport, error) {
	files, err := s.store.StoredFileKeys(ctx)
	if err != nil {
		return nil, err
	}
	report := &RecompressReport{Applied: apply}
	for _, file := range files {
		if projectID != nil && file.ProjectID != *projectID {
			continue
		}
		report.Files++
		data, err := s.readObject(ctx, file.S3Key)
		if err != nil {
			s.logger.Warn("recompress: file read failed", "key", file.S3Key, "err", err)
			report.Failed++
			continue
		}
		if !media.Recompressible(file.Mime, int64(len(data))) {
			continue
		}
		report.Images++
		result, err := media.Recompress(file.Filename, file.Mime, data)
		if err != nil {
			// Не декодировалось — оставляем файл как есть: это не ошибка хранения.
			// В лог пишем подробности, в отчёт — ключ и общее число.
			s.logger.Debug("recompress: image not decodable", "key", file.S3Key, "err", err)
			report.Damaged++
			if len(report.DamagedExamples) < recompressExamples {
				report.DamagedExamples = append(report.DamagedExamples, file.S3Key)
			}
			continue
		}
		if !result.Changed {
			report.Skipped++
			continue
		}
		report.Changed++
		report.BytesFrom += int64(len(data))
		report.BytesTo += int64(len(result.Data))
		if !apply {
			continue
		}
		if err := s.replaceStoredFiles(ctx, file, result); err != nil {
			s.logger.Warn("recompress: file not replaced", "key", file.S3Key, "err", err)
			report.Failed++
			report.Changed--
			report.BytesFrom -= int64(len(data))
			report.BytesTo -= int64(len(result.Data))
		}
	}
	return report, nil
}

// replaceStoredFiles переписывает файл и переводит на него все строки вложений.
func (s *Service) replaceStoredFiles(ctx context.Context, file store.Asset, result media.Result) error {
	rows, err := s.store.ListAssetsByKey(ctx, file.S3Key)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	digest := sha256.Sum256(result.Data)
	hash := hex.EncodeToString(digest[:])

	// Такой файл уже есть — второй раз не пишем, переводим строки на него.
	target := ""
	existing, err := s.store.FindAssetByHash(ctx, hash)
	if err != nil {
		return err
	}
	switch {
	case existing != nil && existing.S3Key != file.S3Key:
		target = existing.S3Key
	default:
		target = ObjectKey(file.ProjectID, result.Filename)
		if err := s.obj.Put(ctx, target, result.Mime, bytes.NewReader(result.Data), int64(len(result.Data))); err != nil {
			return err
		}
	}

	for _, row := range rows {
		patch := store.AssetFilePatch{
			S3Key:       target,
			Filename:    media.WebpName(row.Filename),
			Mime:        result.Mime,
			Kind:        KindOf(result.Mime, row.Filename),
			Size:        int64(len(result.Data)),
			ContentHash: &hash,
			Width:       positiveOrNil(result.Width),
			Height:      positiveOrNil(result.Height),
		}
		if err := s.store.UpdateAssetFile(ctx, row.ID, patch); err != nil {
			// Строка не обновилась — файл трогать нельзя: на него ещё ссылаются.
			return err
		}
	}
	// Старый файл убираем, если на него больше никто не ссылается (после
	// дедупликации ключ мог быть общим для нескольких проектов).
	if target != file.S3Key {
		if _, err := s.DeleteUnreferencedFiles(ctx, []string{file.S3Key}); err != nil {
			return err
		}
	}
	return nil
}

// readObject читает файл из хранилища целиком: пережатие требует всех байтов.
func (s *Service) readObject(ctx context.Context, key string) ([]byte, error) {
	rc, err := s.obj.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// ProjectFileKeys — ключи файлов проекта: то, что нужно убрать, когда проект
// удаляют.
//
// Собирать их обязательно ДО удаления строки проекта: строки вложений уходят
// каскадом (`assets.project_id … ON DELETE CASCADE`), и после удаления о файлах
// уже нечего спросить — они остались бы в хранилище навсегда.
func (s *Service) ProjectFileKeys(ctx context.Context, projectID uuid.UUID) ([]string, error) {
	assets, err := s.store.ListAssets(ctx, projectID)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(assets))
	for _, asset := range assets {
		keys = append(keys, asset.S3Key)
	}
	return keys, nil
}

// DeleteUnreferencedFiles убирает файлы, на которые больше не ссылается ни одна
// строка вложений, и возвращает число удалённых.
// Проверка ссылок обязательна после дедупликации: одним файлом могут пользоваться
// несколько проектов, и удаление одного из них не должно уносить картинку у
// остальных. Вызывается ПОСЛЕ удаления строк (проект уносит свои вложения
// каскадом) — тогда «сколько осталось ссылок» и есть ответ на вопрос «нужен ли
// файл ещё кому-нибудь».
//
// Ошибка на отдельном файле не прерывает уборку: остальные всё равно надо убрать,
// а потерянный объект найдёт уборщик хранилища (maintenance.Sweeper).
func (s *Service) DeleteUnreferencedFiles(ctx context.Context, keys []string) (int, error) {
	removed := 0
	var firstErr error
	for _, key := range keys {
		if key == "" {
			continue
		}
		refs, err := s.store.CountAssetsByKey(ctx, key)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if refs > 0 {
			continue
		}
		if err := s.obj.Delete(ctx, key); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		removed++
	}
	return removed, firstErr
}

// helpers

// NormalizeMime — тип файла по заявленному Content-Type и имени: пустой или общий
// `application/octet-stream` заменяется догадкой по расширению, параметры
// (`; charset=…`) срезаются.
func NormalizeMime(ct, filename string) string {
	ct = strings.TrimSpace(strings.ToLower(ct))
	if ct == "" || ct == "application/octet-stream" {
		if guessed := mime.TypeByExtension(filepath.Ext(filename)); guessed != "" {
			return strings.Split(guessed, ";")[0]
		}
	}
	return strings.Split(ct, ";")[0]
}

// MimeOf — тип файла только по имени (для импорта: Content-Type частей multipart
// доверять нельзя, браузер шлёт его по расширению, а из zip его нет вовсе).
func MimeOf(filename string) string {
	return NormalizeMime("", filename)
}

// MimeAllowed — принимает ли проект файлы такого типа. Единый список для загрузки
// из интерфейса и для импорта: то, что нельзя приложить руками, не должно
// появляться и из папки с md.
func MimeAllowed(m string) bool {
	switch {
	case strings.HasPrefix(m, "image/"):
		return true
	case m == "application/pdf":
		return true
	case strings.HasPrefix(m, "audio/"):
		return true
	case strings.HasPrefix(m, "video/"):
		return true
	case m == "application/json" || m == "text/plain" || m == "image/svg+xml":
		return true
	}
	return false
}

// KindOf — вид вложения для списка файлов проекта.
func KindOf(m, filename string) string {
	switch {
	case strings.HasPrefix(m, "image/"):
		if strings.Contains(filename, "sketch") || strings.HasSuffix(strings.ToLower(filename), ".svg") {
			return "sketch"
		}
		return "image"
	case m == "application/pdf":
		return "pdf"
	case strings.HasPrefix(m, "audio/"):
		return "audio"
	case strings.HasPrefix(m, "video/"):
		return "video"
	}
	return "other"
}

func extFromFilename(name string) string {
	ext := filepath.Ext(name)
	if len(ext) > 8 {
		ext = ".bin"
	}
	return ext
}
