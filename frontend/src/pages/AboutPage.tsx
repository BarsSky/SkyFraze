import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getBuildInfo, type BuildInfo } from '../api/health'
import { useAuthStore } from '../store/auth'
import { useLang } from '../store/lang'
import { useT } from '../i18n'

/**
 * «О проекте» (0.114.0; на двух языках с 0.115.0).
 *
 * Зачем страница. Обычный футтер сайта здесь некуда положить: интерфейс — полноэкранные
 * разделы без подвала, а то, что в подвале обычно пишут (что это, под какой лицензией,
 * где исходники, где документация, как связаться), нужно и человеку, выбирающему платформу
 * для своей команды, и тому, кто уже развернул её у себя.
 *
 * Почему отдельная страница, а не футтер на каждой: подвал отнимал бы высоту у стадии и
 * дерева кадров (главный экран проекта), а ссылки в нём нужны редко.
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
  const [lang] = useLang()
  const t = useT()
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

  /**
   * Ссылки на документацию зависят от языка: русскому читателю — русский документ и ссылка на
   * английский рядом, английскому — наоборот. Один и тот же текст в двух местах не дублируем,
   * но и не отправляем человека на документ, которого он не просит.
   */
  const runDoc = lang === 'ru' ? 'docs/run.md' : 'docs/run.en.md'
  const runAlt = lang === 'ru' ? 'docs/run.en.md' : 'docs/run.md'
  const featuresDoc = lang === 'ru' ? 'docs/features.md' : 'docs/features.en.md'
  const featuresAlt = lang === 'ru' ? 'docs/features.en.md' : 'docs/features.md'
  const altLabel = lang === 'ru' ? 'English' : 'Русский'

  const version = build?.version || t('about.build.noVersion')

  return (
    <div className="about" data-about lang={lang}>
      <header className="about__head">
        <h2 className="about__title">{t('about.title')}</h2>
        <p className="muted about__lead">{t('about.lead')}</p>
        <p className="about__build" data-about-version>
          {build === undefined
            ? t('about.build.loading')
            : build === null
              ? t('about.build.unknown')
              : `${t('about.build.value', { version })}${build.commit ? ` · ${build.commit.slice(0, 7)}` : ''}`}
        </p>
      </header>

      <div className="about__grid">
        <section className="card about__card" aria-labelledby="about-license">
          <h3 id="about-license">{t('about.license.title')}</h3>
          <p className="muted">{t('about.license.p1')}</p>
          <p className="muted">{t('about.license.p2')}</p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/LICENSE`} target="_blank" rel="noreferrer">
                {t('about.license.text')}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/NOTICE`} target="_blank" rel="noreferrer">
                {t('about.license.notice')}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/CONTRIBUTING.md`} target="_blank" rel="noreferrer">
                {t('about.license.contributing')}
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-source">
          <h3 id="about-source">{t('about.source.title')}</h3>
          <p className="muted">{t('about.source.p')}</p>
          <ul className="about__links">
            <li>
              <a href={REPO} target="_blank" rel="noreferrer">
                {t('about.source.repo')}
              </a>
            </li>
            <li>
              <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">
                {t('about.source.releases')}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/PROVENANCE.md`} target="_blank" rel="noreferrer">
                {t('about.source.provenance')}
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-docs">
          <h3 id="about-docs">{t('about.docs.title')}</h3>
          <p className="muted">{t('about.docs.p')}</p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/${runDoc}`} target="_blank" rel="noreferrer">
                {t('about.docs.run')}
              </a>{' '}
              ·{' '}
              <a href={`${BLOB}/${runAlt}`} target="_blank" rel="noreferrer">
                {altLabel}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/${featuresDoc}`} target="_blank" rel="noreferrer">
                {t('about.docs.features')}
              </a>{' '}
              ·{' '}
              <a href={`${BLOB}/${featuresAlt}`} target="_blank" rel="noreferrer">
                {altLabel}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/docs/architecture.md`} target="_blank" rel="noreferrer">
                {t('about.docs.architecture')}
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-privacy">
          <h3 id="about-privacy">{t('about.privacy.title')}</h3>
          <p className="muted">{t('about.privacy.p')}</p>
          {!user && (
            <p className="muted">
              {t('about.privacy.anonPrefix')}{' '}
              <Link to="/feed">{t('about.privacy.anonLink')}</Link> {t('about.privacy.anonSuffix')}
            </p>
          )}
        </section>

        <section className="card about__card" aria-labelledby="about-third">
          <h3 id="about-third">{t('about.third.title')}</h3>
          <p className="muted">{t('about.third.p')}</p>
          <ul className="about__links">
            <li>
              <a href={`${BLOB}/THIRD-PARTY-NOTICES.md`} target="_blank" rel="noreferrer">
                {t('about.third.notices')}
              </a>
            </li>
            <li>
              <a href={`${BLOB}/licenses/README.md`} target="_blank" rel="noreferrer">
                {t('about.third.texts')}
              </a>
            </li>
          </ul>
        </section>

        <section className="card about__card" aria-labelledby="about-contact">
          <h3 id="about-contact">{t('about.contact.title')}</h3>
          <p className="muted">{t('about.contact.p')}</p>
          <ul className="about__links">
            <li>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                {t('about.contact.issues')}
              </a>
            </li>
            <li>
              <a href="https://github.com/BarsSky" target="_blank" rel="noreferrer">
                {t('about.contact.owner')}
              </a>
            </li>
          </ul>
        </section>
      </div>

      {/* Второй язык — коротким блоком: у русского интерфейса это английская аннотация (документы
          на английском уже есть с 0.113.0), у английского — русская. `lang` ставим по содержимому,
          а не по интерфейсу: скринридер должен читать блок на его языке. */}
      <section
        className="card about__card about__card--en"
        lang={lang === 'ru' ? 'en' : 'ru'}
        aria-labelledby="about-other"
      >
        <h3 id="about-other">{t('about.en.title')}</h3>
        <p className="muted">{t('about.en.p1')}</p>
        <p className="muted">
          {t('about.en.p2')}{' '}
          <a
            href={`${BLOB}/${lang === 'ru' ? 'docs/run.en.md' : 'docs/run.md'}`}
            target="_blank"
            rel="noreferrer"
          >
            {lang === 'ru' ? 'run.en.md' : 'run.md'}
          </a>{' '}
          {t('about.en.and')}{' '}
          <a
            href={`${BLOB}/${lang === 'ru' ? 'docs/features.en.md' : 'docs/features.md'}`}
            target="_blank"
            rel="noreferrer"
          >
            {lang === 'ru' ? 'features.en.md' : 'features.md'}
          </a>
          .
        </p>
      </section>

      <p className="muted about__foot">{t('about.foot')}</p>
    </div>
  )
}
