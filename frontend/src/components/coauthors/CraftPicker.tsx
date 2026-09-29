import { useState } from 'react'
import { CRAFT_CATALOG } from '../../lib/crafts'

/**
 * Выбор специализаций.
 *
 * Каталог — подсказки, поэтому рядом всегда есть своя формулировка:
 * «ответственный за карту подземелий» в каталог не занесёшь.
 *
 * Два режима: неуправляемый (форма заявки — выбор живёт здесь же) и управляемый
 * (`value`), когда список приходит сверху и может обновиться ПОСЛЕ монтирования:
 * в профиле `crafts` приезжает из `/api/auth/me`, и без внешнего значения
 * компонент остался бы с пустым выбором, показывая его как «ничего не выбрано».
 */
export function CraftPicker({
  initial, busy, value, onChange, onSave, onCancel,
}: {
  initial: string[]
  busy?: boolean
  /** Управляемый режим: выбранное приходит сверху (профиль резидента). */
  value?: string[]
  onChange?: (crafts: string[]) => void
  onSave?: (crafts: string[]) => void
  onCancel?: () => void
}) {
  const [own, setOwn] = useState<string[]>(initial)
  const [custom, setCustom] = useState('')
  const picked = value ?? own

  const update = (next: string[]) => {
    setOwn(next)
    onChange?.(next)
  }
  const toggle = (craft: string) =>
    update(picked.includes(craft) ? picked.filter((c) => c !== craft) : [...picked, craft])

  function addCustom() {
    const craft = custom.trim()
    if (!craft || picked.some((c) => c.toLowerCase() === craft.toLowerCase())) {
      setCustom('')
      return
    }
    update([...picked, craft])
    setCustom('')
  }

  return (
    <div className="crafts" data-craft-picker>
      <div className="crafts__catalog">
        {CRAFT_CATALOG.map((craft) => (
          <button
            key={craft}
            type="button"
            className={picked.includes(craft) ? 'craft-chip is-picked' : 'craft-chip'}
            aria-pressed={picked.includes(craft)}
            onClick={() => toggle(craft)}
          >
            {craft}
          </button>
        ))}
      </div>
      <div className="crafts__custom">
        <input
          value={custom}
          placeholder="своя формулировка"
          aria-label="Своя специализация"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCustom()
            }
          }}
        />
        <button type="button" className="secondary" onClick={addCustom} disabled={custom.trim().length === 0}>
          Добавить
        </button>
      </div>
      {picked.length > 0 && (
        <p className="muted" style={{ margin: '6px 0 0' }}>
          Выбрано: {picked.join(' · ')}
        </p>
      )}
      {onSave && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button type="button" disabled={busy} onClick={() => onSave(picked)}>Сохранить</button>
          <button type="button" className="secondary" onClick={onCancel}>Отмена</button>
        </div>
      )}
    </div>
  )
}
