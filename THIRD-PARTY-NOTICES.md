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

## Полные тексты лицензий

Сводка выше отвечает на вопрос «под какой лицензией», этот раздел — на вопрос «что именно
приложить». Полные тексты сторонних лицензий лежат в каталоге [`licenses/`](licenses/README.md).

| Файл в `licenses/` | Что покрывает | Объём |
|---|---|---|
| `EPL-2.0.txt` | `elkjs@0.9.3` (транзитивно внутри `mermaid`; чанк `frontend/dist/assets/elk-*.js`) | 14 198 Б, 277 строк |
| `LGPL-3.0.txt` | `libheif-tools` в образе backend (`apk add libheif-tools`, утилита `heif-convert`) | 7 652 Б, 165 строк |
| `go-modules.txt` | 28 Go-модулей из build-list бэкенда: полный текст лицензии каждого модуля и строки copyright | 86 765 Б, 1 452 строки |
| `npm-packages.txt` | 11 прямых зависимостей фронтенда (`dependencies`) плюс `elkjs` | 16 792 Б, 283 строки |

Почему так:

* **Apache-2.0 отдельным файлом не дублируется** — полный текст это корневой `LICENSE`, он
  едет с продуктом в любом варианте поставки. Файл `node_modules/dompurify/LICENSE` байт-в-байт
  совпадает с ним (SHA-256 `CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30`),
  поэтому в `npm-packages.txt` на месте текста dompurify стоит ссылка на корневой `LICENSE` и
  явно сказано, что проект использует альтернативу Apache-2.0, а не MPL-2.0.
* **EPL-2.0** скачан дословно с <https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt>;
  заголовок файла — «Eclipse Public License - v 2.0», он же в `frontend/node_modules/elkjs/LICENSE.md`
  (`elkjs` версии 0.9.3, лицензия в пакете указана как `EPL-2.0`). Исходник `elkjs`:
  <https://github.com/kieler/elkjs>, тэг `v0.9.3`; код модуля не изменён.
* **LGPL-3.0** скачан дословно с <https://www.gnu.org/licenses/lgpl-3.0.txt>. LGPL-3.0
  включает условия GPL-3.0 **по ссылке** (в тексте: «This version of the GNU Lesser General
  Public License incorporates the terms and conditions of version 3 of the GNU General Public
  License, supplemented by the additional permissions listed below»), поэтому текст GPL-3.0
  нужен для полноты, но в репозитории не лежит — он доступен по адресу
  <https://www.gnu.org/licenses/gpl-3.0.txt>; это же указано в `licenses/README.md`. К
  продукту GPL-3.0 относится только через LGPL-3.0 и только для пакета `libheif-tools`,
  который ставится пакетным менеджером образа без изменения.
* **`go-modules.txt` и `npm-packages.txt` не написаны вручную**: это конкатенация реальных
  файлов `LICENSE*` (`COPYING`, `LICENCE*`, плюс `NOTICE`, если он есть) из каталога каждого
  модуля кеша Go и из `frontend/node_modules/<пакет>/`, с блоком-заголовком
  `# модуль@версия — лицензия — имя файла` перед каждым текстом. Строки copyright сохранены
  целиком — ровно этого требуют MIT и BSD. Для 20 записей build-list (тестовые и
  графовые зависимости вроде `stretchr/objx`, `gopkg.in/yaml.v3`, `modernc.org/sqlite`,
  `golang.org/x/net`) файла лицензии на диске нет — они перечислены в конце `go-modules.txt`
  в разделе «нет текста в каталоге модуля», текст для них не выдуман.

### Что приложить при раздаче

| Что распространяете | Что приложить |
|---|---|
| исходники (git / архив) | `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, весь каталог `licenses/` |
| бинарь бэкенда | `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `licenses/go-modules.txt` (обязательства MIT/BSD/Apache: сохранить copyright и текст) |
| сборка фронтенда (`frontend/dist`, образ nginx) | `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `licenses/EPL-2.0.txt` (для `elkjs`), `licenses/npm-packages.txt` |
| Docker-образ backend | как бинарь бэкенда плюс `licenses/LGPL-3.0.txt` (для `libheif-tools`) и указание, где взять GPL-3.0 |
| всё вместе (source + бинарь + образы) | весь каталог `licenses/` целиком — он для этого и собран |

Если меняется состав зависимостей, эти файлы пересобираются (как именно — в
`licenses/README.md`); устаревшая сводка хуже отсутствующей, потому что выглядит проверенной.
