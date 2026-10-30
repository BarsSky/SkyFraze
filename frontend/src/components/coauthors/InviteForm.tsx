import { useState } from 'react'
import { useT } from '../../i18n'
import { CraftPicker } from './CraftPicker'

/**
 * Кого зовём в соавторы. Форме достаточно ника и имени, поэтому её принимают и
 * поиск соавторов, и строка каталога резидентов — разные типы с общими полями.
 */
export interface InviteTarget {
  username: string
  display_name: string
}

/** Форма заявки: сообщение и специализации, которые предлагает приглашающий. */
export function InviteForm({
  person, busy, onCancel, onSubmit,
}: {
  person: InviteTarget
  busy: boolean
  onCancel: () => void
  onSubmit: (message: string, crafts: string[]) => void
}) {
  const t = useT()
  const [message, setMessage] = useState('')
  const [crafts, setCrafts] = useState<string[]>([])
  return (
    <div className="coauthors__form" data-invite-form>
      <h4 style={{ marginTop: 0 }}>
        {t('inv.title', { name: person.display_name })}{' '}
        <span className="muted">@{person.username}</span>
      </h4>
      <label>
        <span className="muted" style={{ display: 'block', marginBottom: 4 }}>
              {t('inv.messageLabel')}
            </span>
        <textarea
          rows={2}
          value={message}
          placeholder={t('inv.placeholder')}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <CraftPicker initial={crafts} onChange={setCrafts} />
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={() => onSubmit(message, crafts)}>
          {busy ? t('inv.sending') : t('inv.send')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
            {t('inv.cancel')}
          </button>
      </div>
    </div>
  )
}
