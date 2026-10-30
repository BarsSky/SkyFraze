import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { normalizeUsername, validUsername } from '../../api/coauthors'
import { updateProfile, type ProfilePatch } from '../../api/auth'
import { useAuthStore } from '../../store/auth'
import { CraftPicker } from '../coauthors/CraftPicker'
import { TwoFactorSettings } from './TwoFactorSettings'
import { craftsOf } from '../../lib/crafts'

/**
 * «Как вас найти»: имя, ник, резюме, специализации, видимость в каталоге и письма о замечаниях
 * (0.99.0).
 *
 * Блок переехал сюда со страницы «Соавторы», где он жил с 0.77.0: отчёт «нету вкладки
 * пользователя, всё про вход пользователя почему-то в Соавторах». По смыслу он и не про круг
 * соавторов — он про «кто я на этой площадке»: как меня находят по нику и что обо мне узнают в
 * каталоге резидентов. Рядом с ним на вкладке «Профиль» стоят ключи доступа и журнал входов:
 * и то и другое — про мою учётную запись, а не про чужой проект.
 *
 * Ник уникален: занятый вернёт понятную ошибку, а не сырое «409».
 */
const BIO_LIMIT = 600

export function ProfileCard() {
  const t = useT()
  const user = useAuthStore((s) => s.user)
  const [name, setName] = useState(user?.display_name ?? '')
  const [nick, setNick] = useState(user?.username ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [crafts, setCrafts] = useState<string[]>(craftsOf(user?.crafts))
  /** Отсутствие поля — не «скрыт»: на сервере видимость включена по умолчанию. */
  const savedDiscoverable = user?.discoverable !== false
  const [discoverable, setDiscoverable] = useState(savedDiscoverable)
  /** Письма о замечаниях: по умолчанию выключены — текст проекта уходит на почтовый сервер. */
  const savedNotify = user?.notify_comments === true
  const [notifyComments, setNotifyComments] = useState(savedNotify)
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setName(user?.display_name ?? '')
    setNick(user?.username ?? '')
    setBio(user?.bio ?? '')
    setCrafts(craftsOf(user?.crafts))
    setDiscoverable(user?.discoverable !== false)
    setNotifyComments(user?.notify_comments === true)
  }, [user?.display_name, user?.username, user?.bio, user?.crafts, user?.discoverable, user?.notify_comments])

  const nickOk = validUsername(nick)
  const savedCrafts = craftsOf(user?.crafts)
  const sameCrafts =
    crafts.length === savedCrafts.length && crafts.every((craft) => savedCrafts.includes(craft))

  // Отправляем только изменённое: незатронутое поле сервер и так не трогает, а пустое значение в
  // теле — это осознанная очистка (снять резюме, убрать все специализации, скрыться из каталога).
  const patch: ProfilePatch = {}
  if (name.trim() !== (user?.display_name ?? '')) patch.display_name = name.trim()
  if (normalizeUsername(nick) !== (user?.username ?? '')) patch.username = normalizeUsername(nick)
  if (bio.trim() !== (user?.bio ?? '')) patch.bio = bio.trim()
  if (!sameCrafts) patch.crafts = crafts
  if (discoverable !== savedDiscoverable) patch.discoverable = discoverable
  if (notifyComments !== savedNotify) patch.notify_comments = notifyComments
  const changed = Object.keys(patch).length > 0

  async function save() {
    if (!changed) return
    setState('busy')
    setMessage(null)
    try {
      await updateProfile(patch)
      setState('saved')
      setMessage(t('prf.saved'))
    } catch (e) {
      setState('idle')
      setMessage(
        /409/.test(String(e)) ? t('prf.nickTaken') : t('prf.saveFailed'),
      )
    }
  }

  return (
    <section className="card" data-profile>
      <h3 style={{ marginTop: 0 }}>{t('prf.title')}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('prf.intro1')} <code>@{user?.username}</code>.
        {t('prf.intro2')}
      </p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 220px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: 4 }}>
            {t('prf.nameLabel')}
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('prf.nameAria')} />
        </label>
        <label style={{ flex: '1 1 200px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: 4 }}>
            {t('prf.nickLabel')}
          </span>
          <input
            value={nick}
            onChange={(e) => setNick(normalizeUsername(e.target.value))}
            aria-label={t('prf.nickAria')}
            placeholder="anna.design"
          />
        </label>
      </div>
      {!nickOk && nick.length > 0 && (
        <p className="ed-panel__note">{t('prf.nickNote')}</p>
      )}

      <label className="coauthors__bio">
        <span className="muted" style={{ display: 'block', marginBottom: 4 }}>
            {t('prf.bioLabel')}
          </span>
        <textarea
          rows={3}
          maxLength={BIO_LIMIT}
          value={bio}
          aria-label={t('prf.bioAria')}
          placeholder={t('prf.bioPlaceholder')}
          onChange={(e) => setBio(e.target.value)}
        />
        <span className="muted coauthors__counter">{bio.length} / {BIO_LIMIT}</span>
      </label>

      <div className="coauthors__profile-crafts">
        <span className="muted" style={{ display: 'block', marginBottom: 6 }}>
          {t('prf.craftsLabel')}
        </span>
        <CraftPicker initial={crafts} value={crafts} onChange={setCrafts} />
      </div>

      <label className="coauthors__toggle">
        <input
          type="checkbox"
          checked={discoverable}
          onChange={(e) => setDiscoverable(e.target.checked)}
        />
        <span>
          {t('prf.discoverable')}
          <span className="muted" style={{ display: 'block' }}>
            {t('prf.discoverableHint')}
          </span>
        </span>
      </label>

      <label className="coauthors__toggle">
        <input
          type="checkbox"
          checked={notifyComments}
          onChange={(e) => setNotifyComments(e.target.checked)}
          data-notify-comments
        />
        <span>
          {t('prf.notifyComments')}
          <span className="muted" style={{ display: 'block' }}>
            {t('prf.notifyCommentsHint')}
          </span>
        </span>
      </label>

      <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" disabled={state === 'busy' || !nickOk || !changed} onClick={() => void save()}>
          {state === 'busy' ? t('prf.saving') : t('prf.save')}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>

      {/* Второй фактор и активные сеансы — отдельный блок: это настройки входа, а не профиля, и
          сохраняются они сразу, а не кнопкой «Сохранить профиль». */}
      <TwoFactorSettings />
    </section>
  )
}
