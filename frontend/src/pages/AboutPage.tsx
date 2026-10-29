import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getBuildInfo, type BuildInfo } from '../api/health'
import { useAuthStore } from '../store/auth'

/**
 * «О проекте» (0.114.0).
 *
 * Зачем страница. Обычный футтер сайта здесь некуда положить: интерфейс — полноэкранные
 * разделы без подвала, а то, что в подвале обычно пишут (что это, под какой лицензией,
 * где исходники, где документация, как связаться), нужно и человеку, выбирающему платформу
 * для своей команды, и тому, кто уже развернул её у себя и хочет понять, что у него стоит.
 *
 * Почему отдельная страница, а не футтер на каждой: подвал отнимал бы высоту у стадии и
 * дерева кадров (главный экран проекта), а ссылки в нём нужны редко. Отдельная страница
 * открывается из шапки — на узком экране она живёт в меню «Ещё», вместе с остальными
 * разделами.
 *
 * Страница публичная (без входа): витрина проекта должна читаться до регистрации на стенде.
 *
 * Номер версии берётся у СЕРВЕРА (`GET /api/health`): именно он показывает, что развёрнуто на
 * этом стенде. Если сервер не ответил, страница не ломается — просто не показывает версию.
 */
const REPO = 'https://github.com/BarsSky/SkyFraze'
const BLOB = `${REPO}/blob/master`

export function AboutPage() {
  const user = useAuthStore((s) => s.user)
  const [build, setBuild] = useState<BuildInfo | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void getBuildInfo().then((info) => {
      if (alive) setBuild(info)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="about" data-about>
      <header className="about__head">
        <h2 className="about__title">О проекте</h2>
        <p className="muted about__lead">
          SkyFraze — платформа для совместной разработки сюжетов игр, кино, мультфильмов и книг:
          проект разбивается на главы и под-события, каждое показывается кадром сценического
          таймлайна, а готовую историю можно открыть публично. Платформу можно развернуть у себя и
          работать со своей командой.
        </p>
        <p className="about__build" data-about-version>
          {build === undefined
            ? 'Узнаю версию сборки…'
            : build === null
              ? 'Версия сборки неизвестна — сервер не ответил'
              : `Сборка ${build.version || 'без версии'}${build.commit ? ` · ${build.commit.slice(0, 7)}` : ''}`}
        </p>
      </header>

      <div className="about__grid">
        <section className="card about__card" aria-labelledby="about-license">
          <h3 id="about-license">Лицензия</h3>
          <p className="muted">
            Apache License 2.0: код можно использовать, изменять, хостить и продавать как часть
            своего продукта, сохраняя уведомления об авторстве. Патентный грант прилагается,
            товарный знак — нет: название и логотип SkyFraze™ лицензией не покрываются.
          </p>
          <p className="muted">
            Лицензия не меняется, платной или закрытой редакции не планируется; вклады принимаются
            на тех же условиях (CLA нет и не будет).
          </p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/LICENSE`} target="_blank" rel="noreferrer">
                Текст лицензии
              </a>
            </li>
            <li>
              <a href={`${BLOB}/NOTICE`} target="_blank" rel="noreferrer">
                Уведомления об авторстве (NOTICE)
              </a>
            </li>
            <li>
              <a href={`${BLOB}/CONTRIBUTING.md`} target="_blank" rel="noreferrer">
                Как присылать изменения
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-source">
          <h3 id="about-source">Исходный код и происхождение</h3>
          <p className="muted">
            Канонический репозиторий — на GitHub: там полная история коммитов, теги и релизы. Теги
            подписываются SSH-ключом; как проверить подлинность сборки и что делать, если вы видите
            копию, выдающую себя за оригинал, — в PROVENANCE.md.
          </p>
          <ul className="about__links">
            <li>
              <a href={REPO} target="_blank" rel="noreferrer">
                Репозиторий на GitHub
              </a>
            </li>
            <li>
              <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">
                Релизы и история изменений
              </a>
            </li>
            <li>
              <a href={`${BLOB}/PROVENANCE.md`} target="_blank" rel="noreferrer">
                Происхождение и проверка подлинности
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-docs">
          <h3 id="about-docs">Документация</h3>
          <p className="muted">
            Руководство по эксплуатации и полный список возможностей — на русском и английском.
            Проектные разборы решений (архитектура, модель данных, частые дефекты) — на русском,
            это записи для сопровождающего.
          </p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/docs/run.md`} target="_blank" rel="noreferrer">
                Запуск и эксплуатация
              </a>{' '}
              ·{' '}
              <a href={`${BLOB}/docs/run.en.md`} target="_blank" rel="noreferrer">
                English
              </a>
            </li>
            <li>
              <a href={`${BLOB}/docs/features.md`} target="_blank" rel="noreferrer">
                Что умеет платформа
              </a>{' '}
              ·{' '}
              <a href={`${BLOB}/docs/features.en.md`} target="_blank" rel="noreferrer">
                English
              </a>
            </li>
            <li>
              <a href={`${BLOB}/docs/architecture.md`} target="_blank" rel="noreferrer">
                Архитектура и модель данных
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-privacy">
          <h3 id="about-privacy">Данные и приватность</h3>
          <p className="muted">
            В коде нет ни аналитики, ни телеметрии: сервер не звонит домой. Единственный внешний
            запрос — к тому провайдеру модели, который указали на этом стенде, и только если
            помощник включён. Тексты, кадры, карточки и вложения вашего проекта остаются на этом
            сервере и принадлежат вам: лицензия покрывает программу, а не созданное в ней.
          </p>
          {!user && (
            <p className="muted">
              Разделы с проектами появятся после входа или регистрации —{' '}
              <Link to="/feed">публичная лента</Link> открыта и без входа.
            </p>
          )}
        </section>

        <section className="card about__card" aria-labelledby="about-third">
          <h3 id="about-third">Сторонние компоненты</h3>
          <p className="muted">
            Платформа собрана на открытых компонентах: Go, React, PostgreSQL, Yjs (CRDT), KaTeX,
            Mermaid. Полный состав с лицензиями и дословными текстами — в THIRD-PARTY-NOTICES.md и
            каталоге licenses/. Если вы раздаёте сборку или Docker-образ, приложите LICENSE, NOTICE,
            THIRD-PARTY-NOTICES.md и тексты из licenses/.
          </p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/THIRD-PARTY-NOTICES.md`} target="_blank" rel="noreferrer">
                Сторонние компоненты и лицензии
              </a>
            </li>
            <li>
              <a href={`${BLOB}/licenses/README.md`} target="_blank" rel="noreferrer">
                Полные тексты лицензий
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-contact">
          <h3 id="about-contact">Связь</h3>
          <p className="muted">
            Ошибки и предложения — в issues репозитория. Об уязвимостях — приватно владельцу
            проекта, до публикации.
          </p>
          <ul className="about__links">
            <li>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                Issues и предложения
              </a>
            </li>
            <li>
              <a href="https://github.com/BarsSky" target="_blank" rel="noreferrer">
                Владелец проекта на GitHub
              </a>
            </li>
          </ul>
        </section>
      </div>

      {/* Английский блок: английские версии документов уже есть (0.113.0), и тот, кто выбирает
          платформу, часто читает по-английски. Коротко — то же, что выше, без пересказа целиком. */}
      <section className="card about__card about__card--en" lang="en" aria-labelledby="about-en">
        <h3 id="about-en">About this project (English)</h3>
        <p className="muted">
          SkyFraze is an open-source platform for collaborative story development for games, film,
          animation and books. It is licensed under Apache-2.0: use, modify and host it, including
          commercially, as long as you keep the copyright notices (a trademark grant is not included).
          The license will not change, and contributions are accepted under the same terms — no CLA.
        </p>
        <p className="muted">
          Self-host it for your own team: there is no telemetry, and the stories you create stay
          yours. Operations guide and the full feature list exist in English: {' '}
          <a href={`${BLOB}/docs/run.en.md`} target="_blank" rel="noreferrer">
            run.en.md
          </a>{' '}
          and{' '}
          <a href={`${BLOB}/docs/features.en.md`} target="_blank" rel="noreferrer">
            features.en.md
          </a>
          . Source, releases and provenance:{' '}
          <a href={REPO} target="_blank" rel="noreferrer">
            github.com/BarsSky/SkyFraze
          </a>
          .
        </p>
      </section>

      <p className="muted about__foot">
        SkyFraze™ · Apache-2.0 · © 2026 SkyFraze contributors
      </p>
    </div>
  )
}
