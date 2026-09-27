// Package update — механизм обновления развёрнутого стенда.
//
// Как это устроено и почему так:
//   - приложение работает в контейнере, а исходники и docker-compose живут на хосте,
//     поэтому сам контейнер обновляться не может (и не должен: docker.sock в веб-процессе
//     — это root на хосте);
//   - админка умеет только ПРОВЕРЯТЬ обновления (GitHub Releases API) и ОСТАВЛЯТЬ ЗАЯВКУ
//     на обновление в каталоге состояния, который смонтирован с хоста;
//   - на хосте заявку подхватывает systemd path-юнит и запускает
//     deploy/skyfraze-update.sh (git fetch + checkout тега + docker compose up -d --build),
//     записывая прогресс в тот же каталог;
//   - админка показывает состояние и лог последнего обновления.
//
// Такой контур повторяет подход skygate: страница обновления + внешний применятель,
// который можно запустить и руками.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Состояния процесса обновления (значение поля status в status.json).
const (
	StateIdle      = "idle"
	StateRequested = "requested"
	StateRunning   = "running"
	StateDone      = "done"
	StateFailed    = "failed"
)

const (
	requestFile = "request.json"
	statusFile  = "status.json"
	logFile     = "update.log"

	// cacheTTL — как долго держим ответ GitHub, чтобы не долбить API лимитами.
	cacheTTL = 10 * time.Minute
)

// Release — то, что нужно показать в админке по последнему релизу.
type Release struct {
	Tag         string    `json:"tag"`
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	Notes       string    `json:"notes,omitempty"`
	PublishedAt time.Time `json:"published_at"`
	Prerelease  bool      `json:"prerelease"`
}

// Request — заявка на обновление (её читает хост-скрипт).
type Request struct {
	Target      string    `json:"target"`
	RequestedBy string    `json:"requested_by"`
	RequestedAt time.Time `json:"requested_at"`
}

// Status — что происходит сейчас (её пишет хост-скрипт).
type Status struct {
	Status    string    `json:"status"`
	Target    string    `json:"target,omitempty"`
	Message   string    `json:"message,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
	EndedAt   time.Time `json:"ended_at,omitempty"`
	Commit    string    `json:"commit,omitempty"`
}

// CheckResult — ответ страницы обновления.
type CheckResult struct {
	Current     string   `json:"current"`
	Commit      string   `json:"commit"`
	Repo        string   `json:"repo"`
	Configured  bool     `json:"configured"`
	Latest      *Release `json:"latest,omitempty"`
	UpdateAvail bool     `json:"update_available"`
	CheckedAt   time.Time `json:"checked_at"`
	Error       string   `json:"error,omitempty"`
}

type Service struct {
	repo      string // owner/name
	token     string
	channel   string // stable | any
	version   string
	commit    string
	stateDir  string
	client    *http.Client

	mu       sync.Mutex
	cached   *CheckResult
	cachedAt time.Time
}

func New(repo, token, channel, version, commit, stateDir string) *Service {
	if channel == "" {
		channel = "stable"
	}
	return &Service{
		repo:     strings.TrimSpace(repo),
		token:    strings.TrimSpace(token),
		channel:  channel,
		version:  version,
		commit:   commit,
		stateDir: stateDir,
		client:   &http.Client{Timeout: 12 * time.Second},
	}
}

// Configured — задан ли репозиторий: без него проверка бессмысленна.
func (s *Service) Configured() bool { return s.repo != "" }

// Check спрашивает GitHub о последнем релизе. force — обойти кэш («Проверить сейчас»).
func (s *Service) Check(ctx context.Context, force bool) *CheckResult {
	s.mu.Lock()
	if !force && s.cached != nil && time.Since(s.cachedAt) < cacheTTL {
		cached := *s.cached
		s.mu.Unlock()
		return &cached
	}
	s.mu.Unlock()

	res := &CheckResult{
		Current:   s.version,
		Commit:    s.commit,
		Repo:      s.repo,
		Configured: s.Configured(),
		CheckedAt: time.Now().UTC(),
	}
	if !s.Configured() {
		res.Error = "репозиторий не настроен: укажите UPDATE_REPO=owner/name"
		return s.store(res)
	}

	release, err := s.fetchLatest(ctx)
	if err != nil {
		res.Error = err.Error()
		return s.store(res)
	}
	res.Latest = release
	res.UpdateAvail = release != nil && isNewer(release.Tag, s.version)
	return s.store(res)
}

func (s *Service) store(res *CheckResult) *CheckResult {
	s.mu.Lock()
	s.cached = res
	s.cachedAt = time.Now()
	s.mu.Unlock()
	return res
}

// apiBase — адрес GitHub API. Переменная, а не константа: тесты подменяют её
// локальным сервером, чтобы не зависеть от сети и лимитов GitHub.
var apiBase = "https://api.github.com"

func (s *Service) fetchLatest(ctx context.Context) (*Release, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", apiBase, s.repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "SkyFraze-update-check")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub недоступен: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, errors.New("в репозитории нет релизов (или он приватный и токен не задан)")
	case http.StatusForbidden, http.StatusTooManyRequests:
		return nil, errors.New("GitHub ограничил запросы: попробуйте позже или задайте UPDATE_TOKEN")
	default:
		return nil, fmt.Errorf("GitHub ответил %d", resp.StatusCode)
	}

	var payload struct {
		TagName     string    `json:"tag_name"`
		Name        string    `json:"name"`
		HTMLURL     string    `json:"html_url"`
		Body        string    `json:"body"`
		PublishedAt time.Time `json:"published_at"`
		Prerelease  bool      `json:"prerelease"`
		Draft       bool      `json:"draft"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("разбор ответа GitHub: %w", err)
	}
	if payload.Draft {
		return nil, errors.New("последний релиз — черновик")
	}
	if s.channel == "stable" && payload.Prerelease {
		return nil, errors.New("последний релиз — предрелиз, а канал stable")
	}
	notes := payload.Body
	if len(notes) > 4000 {
		notes = notes[:4000] + "…"
	}
	return &Release{
		Tag: payload.TagName, Name: payload.Name, URL: payload.HTMLURL,
		Notes: notes, PublishedAt: payload.PublishedAt, Prerelease: payload.Prerelease,
	}, nil
}

// isNewer — сравнение версий вида v0.2.1 / 0.2.1 / dev.
// «dev» и пустая версия считаются старее любого релиза.
func isNewer(latest, current string) bool {
	l := normalizeVersion(latest)
	c := normalizeVersion(current)
	if c == "" {
		return l != ""
	}
	if l == "" {
		return false
	}
	lp, cp := strings.Split(l, "."), strings.Split(c, ".")
	for i := 0; i < len(lp) || i < len(cp); i++ {
		var a, b int
		if i < len(lp) {
			fmt.Sscanf(lp[i], "%d", &a)
		}
		if i < len(cp) {
			fmt.Sscanf(cp[i], "%d", &b)
		}
		if a != b {
			return a > b
		}
	}
	return false
}

func normalizeVersion(v string) string {
	v = strings.TrimSpace(strings.ToLower(v))
	v = strings.TrimPrefix(v, "v")
	// отрезаем суффиксы сборки: 0.2.1+3-gabc123 → 0.2.1
	if i := strings.IndexAny(v, "+-"); i >= 0 {
		v = v[:i]
	}
	if v == "" || v == "dev" || v == "unknown" {
		return ""
	}
	return v
}

// ---------- заявка и состояние (общий каталог с хостом) ----------

// RequestUpdate оставляет заявку на обновление: её подхватит systemd на хосте.
func (s *Service) RequestUpdate(target, by string) (*Request, error) {
	if s.stateDir == "" {
		return nil, errors.New("каталог состояния обновления не настроен (UPDATE_STATE_DIR)")
	}
	if err := os.MkdirAll(s.stateDir, 0o775); err != nil {
		return nil, err
	}
	if st, _ := s.Status(); st != nil && (st.Status == StateRequested || st.Status == StateRunning) {
		return nil, fmt.Errorf("обновление уже идёт: %s", st.Status)
	}
	req := &Request{Target: target, RequestedBy: by, RequestedAt: time.Now().UTC()}
	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath.Join(s.stateDir, requestFile), data, 0o664); err != nil {
		return nil, err
	}
	// Сразу помечаем «запрошено»: иначе между заявкой и стартом скрипта страница
	// показывала бы «ничего не происходит» и админ нажимал бы кнопку повторно.
	status, _ := json.MarshalIndent(Status{
		Status:    StateRequested,
		Target:    target,
		Message:   "заявка создана, ждём примененителя на хосте",
		StartedAt: time.Now().UTC(),
	}, "", "  ")
	_ = os.WriteFile(filepath.Join(s.stateDir, statusFile), status, 0o664)
	return req, nil
}

// Status читает состояние, записанное хост-скриптом.
func (s *Service) Status() (*Status, error) {
	if s.stateDir == "" {
		return nil, nil
	}
	data, err := os.ReadFile(filepath.Join(s.stateDir, statusFile))
	if err != nil {
		return nil, err
	}
	var st Status
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

// Log отдаёт хвост лога последнего обновления.
func (s *Service) Log(maxBytes int64) string {
	if s.stateDir == "" {
		return ""
	}
	f, err := os.Open(filepath.Join(s.stateDir, logFile))
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	offset := int64(0)
	if st.Size() > maxBytes {
		offset = st.Size() - maxBytes
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return ""
	}
	data, _ := io.ReadAll(io.LimitReader(f, maxBytes))
	if offset > 0 {
		return "…\n" + string(data)
	}
	return string(data)
}
