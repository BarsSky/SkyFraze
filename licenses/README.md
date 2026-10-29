# Полные тексты сторонних лицензий

Каталог для того, кто распространяет SkyFraze (исходники, бинарь бэкенда, Docker-образ):
здесь лежат полные тексты лицензий тех сторонних компонентов, которые попадают в продукт.
Сводка «что откуда взялось и что приложить при раздаче» — в
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md), лицензия самого SkyFraze — в
[LICENSE](../LICENSE).

| Файл | Что покрывает | Лицензия |
|---|---|---|
| `EPL-2.0.txt` | `elkjs@0.9.3` — транзитивно через `mermaid`, отдельный чанк `frontend/dist/assets/elk-*.js` | Eclipse Public License 2.0 |
| `LGPL-3.0.txt` | `libheif-tools` (пакет alpine `libheif-tools`, утилита `heif-convert`) в образе backend | GNU Lesser General Public License 3.0 |
| `go-modules.txt` | все Go-модули из build-list бэкенда: полный текст лицензии каждого модуля и строки copyright | MIT / BSD-2 / BSD-3 / Apache-2.0 / MIT+Apache-2.0 |
| `npm-packages.txt` | все `dependencies` фронтенда плюс `elkjs`: полный текст лицензии каждого пакета | MIT (10 пакетов), MPL-2.0 OR Apache-2.0 (dompurify, выбран Apache-2.0), EPL-2.0 (elkjs — ссылка) |

Apache-2.0 отдельным файлом здесь не дублируется: полный текст — корневой `LICENSE`, он едет
с продуктом в любом варианте поставки. Файл `node_modules/dompurify/LICENSE` байт-в-байт
совпадает с ним (SHA-256 `CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30`),
поэтому в `npm-packages.txt` стоит ссылка, а не повтор 11 КБ текста.

## LGPL-3.0 дополняет GPL-3.0: где взять текст GPL

`LGPL-3.0.txt` — канонический текст с <https://www.gnu.org/licenses/lgpl-3.0.txt>, он не
правился. Важно: **LGPL-3.0 включает условия GPL-3.0 по ссылке** — в самом тексте это
сказано прямо: «This version of the GNU Lesser General Public License incorporates the terms
and conditions of version 3 of the GNU General Public License, supplemented by the additional
permissions listed below». Поэтому для полноты картины нужен и текст GPL-3.0:

* GPL-3.0 — <https://www.gnu.org/licenses/gpl-3.0.txt> (в репозиторий не добавлен: он
  относится к продукту только через LGPL-3.0, а `libheif-tools` в образ ставится пакетным
  менеджером без изменения).

Практический итог: если поставляете Docker-образ, приложите `LGPL-3.0.txt` и укажите, где
взять GPL-3.0. Ссылку на исходники пакета `libheif-tools` даёт базовый образ alpine: версия
пакета видна командой `apk info -v libheif-tools` внутри образа.

## Про elkjs (EPL-2.0): исходники и текст

* Текст лицензии: `EPL-2.0.txt` (скачан с <https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt>;
  заголовок файла и файл `frontend/node_modules/elkjs/LICENSE.md` — одна и та же лицензия
  «Eclipse Public License - v 2.0»).
* Исходники elkjs: <https://github.com/kieler/elkjs>, версия 0.9.3 (тэг `v0.9.3`) — именно эта
  версия стоит в `frontend/node_modules/elkjs`. Код модуля не изменён, поэтому обязательство
  EPL сводится к предоставлению текста лицензии и доступа к исходнику.

## Как получены и как обновить

`go-modules.txt` и `npm-packages.txt` — сводки, собранные из реальных файлов лицензий, а не
перепечатанные вручную:

```powershell
cd backend
go list -m -f '{{.Path}} {{.Version}} {{.Dir}}' all     # список модулей и их каталоги
```

Для каждого модуля из указанного каталога берётся `LICENSE` / `LICENSE.txt` / `LICENSE.md` /
`COPYING` / `LICENCE*` (плюс `NOTICE`, если он есть) и вставляется в сводку дословно, со
строками copyright; сверху блок `# модуль@версия — лицензия — имя файла`. Так же собраны
лицензии npm: из `frontend/node_modules/<пакет>/`. Если у модуля нет файла лицензии в
каталоге (например, он не скачивался в кеш, потому что не участвует в сборке), это
зафиксировано в конце `go-modules.txt` в разделе «нет текста в каталоге модуля» — текст
лицензии для таких записей не выдумывается.

Пересобрать сводки стоит при добавлении зависимости, попадающей в продукт: аудит и
`THIRD-PARTY-NOTICES.md` устаревают в тот же момент.
