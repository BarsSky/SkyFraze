// Package storage: S3Store — объектное хранилище S3/MinIO за тем же интерфейсом.
//
// Зачем своя подпись, а не SDK. Задача узкая: пять операций (Put/Get/Delete/Stat/List).
// aws-sdk-go тянет десятки пакетов и мегабайты кода ради того же SigV4; проект до сих пор
// обходится без тяжёлых зависимостей (книгу и DOCX тоже собираем сами). Подпись — это
// ~80 строк, а её правильность проверяется официальными тестовыми векторами AWS
// (см. s3_sign_test.go).
//
// Что здесь важно знать, трогая файл:
//
//  1. Хеш тела участвует в подписи. Поэтому тело сначала пишется во временный файл
//     (там же считается SHA-256), а потом отправляется: читать 50-мегабайтный файл в
//     память ради хеша — лишние 50 МБ RSS на каждую загрузку.
//  2. Ключи в бакете — те же, что на диске (`<project_id>/<uuid>.<ext>`): благодаря этому
//     переезд с локального хранилища — это копирование файлов, а не миграция базы.
//  3. Not found — это `storage.ErrNotFound`, а не ошибка S3: вызывающий код (сервис
//     вложений, отдача файла) уже умеет отличать «нет файла» от «сломалось».
package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// S3Config — настройки объектного хранилища.
type S3Config struct {
	// Endpoint — `https://minio.example.com` (схема важна: http для локального стенда,
	// https для внешнего). Если схема не указана, берётся из UseSSL.
	Endpoint string
	UseSSL   bool
	Bucket   string
	// Prefix — необязательный префикс ключей внутри бакета (`skyfraze/`): один бакет на
	// несколько стендов или окружений.
	Prefix    string
	AccessKey string
	SecretKey string
	Region    string
	// HTTPClient — для тестов; по умолчанию http.DefaultClient.
	HTTPClient *http.Client
}

// S3Store — S3-совместимое хранилище объектов.
type S3Store struct {
	endpoint  *url.URL
	bucket    string
	prefix    string
	accessKey string
	secretKey string
	region    string
	client    *http.Client
}

// NewS3 собирает хранилище и проверяет настройки до первого запроса: пустой endpoint или
// ключ означают, что стенд настроен наполовину, и узнать об этом лучше на старте, чем на
// первой загрузке файла.
func NewS3(cfg S3Config) (*S3Store, error) {
	raw := strings.TrimSpace(cfg.Endpoint)
	if raw == "" {
		return nil, errors.New("storage: S3_ENDPOINT не задан")
	}
	if !strings.Contains(raw, "://") {
		scheme := "http"
		if cfg.UseSSL {
			scheme = "https"
		}
		raw = scheme + "://" + raw
	}
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Host == "" {
		return nil, fmt.Errorf("storage: S3_ENDPOINT не разобран: %q", cfg.Endpoint)
	}
	if strings.TrimSpace(cfg.Bucket) == "" {
		return nil, errors.New("storage: S3_BUCKET не задан")
	}
	if strings.TrimSpace(cfg.AccessKey) == "" || strings.TrimSpace(cfg.SecretKey) == "" {
		return nil, errors.New("storage: S3_KEY/S3_SECRET не заданы")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "us-east-1"
	}
	prefix := strings.Trim(strings.TrimSpace(cfg.Prefix), "/")
	if prefix != "" {
		prefix += "/"
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	return &S3Store{
		endpoint: endpoint, bucket: cfg.Bucket, prefix: prefix,
		accessKey: cfg.AccessKey, secretKey: cfg.SecretKey, region: region, client: client,
	}, nil
}

// objectKey — ключ в бакете с учётом префикса стенда.
func (s *S3Store) objectKey(key string) (string, error) {
	if key == "" || strings.Contains(key, "..") || strings.HasPrefix(key, "/") {
		return "", fmt.Errorf("invalid key: %q", key)
	}
	return s.prefix + key, nil
}

// Put записывает объект. Тело сначала уходит во временный файл: хеш содержимого нужен
// для подписи, а держать 50 МБ в памяти на каждую загрузку — плохая идея.
func (s *S3Store) Put(ctx context.Context, key, contentType string, r io.Reader, size int64) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp("", "skyfraze-upload-*")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(tmp, hash), r)
	if err != nil {
		return err
	}
	if size > 0 && written != size {
		// Размер обещан вызывающим: расхождение — ошибка вызывающего, но узнать о ней
		// лучше здесь, чем получить в бакете обрезанный файл.
		return fmt.Errorf("storage: размер тела %d, ожидался %d", written, size)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	headers := http.Header{}
	if contentType != "" {
		headers.Set("Content-Type", contentType)
	}
	headers.Set("x-amz-content-sha256", hex.EncodeToString(hash.Sum(nil)))
	resp, err := s.do(ctx, http.MethodPut, objectKey, nil, tmp, written, headers)
	if err != nil {
		return err
	}
	return drainClose(resp, http.StatusOK)
}

// Get отдаёт объект потоком: вызывающий сам закрывает тело.
func (s *S3Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}
	resp, err := s.do(ctx, http.MethodGet, objectKey, nil, nil, 0, nil)
	if err != nil {
		return nil, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return resp.Body, nil
	case http.StatusNotFound:
		resp.Body.Close()
		return nil, ErrNotFound
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("storage: GET %s: %s: %s", key, resp.Status, strings.TrimSpace(string(body)))
	}
}

// Delete удаляет объект. Отсутствие объекта — не ошибка: уборщик удаляет то, что уже
// могло исчезнуть, и «нечего удалять» не должно считать это сбоем.
func (s *S3Store) Delete(ctx context.Context, key string) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}
	resp, err := s.do(ctx, http.MethodDelete, objectKey, nil, nil, 0, nil)
	if err != nil {
		return err
	}
	switch resp.StatusCode {
	case http.StatusNoContent, http.StatusOK, http.StatusNotFound:
		resp.Body.Close()
		return nil
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return fmt.Errorf("storage: DELETE %s: %s: %s", key, resp.Status, strings.TrimSpace(string(body)))
	}
}

// Stat — размер, тип и время объекта (по HEAD, без тела).
func (s *S3Store) Stat(ctx context.Context, key string) (*ObjectInfo, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}
	resp, err := s.do(ctx, http.MethodHead, objectKey, nil, nil, 0, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		return nil, fmt.Errorf("storage: HEAD %s: %s", key, resp.Status)
	}
	info := &ObjectInfo{
		Key:         key,
		Size:        resp.ContentLength,
		ContentType: resp.Header.Get("Content-Type"),
	}
	if modified := resp.Header.Get("Last-Modified"); modified != "" {
		if t, parseErr := http.ParseTime(modified); parseErr == nil {
			info.ModTime = t
		}
	}
	return info, nil
}

// List перечисляет объекты с префиксом — удобно для мелких задач и тестов.
// Для уборки предпочтителен Walk: он не собирает всё в память.
func (s *S3Store) List(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	var out []ObjectInfo
	if err := s.Walk(ctx, prefix, func(info ObjectInfo) error {
		out = append(out, info)
		return nil
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// Walk перечисляет объекты с префиксом постранично, отдавая их по одному.
//
// Страница — 1000 объектов (предел S3), и следующая запрашивается только тогда, когда
// предыдущая обработана: иначе на бакете в сотни тысяч объектов память съел бы сам список.
// Пустой префикс — законный запрос «всё»: уборщик осиротевших файлов обходит хранилище
// целиком. Префикс стенда при этом добавляется всегда: иначе в уборку попадут чужие объекты
// того же бакета (другой стенд, ручные выгрузки).
func (s *S3Store) Walk(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	if strings.Contains(prefix, "..") || strings.HasPrefix(prefix, "/") {
		return fmt.Errorf("invalid key: %q", prefix)
	}
	fullPrefix := s.prefix + prefix
	token := ""
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		query := url.Values{}
		query.Set("list-type", "2")
		if fullPrefix != "" {
			query.Set("prefix", fullPrefix)
		}
		if token != "" {
			query.Set("continuation-token", token)
		}
		resp, err := s.do(ctx, http.MethodGet, "", query, nil, 0, nil)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			return fmt.Errorf("storage: LIST %s: %s: %s", prefix, resp.Status, strings.TrimSpace(string(body)))
		}
		var page listBucketResult
		decodeErr := xml.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if decodeErr != nil {
			return fmt.Errorf("storage: LIST %s: разбор ответа: %w", prefix, decodeErr)
		}
		for _, item := range page.Contents {
			if err := fn(ObjectInfo{
				Key:     strings.TrimPrefix(item.Key, s.prefix),
				Size:    item.Size,
				ModTime: item.LastModified,
			}); err != nil {
				return err
			}
		}
		if !page.IsTruncated || page.NextToken == "" {
			return nil
		}
		token = page.NextToken
	}
}

type listBucketResult struct {
	XMLName     xml.Name `xml:"ListBucketResult"`
	IsTruncated bool     `xml:"IsTruncated"`
	NextToken   string   `xml:"NextContinuationToken"`
	Contents    []struct {
		Key          string    `xml:"Key"`
		Size         int64     `xml:"Size"`
		LastModified time.Time `xml:"LastModified"`
	} `xml:"Contents"`
}

// do — один подписанный запрос. path пустой означает запрос к бакету (LIST).
func (s *S3Store) do(
	ctx context.Context, method, objectKey string, query url.Values,
	body io.Reader, size int64, headers http.Header,
) (*http.Response, error) {
	path := "/" + s.bucket
	if objectKey != "" {
		path += "/" + objectKey
	}
	u := *s.endpoint
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawQuery = canonicalQuery(query)

	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	for name, values := range headers {
		for _, value := range values {
			req.Header.Set(name, value)
		}
	}
	if size > 0 {
		req.ContentLength = size
	}
	if req.Header.Get("Host") == "" {
		req.Host = s.endpoint.Host
	}
	signV4(req, s.accessKey, s.secretKey, s.region, time.Now().UTC())
	return s.client.Do(req)
}

// canonicalQuery — параметры по алфавиту с AWS-кодированием (пробел → %20, `~` не кодируется).
func canonicalQuery(query url.Values) string {
	if len(query) == 0 {
		return ""
	}
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		values := append([]string(nil), query[key]...)
		sort.Strings(values)
		for _, value := range values {
			parts = append(parts, awsEncode(key, true)+"="+awsEncode(value, true))
		}
	}
	return strings.Join(parts, "&")
}

// awsEncode — кодирование по правилам SigV4: буквы, цифры, `-_.~` остаются как есть,
// всё прочее — %XX заглавными буквами. `/` кодируется только когда это не путь.
func awsEncode(value string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// signV4 подписывает запрос SigV4. Канонизируются ВСЕ заголовки, которые отправляются,
// кроме `Authorization`: так подпись остаётся верной и когда к запросу добавили
// Content-Type, и когда подписывается тестовый вектор AWS с Range.
func signV4(req *http.Request, accessKey, secretKey, region string, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	if req.Header.Get("x-amz-content-sha256") == "" {
		// Тело запроса без «x-amz-content-sha256» — только пустое (GET/DELETE/HEAD).
		req.Header.Set("x-amz-content-sha256", emptySHA256)
	}

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}

	type pair struct{ name, value string }
	pairs := make([]pair, 0, len(req.Header)+1)
	pairs = append(pairs, pair{"host", host})
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if lower == "authorization" || lower == "content-length" {
			continue
		}
		for _, value := range values {
			pairs = append(pairs, pair{lower, strings.TrimSpace(value)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].name < pairs[j].name })

	var canonicalHeaders, signedHeaders strings.Builder
	for i, p := range pairs {
		canonicalHeaders.WriteString(p.name + ":" + p.value + "\n")
		if i > 0 {
			signedHeaders.WriteString(";")
		}
		signedHeaders.WriteString(p.name)
	}

	canonicalRequest := strings.Join([]string{
		req.Method,
		// Путь канонизируется в РАСКОДИРОВАННОМ виде: EscapedPath уже содержит %XX, и
		// повторное кодирование дало бы %25XX — подпись разошлась бы с сервером.
		awsEncode(req.URL.Path, false),
		canonicalQuery(req.URL.Query()),
		canonicalHeaders.String(),
		signedHeaders.String(),
		req.Header.Get("x-amz-content-sha256"),
	}, "\n")

	scope := dateStamp + "/" + region + "/s3/aws4_request"
	sum := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, hex.EncodeToString(sum[:]),
	}, "\n")

	key := hmacSHA256([]byte("AWS4"+secretKey), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey, scope, signedHeaders.String(), signature))
}

const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// drainClose дочитывает и закрывает тело: без этого соединение не вернётся в пул.
func drainClose(resp *http.Response, wantStatus int) error {
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode != wantStatus && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("storage: %s: %s: %s", resp.Request.Method, resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}
