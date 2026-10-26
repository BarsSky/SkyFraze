import { useCallback, useEffect, useState } from 'react'
import {
  addPasskey,
  deletePasskey,
  describePasskeyError,
  listPasskeys,
  passkeysSupported,
  type PasskeyKey,
} from '../../api/webauthn'
import { useAuthStore } from '../../store/auth'

/**
 * Ключи доступа в профиле (docs/webauthn.md §7).
 *
 * Почему отдельный блок, а не «ещё одна галочка»: ключ — это устройство, у него есть имя и
 * дата последнего входа, и его можно потерять. Список с именами отвечает на вопрос «что у меня
 * привязано», а без него человек не узнал бы, что старый телефон всё ещё открывает аккаунт.
 *
 * Коды восстановления показываются здесь же, но только когда сервер выдал их впервые: это
 * единственный момент, когда они существуют в открытом виде (в базе — хеши).
 */

type Note = { kind: 'ok' | 'error'; text: string } | null

export function PasskeySettings() {
  const user = useAuthStore((state) => state.user)
  const enabled = user?.passkeys_enabled === true
  const supported = passkeysSupported()

  const [keys, setKeys] = useState<PasskeyKey[]>([])
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [recovery, setRecovery] = useState<string[]>([])
  /** Какой ключ ждёт подтверждения удаления: удаление без вопроса — слишком легко. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setKeys(await listPasskeys())
    } catch {
      // Профиль открывается и без списка: молчаливая пустота лучше, чем «ошибка» на весь блок.
      setKeys([])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  const add = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await addPasskey(name.trim())
      setKeys((prev) => [result.key, ...prev])
      setName('')
      if (result.recoveryCodes.length > 0) setRecovery(result.recoveryCodes)
      setNote({ kind: 'ok', text: 'Ключ привязан: теперь можно входить по отпечатку или PIN.' })
    } catch (e) {
      setNote({ kind: 'error', text: await describePasskeyError(e) })
    } finally {
      setBusy(false)
    }
  }, [name])

  const remove = useCallback(async (id: string) => {
    setBusy(true)
    setNote(null)
    try {
      await deletePasskey(id)
      setKeys((prev) => prev.filter((key) => key.id !== id))
      setPendingDelete(null)
      setNote({ kind: 'ok', text: 'Ключ удалён: этим устройством больше нельзя войти.' })
    } catch (e) {
      setNote({ kind: 'error', text: await describePasskeyError(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  if (!enabled) return null

  return (
    <div className="passkeys" data-passkeys>
      <h4 className="twofa__subhead">Ключи доступа</h4>
      <p className="muted twofa__hint">
        Ключ доступа — это отпечаток, Face ID или PIN устройства. Вход по ключу заменяет код из
        приложения, но не пароль: без пароля аккаунт остался бы без пути восстановления.
      </p>

      {!supported && (
        <p className="muted" data-passkeys-unsupported>
          Этот браузер не поддерживает ключи доступа. Попробуйте другой — например, свежий Chrome,
          Safari или Edge.
        </p>
      )}

      {supported && loaded && keys.length === 0 && (
        <p className="muted" data-passkeys-empty>
          Ключей пока нет. Привязать стоит два: телефон и ноутбук — потеря одного устройства не
          станет потерей аккаунта.
        </p>
      )}

      {keys.length > 0 && (
        <ul className="passkeys__list" data-passkeys-list>
          {keys.map((key) => (
            <li key={key.id} className="passkeys__item">
              <span className="passkeys__name">{key.name || 'ключ без имени'}</span>
              <span className="muted passkeys__meta">{describeKey(key)}</span>
              {pendingDelete === key.id ? (
                <span className="passkeys__confirm">
                  <button
                    type="button"
                    className="secondary ed-danger"
                    onClick={() => void remove(key.id)}
                    disabled={busy}
                    data-passkey-delete-confirm
                  >
                    Удалить
                  </button>
                  <button type="button" className="secondary" onClick={() => setPendingDelete(null)}>
                    Оставить
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setPendingDelete(key.id)}
                  disabled={busy}
                  aria-label={`Удалить ключ ${key.name || ''}`.trim()}
                  data-passkey-delete
                >
                  Удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {supported && (
        <div className="twofa__form">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="например, ноутбук"
            aria-label="Имя ключа"
            maxLength={60}
          />
          <button type="button" onClick={() => void add()} disabled={busy} data-passkey-add>
            {busy ? 'Жду подтверждения…' : 'Привязать ключ'}
          </button>
        </div>
      )}

      {recovery.length > 0 && (
        <div className="twofa__codes" data-passkey-recovery>
          <p>
            <strong>Коды восстановления.</strong> Показываются один раз. Каждый заменяет ключ при
            входе — сохраните их в надёжном месте: это последний путь в аккаунт, если устройство
            потеряется.
          </p>
          <ul>
            {recovery.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => setRecovery([])}>
            Я сохранил коды
          </button>
        </div>
      )}

      {note !== null && (
        <p
          className={note.kind === 'error' ? 'passkeys__note ed-danger' : 'passkeys__note'}
          role="status"
          data-passkeys-note
        >
          {note.text}
        </p>
      )}
    </div>
  )
}

/**
 * Подпись ключа: когда привязан и когда им входили.
 *
 * Дату последнего входа показываем отдельно от даты привязки: ключ, которым не входили
 * полгода, — повод его удалить.
 */
export function describeKey(key: PasskeyKey, now: Date = new Date()): string {
  const parts: string[] = []
  const created = formatDate(key.created_at, now)
  if (created) parts.push(`привязан ${created}`)
  const used = formatDate(key.last_used_at, now)
  if (used) parts.push(`вход ${used}`)
  const transport = transportName(key.transports)
  if (transport) parts.push(transport)
  return parts.join(' · ')
}

function formatDate(value: string | undefined, now: Date): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  // Свежие — относительными («сегодня», «3 дня назад»): так человек быстрее понимает, что
  // ключом давно не пользовались.
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000)
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  if (days < 30) return `${days} дн. назад`
  return date.toLocaleDateString('ru-RU')
}

/** Как этот ключ подключается к устройству — по данным аутентификатора. */
function transportName(raw: string): string {
  const first = (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)[0]
  switch (first) {
    case 'internal':
      return 'встроенный'
    case 'hybrid':
      return 'телефон как ключ'
    case 'usb':
      return 'USB-ключ'
    case 'nfc':
      return 'NFC'
    case 'ble':
      return 'Bluetooth'
    default:
      return ''
  }
}
