package ai

// stream.go — потоковый ответ модели: текст приходит по мере генерации.
//
// Зачем это. Обычный Chat ждёт ответ целиком: на локальной модели это десятки секунд
// тишины, и человек не понимает, работает помощник или повис. Поток отдаёт текст
// кусками, а сервер пересылает их в браузер событиями SSE — так же, как это делают
// сами провайдеры.
//
// Контракт один для обоих видов провайдеров (Ollama и OpenAI-совместимые):
//
//   - onText получает ТОЛЬКО приращения текста и может вызываться много раз;
//   - вызовы инструментов собираются на нашей стороне и возвращаются готовыми в Reply:
//     показывать человеку половину вызова бессмысленно, а выполнить можно только целый;
//   - ошибка из onText прекращает генерацию — так останавливается ответ, когда писать
//     больше некуда (браузер закрыл соединение или человек нажал «стоп»);
//   - ошибка провайдера ПОСРЕДИ потока возвращается ошибкой, а не коротким ответом:
//     молча показать половину текста и не сказать, что он оборван, нельзя.
//
// Что здесь общего, а что в клиентах: форматы у провайдеров разные (Ollama — строки
// JSON, OpenAI — события SSE), поэтому разбор живёт в клиентах, а чтение строк и
// пределы на размер — тут.

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
)

// Столько байт потока принимаем от провайдера. Ответ модели на страницу текста —
// десятки килобайт; предел нужен, чтобы сбойный или враждебный сервер не заставил
// нас читать бесконечный поток в память.
const maxStreamBytes = 16 << 20

// Столько байт в одной строке. У Ollama это один JSON-объект, у OpenAI — одно
// событие SSE; щедрый предел, потому что кусок вызова инструмента может быть большим.
const maxStreamLine = 4 << 20

// Streamer — клиент, который умеет отдавать ответ по мере генерации.
//
// Отдельный интерфейс, а не метод в Client: не всякий клиент обязан уметь поток
// (заглушки в тестах, будущие провайдеры), и заставлять всех реализовывать его —
// значит получить «поток», который на самом деле ждёт весь ответ. Кто не умеет —
// работает через Chat, и вызывающий этого даже не замечает (см. Service.StreamChat).
type Streamer interface {
	ChatStream(ctx context.Context, req Request, onText func(string) error) (Reply, error)
}

// errStreamEnd — служебный признак «провайдер сказал [DONE]»: это не ошибка, а
// нормальный конец потока SSE.
var errStreamEnd = errors.New("поток завершён")

// streamReader считает прочитанное и не даёт потоку расти без предела.
type streamReader struct {
	r         *bufio.Reader
	remaining int
}

func newStreamReader(r io.Reader) *streamReader {
	return &streamReader{r: bufio.NewReaderSize(r, 64<<10), remaining: maxStreamBytes}
}

// nextLine отдаёт строку без завершающего перевода строки.
func (s *streamReader) nextLine() (string, error) {
	line, err := s.r.ReadString('\n')
	if len(line) > maxStreamLine {
		return "", errors.New("строка потока длиннее предела")
	}
	s.remaining -= len(line)
	if s.remaining < 0 {
		return "", errors.New("поток ответа длиннее предела — ответ оборван")
	}
	if err != nil {
		if len(line) > 0 {
			// Последняя строка без перевода строки — отдаём её, ошибку вернём следом.
			return strings.TrimRight(line, "\r\n"), nil
		}
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// readJSONLines читает поток построчных JSON-объектов (формат Ollama).
func readJSONLines(r io.Reader, onLine func([]byte) error) error {
	s := newStreamReader(r)
	for {
		line, err := s.nextLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		if cbErr := onLine([]byte(line)); cbErr != nil {
			return cbErr
		}
	}
}

// readSSE читает поток событий SSE (формат OpenAI-совместимых серверов).
//
// Разбираем только поле `data` — остальные (`event`, `id`, комментарии-«пинги»)
// для ответа модели не значат ничего. Несколько строк data подряд склеиваются: так
// велит формат, и разбирать их порознь значило бы иногда терять половину события.
func readSSE(r io.Reader, onData func(string) error) error {
	s := newStreamReader(r)
	var pending []string
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		payload := strings.Join(pending, "\n")
		pending = pending[:0]
		return onData(payload)
	}
	for {
		line, err := s.nextLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Поток кончился без пустой строки: отдаём то, что успело прийти,
				// чтобы обрыв связи не съел последний кусок ответа.
				return flush()
			}
			return err
		}
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // комментарий: так серверы держат соединение живым
		}
		field, value, found := strings.Cut(line, ":")
		if !found || field != "data" {
			continue
		}
		pending = append(pending, strings.TrimPrefix(value, " "))
	}
}

// streamEndOrError приводит ошибку чтения потока к понятному виду: конец по [DONE] —
// не ошибка, а отмена контекста возвращается как есть, чтобы вызывающий отличил
// «человек нажал стоп» от «провайдер сломался».
func streamEndOrError(err error) error {
	if err == nil || errors.Is(err, errStreamEnd) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
