import { useEffect, useState } from 'react'
import { downloadDocxSample } from '../../api/docxTemplates'

/**
 * Справка «Как сделать шаблон оформления DOCX» (0.94.0).
 *
 * Зачем отдельное окно, а не абзац в настройках. Фича выглядела нерабочей ровно потому, что
 * человек не знал трёх вещей: что нужно положить в шаблон, что программа вообще воспринимает из
 * текста и какими словами называются стили. Инструкция в настройках была бы прочитана один раз и
 * забыта (а из редактора её не видно вовсе), поэтому справка — одно и то же окно в двух местах:
 * в блоке «Оформление DOCX» и в панели «Разметка DOCX» рядом с кнопками маркеров.
 *
 * Текст справки повторяет РЕАЛЬНЫЕ правила разбора и выгрузки (`backend/internal/docxtpl`
 * и `backend/internal/transfer/export_docx.go`); расхождение здесь хуже отсутствия справки.
 */
interface Props {
  /** Проект нужен, чтобы предложить скачать пример; в редакторе его может не быть. */
  projectId?: string
  onClose: () => void
}

/** Что берётся из текста кадров при сборке документа. */
const FROM_TEXT: Array<{ what: string; how: string }> = [
  { what: 'Главы и под-события', how: 'заголовком по глубине: глава — уровень 1, под-событие — 2, глубже — 3 и 4' },
  { what: 'Дата кадра', how: 'строкой «12 марта 2026» стилем даты — если дата заполнена' },
  { what: 'Абзацы', how: 'обычным текстом шаблона: шрифт и отступ берутся из абзаца `{{content}}`' },
  { what: 'Цитаты (`> …`)', how: 'стилем цитаты' },
  { what: 'Блоки кода (```)', how: 'стилем кода, моноширинным' },
  { what: 'Списки (`- `, `1. `)', how: 'абзацами списка; вложенные — с отступом' },
  { what: 'Таблицы', how: 'строками через ` | `, первая строка — жирная' },
  { what: 'Картинки кадра', how: 'встроенными объектами, не шире 6 дюймов' },
]

/** Маркеры — строки, которые понимает только DOCX. */
const MARKERS: Array<{ marker: string; what: string }> = [
  { marker: '<!-- sf:pagebreak -->', what: 'начать новый лист' },
  { marker: '<!-- sf:toc -->', what: 'поле оглавления Word (обновится в Word по F9)' },
  { marker: '<!-- sf:style=Имя -->', what: 'текст ниже — этим стилем шаблона' },
  { marker: '<!-- sf:begin=Имя --> … <!-- sf:end -->', what: 'кусок целиком этим стилем' },
]

export function DocxHelp({ projectId, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const download = async () => {
    if (!projectId) return
    setBusy(true)
    setNote(null)
    try {
      const name = await downloadDocxSample(projectId)
      setNote(`Скачан «${name}» — откройте в Word и поменяйте оформление.`)
    } catch {
      setNote('Не удалось скачать пример — проверьте права в проекте.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="docx-help" role="dialog" aria-modal="true" aria-label="Справка по шаблону DOCX" data-docx-help>
      <div className="docx-help__window">
        <header className="docx-help__head">
          <strong>Как сделать шаблон оформления DOCX</strong>
          <button type="button" className="secondary" onClick={onClose} aria-label="Закрыть справку">
            закрыть ✕
          </button>
        </header>

        <div className="docx-help__body">
          <section>
            <h3>1. Скачайте пример и откройте в Word</h3>
            <p>
              В примере уже есть всё, что нужно: титул, колонтитул, стили и абзац{' '}
              <code>{'{{content}}'}</code>. Меняйте шрифты, поля, титул и колонтитул — как в обычном
              документе.
            </p>
            {projectId && (
              <p>
                <button type="button" onClick={() => void download()} disabled={busy} data-docx-help-sample>
                  {busy ? 'Готовлю…' : 'Скачать пример .docx'}
                </button>
              </p>
            )}
            {note !== null && <p className="muted">{note}</p>}
          </section>

          <section>
            <h3>2. Оставьте абзац {'{{content}}'} отдельной строкой</h3>
            <p>
              Именно на его место встанет текст проекта. Без этого абзаца шаблон не принимается:
              вставлять текст было бы некуда. Если хотите, чтобы обычный текст был вашим шрифтом и с
              отступом — оформите абзац с <code>{'{{content}}'}</code> так, как нужен текст: его
              свойства абзаца переносятся на все абзацы книги.
            </p>
          </section>

          <section>
            <h3>3. Назовите стили так, как их ищет программа</h3>
            <p>
              Стили можно переименовать и оформить как угодно, главное — имена (или их русские
              варианты):
            </p>
            <ul className="docx-help__list">
              <li><b>Title</b> («Заголовок») — название проекта</li>
              <li><b>Heading1–Heading4</b> («Заголовок 1»…«Заголовок 4») — главы и под-события</li>
              <li><b>Quote</b> («Цитата»), <b>Code</b> («Код»), <b>Date</b> («Дата»)</li>
              <li><b>ListParagraph</b> («Список») — пункты списков</li>
            </ul>
            <p>
              Чего в шаблоне нет, то выгрузится обычным текстом — и это будет написано в отчёте
              после загрузки, с предупреждением по каждому несовпадению.
            </p>
          </section>

          <section>
            <h3>4. Загрузите шаблон в настройках проекта</h3>
            <p>
              «Оформление DOCX» → выбрать файл и имя («рукопись», «самиздат»). Загружать и
              переключать шаблон может владелец проекта, читать отчёт — редактор. Активный шаблон
              применяется при скачивании: «Книга» → «Скачать .docx».
            </p>
          </section>

          <section>
            <h3>Что берётся из текста</h3>
            <table className="docx-help__table">
              <tbody>
                {FROM_TEXT.map((row) => (
                  <tr key={row.what}>
                    <th scope="row">{row.what}</th>
                    <td>{row.how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Маркеры: то, чего Markdown не умеет</h3>
            <p>
              Служебные строки в тексте кадра. Их понимает только скачивание в .docx: в показе
              проекта и в поиске они не видны. Ставятся панелью «Разметка DOCX» в редакторе или
              вручную — но обязательно отдельной строкой и не внутри блоков кода.
            </p>
            <table className="docx-help__table">
              <tbody>
                {MARKERS.map((row) => (
                  <tr key={row.marker}>
                    <th scope="row"><code>{row.marker}</code></th>
                    <td>{row.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Чего шаблон не делает</h3>
            <ul className="docx-help__list">
              <li>не переносит текст в колонки, надписи и фигуры — они остаются на титуле и в колонтитулах;</li>
              <li>не встраивает шрифты в файл: Word подставит свой, если у читателя шрифта нет;</li>
              <li>не обновляет оглавление само — это делает Word при открытии (F9);</li>
              <li>не переносит правки обратно в проект: правка рукописи в Word в проект не вернётся.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
