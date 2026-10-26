import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { projectsWithUnseen, type ProjectUnseen } from '../api/comments'
import { plural } from '../lib/format'

/**
 * Колокольчик: где ждут новые замечания.
 *
 * Зачем отдельно от счётчиков в списке проектов. Счётчик у карточки проекта отвечает на
 * вопрос «сюда ли заглянуть», но чтобы его увидеть, нужно было уже оказаться в списке
 * проектов. Если человек работает в редакторе, замечание, написанное соавтором, не видно
 * нигде — до 0.56.0 обсуждение жило только в двух местах: в дереве кадров и в списке
 * проектов.
 *
 * Что здесь есть и чего нет:
 *   * это НЕ лента событий: показываются проекты, где есть непрочитанное, с числом и
 *     ссылкой на проект — открыть кадр всё равно надо, отметить прочитанным может только
 *     показ обсуждения (docs/comments.md §5);
 *   * почты здесь нет: колокольчик — то, что видно в приложении без SMTP и без согласия
 *     на отправку текста наружу (docs/comments.md §5.2);
 *   * обновление — по переходу между страницами и раз в минуту: сокета у обсуждений нет, а
 *     «раз в минуту» — честная цена за то, чтобы не держать открытым ещё одно соединение.
 *
 * Подсказка не имеет права ломать шапку: ошибка запроса гасит счётчик, а не приложение.
 */
const REFRESH_MS = 60_000

export function NotificationBell() {
  const [rows, setRows] = useState<ProjectUnseen[]>([])
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  const root = useRef<HTMLDivElement | null>(null)

  const load = useCallback(() => {
    projectsWithUnseen()
      .then(setRows)
      // Тихо: колокольчик — подсказка, а не данные проекта. Ошибку показывать нечем и
      // незачем — при следующем переходе или через минуту запрос повторится.
      .catch(() => undefined)
  }, [])

  // Переход между страницами — самый частый момент, когда счётчик мог измениться (обсуждение
  // открыли и оно стало прочитанным).
  useEffect(() => {
    load()
  }, [load, pathname])

  useEffect(() => {
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  // Закрытие кликом мимо и по Esc: открытая панель иначе перекрывает шапку и не убирается
  // с клавиатуры.
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.notify')) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const total = rows.reduce((sum, row) => sum + row.unread, 0)
  // Больше 99 показывать числом бессмысленно: важна не точность, а «много».
  const badge = total > 99 ? '99+' : String(total)

  return (
    <div className="notify" ref={root}>
      <button
        type="button"
        className="secondary notify__button"
        aria-expanded={open}
        aria-label={
          total > 0 ? `Новые замечания: ${total}` : 'Новые замечания'
        }
        title={total > 0 ? `Новых замечаний: ${total}` : 'Новых замечаний нет'}
        data-notify-bell
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <span aria-hidden="true">🔔</span>
        {total > 0 && (
          <span className="notify__badge" data-notify-count={total}>
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="notify__panel" data-notify-panel role="group" aria-label="Новые замечания">
          {rows.length === 0 ? (
            <p className="muted notify__empty" data-notify-empty>
              Новых замечаний нет
            </p>
          ) : (
            <>
              <p className="muted notify__hint">
                Замечания к вашим историям — откройте кадр, чтобы прочитать
              </p>
              {rows.map((row) => (
                <Link
                  key={row.projectId}
                  to={`/projects/${row.projectId}`}
                  className="notify__item"
                  data-notify-item={row.projectId}
                  onClick={() => setOpen(false)}
                >
                  <span className="notify__title">{row.title || 'Проект'}</span>
                  <span className="notify__count">
                    {row.mentions > 0 && (
                      <span className="notify__mention" data-notify-mention={row.mentions}>
                        вас упомянули
                      </span>
                    )}
                    {row.unread} {plural(row.unread, 'новое', 'новых', 'новых')}
                  </span>
                </Link>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
