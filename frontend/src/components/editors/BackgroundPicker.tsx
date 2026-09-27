import { FRAME_TONES } from '../timeline/timelineModel'
import type { Asset } from '../../api/assets'

export type BackgroundKind = 'inherit' | 'tone' | 'asset'

export interface BackgroundValue {
  kind: BackgroundKind
  tone?: string
  assetId?: string
}

interface Props {
  value: BackgroundValue
  images: Asset[]
  /** id ассета → blob-URL (ассеты отдаются только авторизованным запросом). */
  assetUrls: Record<string, string>
  onUpload: (file: File) => void
  onChange: (value: BackgroundValue) => void
}

/**
 * Настройка фона кадра события: как у родителя, свой тон или картинка из
 * вложений события. Значения пишутся в CRDT события (`bg_kind`, `bg_tone`,
 * `bg_asset`) и используются стадией при показе кадра.
 */
export function BackgroundPicker({ value, images, assetUrls, onUpload, onChange }: Props) {
  return (
    <div className="ed-bg" data-background-kind={value.kind}>
      <div className="ed-bg__modes" role="group" aria-label="Тип фона">
        <button
          type="button"
          className={value.kind === 'inherit' ? 'ed-chip is-active' : 'ed-chip'}
          onClick={() => onChange({ kind: 'inherit' })}
        >
          как у главы
        </button>
        <button
          type="button"
          className={value.kind === 'tone' ? 'ed-chip is-active' : 'ed-chip'}
          onClick={() => onChange({ kind: 'tone', tone: value.tone ?? FRAME_TONES[0] })}
        >
          тон
        </button>
        <button
          type="button"
          className={value.kind === 'asset' ? 'ed-chip is-active' : 'ed-chip'}
          onClick={() => onChange({ kind: 'asset', assetId: value.assetId ?? images[0]?.id })}
        >
          картинка
        </button>
      </div>

      {value.kind === 'tone' && (
        <div className="ed-bg__tones">
          {FRAME_TONES.map((tone) => (
            <button
              key={tone}
              type="button"
              className={value.tone === tone ? 'ed-tone is-active' : 'ed-tone'}
              style={{ background: tone }}
              title={tone}
              aria-label={`Тон ${tone}`}
              onClick={() => onChange({ kind: 'tone', tone })}
            />
          ))}
        </div>
      )}

      {value.kind === 'asset' && (
        <div className="ed-bg__images">
          {images.length === 0 && <p className="muted">Сначала прикрепите картинку к событию.</p>}
          {images.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={value.assetId === asset.id ? 'ed-bg__thumb is-active' : 'ed-bg__thumb'}
              onClick={() => onChange({ kind: 'asset', assetId: asset.id })}
              title={asset.filename}
            >
              {assetUrls[asset.id] ? (
                <img src={assetUrls[asset.id]} alt="" loading="lazy" />
              ) : (
                <span className="ed-bg__placeholder">…</span>
              )}
            </button>
          ))}
          <label className="ed-bg__upload">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onUpload(file)
              }}
            />
            + картинка
          </label>
        </div>
      )}
    </div>
  )
}
