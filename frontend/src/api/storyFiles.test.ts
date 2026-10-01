import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Выгрузка в Markdown и импорт папки: что именно уходит на сервер и что из ответа
 * получает окно предпросмотра.
 *
 * Сеть подменяется целиком (как в `people.test.ts`): проверяем форму запроса и
 * разбор ответа, без стенда и без токена. Отдельно закреплено правило «пустой
 * выбор файлов не ходит в сеть» — иначе отмена в системном диалоге выглядела бы
 * как ошибка импорта.
 */
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('./client', () => ({ http: { get: mocks.get, post: mocks.post } }))

import {
  buildMarkdownImportForm,
  exportStoryMarkdown,
  importMarkdownFolder,
  importMarkdownInto,
  markdownExportFilename,
  parseMarkdownPreview,
  previewMarkdownImport,
} from './storyFiles'

/** jsdom не умеет blob-ссылки: подменяем ровно то, что нужно скачиванию файла. */
const createObjectURL = vi.fn(() => 'blob:story')
const revokeObjectURL = vi.fn()
Object.assign(URL, { createObjectURL, revokeObjectURL })

/** Файл события как из выбора папки: имя части — относительный путь. */
function mdFile(name: string, relativePath = ''): File {
  const file = new File(['# Глава'], name, { type: 'text/markdown' })
  // webkitRelativePath доступен только у файлов из input[webkitdirectory].
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

function reply(body: unknown) {
  return { json: async () => body }
}

const rawPreview = {
  project_title: 'Планета — АнуВаар',
  events: [
    { number: '01', depth: 0, title: 'Пролог', path: '01-Пролог.md', chars: 1200, warnings: [] },
    {
      number: '01.1',
      depth: 1,
      title: 'Первая встреча',
      path: '01.1-Первая-встреча.md',
      chars: 300,
      warnings: ['пустой файл'],
    },
  ],
  warnings: ['не нашлось файлов для 3 ссылок: assets/карта.png'],
  stats: {
    files: 2,
    events: 2,
    chars: 1500,
    image_links: 3,
    attachments: 1,
    missing_files: 3,
    unused_files: 0,
    attachment_bytes: 3 * 1024 * 1024,
  },
  quota_bytes: 10 * 1024 * 1024,
}

describe('buildMarkdownImportForm', () => {
  it('срезает корень папки, а каталоги оставляет главами', () => {
    const form = buildMarkdownImportForm([
      mdFile('01-Пролог.md', 'Моя история/01-Пролог.md'),
      mdFile('01-Города.md', 'Моя история/02-Мир/01-Города.md'),
      mdFile('index.md', 'Моя история/02-Мир/index.md'),
    ])

    expect(form).toBeInstanceOf(FormData)
    const parts = form?.getAll('files') as File[]
    expect(parts).toHaveLength(3)
    // Имя части — путь БЕЗ корня выбранной папки: корень и есть проект, иначе он
    // стал бы лишней главой-обёрткой (сервер делает событие из каждого каталога).
    expect(parts.map((file) => file.name)).toEqual([
      '01-Пролог.md',
      '02-Мир/01-Города.md',
      '02-Мир/index.md',
    ])
    expect(form?.get('archive')).toBeNull()
  })

  it('файл прямо в корне папки отдаём обычным именем', () => {
    const form = buildMarkdownImportForm([
      // webkitRelativePath пуст — браузер не дал каталогов.
      mdFile('01-Пролог.md'),
      // Путь без каталога: срезать нечего.
      mdFile('02-Мир.md', '02-Мир.md'),
      // После среза не осталось пути — берём имя файла.
      mdFile('03-Финал.md', 'Моя история/'),
    ])

    expect((form?.getAll('files') as File[]).map((file) => file.name)).toEqual([
      '01-Пролог.md',
      '02-Мир.md',
      '03-Финал.md',
    ])
  })

  it('zip уходит отдельным полем archive, а не среди файлов', () => {
    const zip = new File(['PK'], 'story.zip', { type: 'application/zip' })
    const form = buildMarkdownImportForm({ archive: zip })

    expect((form?.get('archive') as File).name).toBe('story.zip')
    expect(form?.getAll('files')).toHaveLength(0)
  })

  it('пустой выбор — это null, а не пустая форма', () => {
    expect(buildMarkdownImportForm([])).toBeNull()
    expect(buildMarkdownImportForm(null)).toBeNull()
    expect(buildMarkdownImportForm({ archive: undefined as unknown as File })).toBeNull()
  })
})

describe('parseMarkdownPreview', () => {
  it('разбирает дерево, предупреждения и статистику', () => {
    const preview = parseMarkdownPreview(rawPreview)

    expect(preview.projectTitle).toBe('Планета — АнуВаар')
    expect(preview.events).toHaveLength(2)
    expect(preview.events[1]).toMatchObject({ number: '01.1', depth: 1, chars: 300 })
    expect(preview.events[1].warnings).toEqual(['пустой файл'])
    expect(preview.warnings).toEqual(['не нашлось файлов для 3 ссылок: assets/карта.png'])
    expect(preview.stats).toEqual({
      files: 2,
      events: 2,
      chars: 1500,
      imageLinks: 3,
      attachments: 1,
      missingFiles: 3,
      unusedFiles: 0,
      attachmentBytes: 3 * 1024 * 1024,
    })
    // Предел проекта нужен окну предпросмотра: по нему оно предупреждает о весе.
    expect(preview.quotaBytes).toBe(10 * 1024 * 1024)
  })

  it('пустой ответ не ломает окно предпросмотра', () => {
    expect(parseMarkdownPreview(undefined)).toEqual({
      projectTitle: '',
      events: [],
      warnings: [],
      stats: {
        files: 0,
        events: 0,
        chars: 0,
        imageLinks: 0,
        attachments: 0,
        missingFiles: 0,
        unusedFiles: 0,
        attachmentBytes: 0,
      },
      quotaBytes: 0,
    })
  })

  it('мусор в ответе приводит к значениям по умолчанию', () => {
    const preview = parseMarkdownPreview({
      project_title: 42,
      events: [null, 'нет', { title: 'Глава', chars: 'много' }],
      warnings: 'нет',
      stats: { files: '2', events: -1 },
    })

    expect(preview.projectTitle).toBe('')
    expect(preview.events).toEqual([
      { number: '', depth: 0, title: 'Глава', path: '', chars: 0, warnings: [] },
    ])
    expect(preview.warnings).toEqual([])
    // Статистику сервер не прислал — счётчики берём из разобранного дерева.
    expect(preview.stats).toEqual({
      files: 0,
      events: 1,
      chars: 0,
      imageLinks: 0,
      attachments: 0,
      missingFiles: 0,
      unusedFiles: 0,
      attachmentBytes: 0,
    })
    expect(preview.quotaBytes).toBe(0)
  })
})

describe('сеть не трогаем без файлов', () => {
  beforeEach(() => {
    mocks.get.mockReset()
    mocks.post.mockReset()
  })

  it('пустой выбор не отправляет запрос', async () => {
    await expect(previewMarkdownImport([])).rejects.toThrow(/не выбрано/i)
    await expect(importMarkdownFolder([])).rejects.toThrow(/не выбрано/i)
    await expect(previewMarkdownImport(null)).rejects.toThrow(/не выбрано/i)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })
})

describe('previewMarkdownImport', () => {
  beforeEach(() => mocks.post.mockReset())

  it('отправляет форму на предпросмотр и возвращает разобранный ответ', async () => {
    mocks.post.mockReturnValue(reply(rawPreview))
    const preview = await previewMarkdownImport([mdFile('01-Пролог.md', 'Моя история/01-Пролог.md')])

    expect(mocks.post).toHaveBeenCalledTimes(1)
    const [url, options] = mocks.post.mock.calls[0]
    expect(url).toBe('projects/import/markdown/preview')
    expect(options.body).toBeInstanceOf(FormData)
    expect(preview.events).toHaveLength(2)
  })
})

describe('importMarkdownFolder', () => {
  beforeEach(() => mocks.post.mockReset())

  it('создаёт проект и передаёт название только если оно не пустое', async () => {
    mocks.post.mockReturnValue(reply({ project_id: 'p1', events: 2, warnings: ['фон не переносится'] }))
    const result = await importMarkdownFolder(
      { archive: new File(['PK'], 'story.zip') },
      '  Моя история  ',
    )

    expect(result).toEqual({ projectId: 'p1', events: 2, warnings: ['фон не переносится'] })
    const [url, options] = mocks.post.mock.calls[0]
    expect(url).toBe('projects/import/markdown')
    expect((options.body as FormData).get('title')).toBe('Моя история')

    mocks.post.mockClear()
    mocks.post.mockReturnValue(reply({ project_id: 'p2', events: 1, warnings: [] }))
    await importMarkdownFolder([mdFile('01.md')], '   ')
    expect((mocks.post.mock.calls[0][1].body as FormData).get('title')).toBeNull()
  })
})

describe('importMarkdownInto', () => {
  beforeEach(() => mocks.post.mockReset())

  it('несёт место вставки полями формы и не создаёт проект', async () => {
    mocks.post.mockReturnValue(reply({ project_id: 'p1', events: 3, warnings: [] }))
    const result = await importMarkdownInto('p1', { archive: new File(['PK'], 'часть.zip') }, {
      parentId: 'глава',
      afterId: 'сосед',
    })

    expect(result).toEqual({ projectId: 'p1', events: 3, warnings: [] })
    const [url, options] = mocks.post.mock.calls[0]
    expect(url).toBe('projects/p1/import/markdown')
    const form = options.body as FormData
    expect(form.get('parent_id')).toBe('глава')
    expect(form.get('after_id')).toBe('сосед')
    // Название проекта здесь ни при чём: проект не создаётся.
    expect(form.get('title')).toBeNull()
  })

  it('«перед» сильнее «после»: сервер отверг бы оба места сразу', async () => {
    mocks.post.mockReturnValue(reply({ project_id: 'p1', events: 1, warnings: [] }))
    await importMarkdownInto('p1', [mdFile('01.md')], { beforeId: 'б', afterId: 'а' })

    const form = mocks.post.mock.calls[0][1].body as FormData
    expect(form.get('before_id')).toBe('б')
    expect(form.get('after_id')).toBeNull()
  })

  it('без места форма уходит без полей места — кусок встанет в конец', async () => {
    mocks.post.mockReturnValue(reply({ project_id: 'p1', events: 1, warnings: [] }))
    await importMarkdownInto('p1', [mdFile('01.md')], {})

    const form = mocks.post.mock.calls[0][1].body as FormData
    expect(form.get('parent_id')).toBeNull()
    expect(form.get('before_id')).toBeNull()
    expect(form.get('after_id')).toBeNull()
  })
})

describe('exportStoryMarkdown', () => {
  beforeEach(() => {
    mocks.get.mockReset()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
  })

  it('скачивает ленту одним файлом', async () => {
    mocks.get.mockReturnValue({
      blob: async () => new Blob(['# История']),
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="story.md"' }),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const name = await exportStoryMarkdown('p 1', { assets: false, projectTitle: 'Планета' })

    expect(name).toBe('story.md')
    const [url, options] = mocks.get.mock.calls[0]
    expect(url).toBe('projects/p%201/export.md')
    expect(options.searchParams).toBeUndefined()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('просит картинки параметром assets=1', async () => {
    mocks.get.mockReturnValue({
      blob: async () => new Blob(['PK']),
      headers: new Headers({ 'Content-Disposition': "attachment; filename*=UTF-8''%D0%9F%D0%BB%D0%B0%D0%BD%D0%B5%D1%82%D0%B0.md.zip" }),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const name = await exportStoryMarkdown('p1', { assets: true, projectTitle: 'Планета' })

    expect(name).toBe('Планета.md.zip')
    expect(mocks.get.mock.calls[0][1].searchParams).toEqual({ assets: '1' })
    click.mockRestore()
  })
})

describe('markdownExportFilename', () => {
  it('без заголовка сервера собирает имя из названия проекта', () => {
    expect(markdownExportFilename(null, 'Планета — АнуВаар', false)).toBe('Планета-АнуВаар.md')
    expect(markdownExportFilename(null, 'Планета', true)).toBe('Планета.md.zip')
    expect(markdownExportFilename(null, '  ', false)).toBe('project.md')
  })

  it('читает имя из Content-Disposition', () => {
    expect(markdownExportFilename('attachment; filename="story.md"', 'Планета', false)).toBe('story.md')
  })
})
