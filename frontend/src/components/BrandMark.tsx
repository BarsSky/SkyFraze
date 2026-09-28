/**
 * Знак SkyFraze — пламя, собранное из листьев книги.
 *
 * Рисуется рядом с названием (в шапке и в панели проекта) и повторяет форму
 * favicon.svg: два листа сходятся у корешка и расходятся кверху острыми языками,
 * ниже блок страниц и чёрный корешок с очерком.
 *
 * Почему дублируется, а не подключается картинкой: значок нужен в двух размерах
 * и в двух темах, инлайн-SVG масштабируется без запроса и не мигает при
 * переключении светлой темы. Меняя форму, правьте и public/favicon.svg.
 */
interface Props {
  /** Сторона значка в пикселях. */
  size?: number
  /** Подпись для скринридера: пустая строка — значок декоративный. */
  title?: string
  className?: string
}

export function BrandMark({ size = 24, title = 'SkyFraze', className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id="sf-brand-leaf" x1="0.15" y1="0" x2="0.55" y2="1">
          <stop offset="0%" stopColor="#5FE3C8" />
          <stop offset="45%" stopColor="#2FA79C" />
          <stop offset="100%" stopColor="#1A6A93" />
        </linearGradient>
        <linearGradient id="sf-brand-pages" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8FEBD6" />
          <stop offset="100%" stopColor="#49B9AC" />
        </linearGradient>
        <linearGradient id="sf-brand-spine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#07090D" />
          <stop offset="50%" stopColor="#151A21" />
          <stop offset="100%" stopColor="#07090D" />
        </linearGradient>
      </defs>

      {/* блок страниц над корешком */}
      <path d="M9.4 22.6h13.2c.6 0 1 .4 1 1v1.2c0 .6-.4 1-1 1H9.4c-.6 0-1-.4-1-1v-1.2c0-.6.4-1 1-1z" fill="url(#sf-brand-pages)" />

      {/* листья — языки пламени */}
      <path
        d="M16 23.6H8.4c-1.2-4-1.5-8.2-.2-12.2C9.4 7.6 11.2 4.6 13.6 2.6c.1 2.8.9 5.1 2.4 7z"
        fill="url(#sf-brand-leaf)"
      />
      <path
        d="M16 23.6h7.6c1.2-4 1.5-8.2.2-12.2-1.2-3.8-3-6.8-5.4-8.8-.1 2.8-.9 5.1-2.4 7z"
        fill="url(#sf-brand-leaf)"
      />

      {/* внутренние поля страниц вдоль сгиба */}
      <path d="M14.8 12.2v10.4M17.2 12.2v10.4" stroke="#CFF7EC" strokeWidth="0.7" strokeLinecap="round" opacity="0.35" />
      {/* сгиб */}
      <path d="M16 9.6v13.9" stroke="#0B0F14" strokeOpacity="0.6" strokeWidth="1.3" strokeLinecap="round" />

      {/* корешок: чёрный, с сине-зелёным очерком */}
      <path d="M9.2 24.8h13.6c1.2 0 2.2 1 2.2 2.2s-1 2.2-2.2 2.2H9.2c-1.2 0-2.2-1-2.2-2.2s1-2.2 2.2-2.2z" fill="url(#sf-brand-spine)" />
      <path
        d="M9.2 24.8h13.6c1.2 0 2.2 1 2.2 2.2"
        fill="none"
        stroke="#2FA79C"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.95"
      />
    </svg>
  )
}
