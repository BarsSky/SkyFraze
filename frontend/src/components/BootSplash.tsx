/**
 * Заставка загрузки (0.80.0).
 *
 * Зачем: до монтирования React экран пустой, и на телефоне это несколько секунд — «перезагрузка
 * долгая» была ощущением без признака жизни. Первую заставку рисует сам `index.html` (она видна
 * с первого байта, до загрузки CSS и бандла); этот компонент показывает ТУ ЖЕ картину после
 * монтирования, пока проверяется вход и грузится проект — чтобы переход не мигал разными
 * экранами. Классы общие (`.boot`), стили есть и в `index.html`, и в `tokens.css`.
 */
export function BootSplash({ note = 'Загружаю оболочку…' }: { note?: string }) {
  return (
    <div className="boot" data-boot role="status" aria-live="polite">
      <span className="boot__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24" focusable="false" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2c1.6 3.2 3.6 5.2 6.8 6.8C15.6 10.4 13.6 12.4 12 15.6c-1.6-3.2-3.6-5.2-6.8-6.8C8.4 7.2 10.4 5.2 12 2Z"
          />
          <path
            fill="currentColor"
            opacity="0.6"
            d="M6 14c.9 1.8 2.1 3 3.9 3.9C8.1 18.8 6.9 20 6 21.8c-.9-1.8-2.1-3-3.9-3.9C3.9 17 5.1 15.8 6 14Z"
          />
        </svg>
      </span>
      <p className="boot__title">SkyFraze</p>
      <p className="boot__note">{note}</p>
      <div className="boot__spinner" aria-hidden="true" />
    </div>
  )
}
