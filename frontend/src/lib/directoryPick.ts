import type { InputHTMLAttributes } from 'react'

/**
 * React 18 не знает атрибута `webkitdirectory`, а без него браузер отдаёт файлы
 * по одному, без папок. Передаём атрибут в DOM как есть: он нестандартный, но
 * именно он открывает выбор каталога.
 *
 * Общий для двух мест, где выбирают папку с md: импорт в новый проект
 * (ImportFolderModal) и импорт куска в существующий (EditorsPanel).
 */
export const DIRECTORY_PICK = {
  webkitdirectory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>
