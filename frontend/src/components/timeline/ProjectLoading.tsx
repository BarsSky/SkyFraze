/**
 * Заглушка загрузки проекта: скелет стадии с бегущим бликом.
 *
 * Зачем не просто «Загрузка…». Проект открывается в полноэкранную стадию, и голый текст
 * посреди пустой страницы читается как «здесь ничего нет»; скелет показывает, ЧТО
 * сейчас появится (заголовок кадра и текст), и что страница жива. Раньше на этом месте
 * была заглушка «Таймлайн пока пуст» — то есть интерфейс врал о содержимом проекта.
 *
 * Анимация отключается при `prefers-reduced-motion` (см. styles/timeline.css): блик —
 * украшение, а не смысл, и для тех, кому движение мешает, он не нужен.
 */
export function ProjectLoading({ label = 'Загружаю проект…' }: { label?: string }) {
  return (
    <div className="sf-loading" data-project-loading role="status" aria-live="polite">
      <div className="sf-loading__stage" aria-hidden="true">
        <div className="sf-loading__bar sf-loading__bar--title" />
        <div className="sf-loading__bar sf-loading__bar--line" />
        <div className="sf-loading__bar sf-loading__bar--line sf-loading__bar--short" />
        <div className="sf-loading__chips">
          <div className="sf-loading__chip" />
          <div className="sf-loading__chip" />
          <div className="sf-loading__chip" />
        </div>
      </div>
      <p className="muted sf-loading__label">{label}</p>
    </div>
  )
}
