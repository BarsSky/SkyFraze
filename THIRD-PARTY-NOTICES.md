# Сторонние компоненты и их лицензии

Собрано 2026-10-29 лицензионным аудитом (проверялись `backend/go.mod`, `go.sum`,
`frontend/package.json` и `node_modules`, кеш модулей Go, сабмодули, содержимое `frontend/dist`).
Пересобирать этот файл стоит при добавлении зависимости, попадающей в продукт.

Правило проекта: **новые зависимости — только с разрешительной лицензией** (MIT, BSD,
Apache-2.0). Копилефт в рантайме продукта не допускается без явного решения и записи в
`CHANGELOG.md`.

## Что попадает в продукт

### Backend (Go, статически вкомпилирован в бинарь)

| Модуль | Лицензия |
|---|---|
| github.com/Deln0r/ygo | MIT |
| github.com/KarpelesLab/gowebp | MIT |
| github.com/go-chi/chi/v5 | MIT |
| github.com/go-webauthn/webauthn | BSD-3-Clause |
| github.com/golang-jwt/jwt/v5 | MIT |
| github.com/google/uuid | BSD-3-Clause |
| github.com/gorilla/websocket | BSD-2-Clause |
| github.com/jackc/pgx/v5 | MIT |
| github.com/kelseyhightower/envconfig | MIT |
| golang.org/x/crypto | BSD-3-Clause |
| golang.org/x/image | BSD-3-Clause |

Транзитивные модули (28 записей в `go.sum`) — MIT/BSD; GPL/AGPL/MPL/LGPL в дереве нет.
Обязательства BSD/MIT: сохранить copyright и текст лицензии; BSD — не использовать имена
правообладателей для рекламы.

### Frontend (React + Vite, уходит в браузер как JS/CSS)

| Пакет | Лицензия |
|---|---|
| dompurify | MPL-2.0 OR Apache-2.0 — **выбран Apache-2.0** |
| katex | MIT |
| ky | MIT |
| markdown-it | MIT |
| mermaid | MIT |
| react, react-dom | MIT |
| react-router-dom | MIT |
| y-websocket | MIT |
| yjs | MIT |
| zustand | MIT |

Про **dompurify**: лицензия двойная, проект выбирает Apache-2.0 — тогда исходники
санитайзера не попадают под MPL-2.0. Выбор зафиксирован здесь, чтобы следующий аудит не
решил иначе.

### Отдельно: elkjs (EPL-2.0) внутри mermaid

`mermaid` (MIT) в диаграммах потоков подключает `elkjs` — **EPL-2.0**, и это не стиль, а
требование: код реально попадает в сборку. В `frontend/dist/assets` лежит отдельный чанк
`elk-*.js` (~1.5 МБ), который подгружается при показе диаграммы с ELK-layout; образ nginx
раздаёт `dist` клиентам.

Что это значит:

* **на код SkyFraze EPL не распространяется** — EPL действует пофайлово/помодульно, а
  `elkjs` отдельный модуль и не изменён;
* при раздаче клиентской сборки (в том числе Docker-образа) нужно предоставить текст
  **Eclipse Public License 2.0** и способ получить исходник `elkjs`. Оригинал лицензии:
  <https://www.eclipse.org/legal/epl-2.0/>; исходник: <https://github.com/kieler/elkjs>
  (пакет `elkjs@0.9.3`, файл `LICENSE.md` лежит в `node_modules/elkjs/`);
* если однажды окажется, что диаграммы ELK не нужны, модуль можно исключить — тогда этот
  раздел уйдёт вместе с ним.

### Отдельно: libheif-tools (LGPL-3.0) в образе backend

`backend/Dockerfile` ставит пакет `libheif-tools` (alpine) и вызывает `heif-convert` отдельным
процессом, чтобы принимать HEIC/HEIF-картинки. **В бинарь ничего не линкуется** (CGO=0), то
есть LGPL-обязательства выполняются просто: сохранить текст лицензии и возможность заменить
пакет (пакет ставится пакетным менеджером образа, подменить его можно без пересборки
SkyFraze). Если распространяете образ — приложите текст LGPL-3.0 пакета
(<https://www.gnu.org/licenses/lgpl-3.0.html>). Точная версия пакета — та, что даёт базовый
образ `alpine` на момент сборки.

## Что НЕ попадает в продукт

| Пакет / каталог | Лицензия | Почему не ограничивает |
|---|---|---|
| @playwright/test | Apache-2.0 (есть NOTICE) | только для e2e-тестов |
| typescript | Apache-2.0 | только сборка типов |
| vite, vitest, jsdom, tsx, @testing-library/* | MIT | только разработка и тесты |
| @types/* | MIT | только типы |
| `deps/scroll-world` (сабмодуль) | MIT, © 2026 cyw | не входит в сборку: нет ни в `vite.config.ts`, ни в `tsconfig`, ни в `Dockerfile`, ни в CI; используется как справочник |
| `vendor/scroll-world-reference/` | MIT | локальная копия, в репозиторий не входит (`/vendor/` в `.gitignore`) |

## Контент

* Шрифты: файлов в репозитории нет. `'Inter'` указан только как имя в `font-family` — если
  система его не нашла, рендерится системный шрифт. В сборке лежат шрифты KaTeX — это часть
  пакета `katex` (MIT).
* Иллюстрации и иконки: свои (инлайн-SVG и `frontend/public/favicon.svg`), сторонних наборов
  иконок нет.
* `docs/screenshots/*.png` — собственные снимки продукта.

## Как это применять на практике

* Распространяя образ или сборку, приложите: `LICENSE`, `NOTICE`, этот файл, текст EPL-2.0
  (для `elkjs`) и, если раздаёте образ, текст LGPL-3.0 (для `libheif-tools`).
* Правя файл стороннего пакета, помечайте файл как изменённый (требование Apache-2.0 §4(b)).
* Меняя лицензию самого SkyFraze, помните: без подписанного CLA у внешних авторов смена
  лицензии требует их согласия — поэтому решения по PR принимаются с учётом этого.
