import { useCallback, useEffect, useRef, useState } from 'react'
import { pluralWord, useT } from '../i18n'
import { useLang } from '../store/lang'
import { Link, useLocation } from 'react-router-dom'
import { projectsWithUnseen, type ProjectUnseen } from '../api/comments'
import { chatUnseen, type ChatUnseen } from '../api/chat'
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
  const t = useT()
  const [lang] = useLang()
  const [rows, setRows] = useState<ProjectUnseen[]>([])
  /** Непрочитанное в чате (0.97.0): отдельный список, потому что новость другая — не «замечание к
      кадру», а «в проекте поговорили». */
  const [chatRows, setChatRows] = useState<ChatUnseen[]>([])
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  const root = useRef<HTMLDivElement | null>(null)

  const load = useCallback(() => {
    projectsWithUnseen()
      .then(setRows)
      // Тихо: колокольчик — подсказка, а не данные проекта. Ошибку показывать нечем и
      // незачем — при следующем переходе или через минуту запрос повторится.
      .catch(() => undefined)
    chatUnseen()
      .then(setChatRows)
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

  const chatTotal = chatRows.reduce((sum, row) => sum + row.unread, 0)
  const total = rows.reduce((sum, row) => sum + row.unread, 0) + chatTotal
  // Больше 99 показывать числом бессмысленно: важна не точность, а «много».
  const badge = total > 99 ? '99+' : String(total)

  return (
    <div className="notify" ref={root}>
      <button
        type="button"
        className="secondary notify__button"
        aria-expanded={open}
        aria-label={
          total > 0 ? t('ntf.newShort', { count: total }) : t('ntf.new')
        }
        title={total > 0 ? t('ntf.count', { count: total }) : t('ntf.noneTitle')}
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
        <div className="notify__panel" data-notify-panel role="group" aria-label={t('ntf.new')}>
          {rows.length === 0 && chatRows.length === 0 ? (
            <p className="muted notify__empty" data-notify-empty>
              {t('ntf.none')}
            </p>
          ) : (
            <>
              <p className="muted notify__hint">
                {t('ntf.hint')}
              </p>
              {chatRows.map((row) => (
                <Link
                  key={`chat-${row.projectId}`}
                  to={`/projects/${row.projectId}`}
                  className="notify__item"
                  data-notify-chat={row.projectId}
                  onClick={() => setOpen(false)}
                >
                  <span className="notify__title">{row.title || t('ntf.project')}</span>
                  <span className="notify__count">
                    {t('ntf.chat', {
                    count: row.unread,
                    word: pluralWord(lang, 'ntf.chatUnit', row.unread),
                  })}
                  </span>
                </Link>
              ))}
              {rows.map((row) => (
                <Link
                  key={row.projectId}
                  to={`/projects/${row.projectId}`}
                  className="notify__item"
                  data-notify-item={row.projectId}
                  onClick={() => setOpen(false)}
                >
                  <span className="notify__title">{row.title || t('ntf.project')}</span>
                  <span className="notify__count">
                    {row.mentions > 0 && (
                      <span className="notify__mention" data-notify-mention={row.mentions}>
                        {t('ntf.mentioned')}
                      </span>
                    )}
                    {row.unread} {pluralWord(lang, 'ntf.chatUnit', row.unread)}
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
