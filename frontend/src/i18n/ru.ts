/**
 * Русский словарь интерфейса (0.115.0) — ЭТАЛОН.
 *
 * Ключи плоские, с точками: так diff остаётся читаемым, а поиск по ключу — точным. Значения
 * полностью совпадают с текстами, которые были в компонентах до локализации: русский — язык по
 * умолчанию, и ни одна подпись не должна измениться (иначе поехали бы 3334 строки в тестах).
 *
 * Английский словарь типизирован как `Record<Key, string>`: пропущенный ключ — ошибка `tsc`, а не
 * пустая строка в проде.
 */
export const ru = {
  // ── общее ────────────────────────────────────────────────────────────────────────────────
  'app.loadingSection': 'Открываю раздел…',

  // ── навигация и шапка ───────────────────────────────────────────────────────────────────
  'nav.aria': 'Основная навигация',
  'nav.feed': 'Лента',
  'nav.projects': 'Мои проекты',
  'nav.coauthors': 'Соавторы',
  'nav.people': 'Резиденты',
  'nav.profile': 'Профиль',
  'nav.admin': 'Админка',
  'nav.about': 'О проекте',
  'header.more': 'Ещё',
  'header.moreAria': 'Ещё разделы',
  'header.menuAria': 'Разделы',
  'header.themeDark': 'тёмная',
  'header.themeLight': 'светлая',
  'header.themeToDark': 'Тёмная тема',
  'header.themeToLight': 'Светлая тема (кремово-мятная)',
  'header.toggleTheme': 'Переключить тему',
  'header.toggleLang': 'Переключить язык',
  'header.logout': 'Выйти',
  'header.login': 'Войти',
  'header.userTitle': 'профиль: имя, ник, ключи доступа и журнал входов',

  // ── вход ────────────────────────────────────────────────────────────────────────────────
  'login.subtitle': 'Войдите в аккаунт',
  'login.email': 'email',
  'login.password': 'пароль',
  'login.submit': 'Войти',
  'login.passwordAccepted': 'Пароль принят.',
  'login.confirmBoth': 'Подтвердите вход ключом доступа или кодом из приложения.',
  'login.confirmKey': 'Подтвердите вход ключом доступа.',
  'login.confirmCode': 'Введите код из приложения-аутентификатора.',
  'login.passkey': 'Войти ключом доступа',
  'login.noKey': 'Нет ключа под рукой?',
  'login.useRecovery': 'Ввести код восстановления',
  'login.codeApp': 'код из приложения',
  'login.codeRecovery': 'код восстановления',
  'login.codeAppAria': 'Код двухфакторного входа',
  'login.codeRecoveryAria': 'Код восстановления',
  'login.confirm': 'Подтвердить',
  'login.noPhone': 'Нет телефона под рукой? Введите один из кодов восстановления.',
  'login.back': 'Назад',
  'login.noAccount': 'Нет аккаунта?',
  'login.register': 'Регистрация',
  'login.publicStories': 'Публичные истории',
  'login.publicStoriesNoAuth': '— без входа',
  'login.errRejected': 'Заявка на доступ отклонена администратором.',
  'login.errPending': 'Заявка на доступ ещё не одобрена — дождитесь решения администратора.',
  'login.errBadCreds': 'Неверный email или пароль (или код двухфакторного входа)',
  'login.errTooMany': 'Слишком много попыток — подождите минуту и попробуйте снова.',
  'login.errFailed': 'Не удалось войти',

  // ── регистрация и заявка ────────────────────────────────────────────────────────────────
  'register.loading': 'Загрузка…',
  'register.sentTitle': 'Заявка отправлена',
  'register.sentTextPrefix': 'Администратор рассмотрит заявку для',
  'register.sentTextSuffix': 'Войти можно будет тем паролем, который вы указали, — сразу после одобрения.',
  'register.toLogin': '← Ко входу',
  'register.titleOpen': 'Регистрация',
  'register.titleBootstrap': 'Первый администратор',
  'register.titleRequest': 'Заявка на доступ',
  'register.hintOpen': 'Регистрация открыта: аккаунт создаётся сразу.',
  'register.hintBootstrap':
    'Инсталляция ещё пустая: аккаунт, созданный первым, становится администратором и дальше регистрация идёт по заявке.',
  'register.hintRequest':
    'Регистрация на этой инсталляции — по заявке. Опишите, зачем нужен доступ: администратор рассмотрит заявку.',
  'register.name': 'имя',
  'register.email': 'email',
  'register.password': 'пароль (мин. 8)',
  'register.message': 'чем занимаетесь / зачем доступ (необязательно)',
  'register.create': 'Создать',
  'register.send': 'Отправить заявку',
  'register.haveAccount': 'Уже есть аккаунт?',
  'register.login': 'Войти',
  'register.publicStories': 'Публичные истории',
  'register.publicStoriesTail': 'можно смотреть без аккаунта.',
  'register.errEmailTaken': 'Этот email уже занят или заявка с ним уже на рассмотрении.',
  'register.errClosed': 'Регистрация закрыта: доступ выдаётся по заявке.',
  'register.errInvalid': 'Проверьте поля: имя, email и пароль (минимум 8 символов).',
  'register.errFailed': 'Не удалось зарегистрироваться',

  // ── «О проекте» ─────────────────────────────────────────────────────────────────────────
  'about.title': 'О проекте',
  'about.lead':
    'SkyFraze — платформа для совместной разработки сюжетов игр, кино, мультфильмов и книг: проект разбивается на главы и под-события, каждое показывается кадром сценического таймлайна, а готовую историю можно открыть публично. Платформу можно развернуть у себя и работать со своей командой.',
  'about.build.loading': 'Узнаю версию сборки…',
  'about.build.unknown': 'Версия сборки неизвестна — сервер не ответил',
  'about.build.value': 'Сборка {version}',
  'about.build.noVersion': 'без версии',
  'about.license.title': 'Лицензия',
  'about.license.p1':
    'Apache License 2.0: код можно использовать, изменять, хостить и продавать как часть своего продукта, сохраняя уведомления об авторстве. Патентный грант прилагается, товарный знак — нет: название и логотип SkyFraze™ лицензией не покрываются.',
  'about.license.p2':
    'Лицензия не меняется, платной или закрытой редакции не планируется; вклады принимаются на тех же условиях (CLA нет и не будет).',
  'about.license.text': 'Текст лицензии',
  'about.license.notice': 'Уведомления об авторстве (NOTICE)',
  'about.license.contributing': 'Как присылать изменения',
  'about.source.title': 'Исходный код и происхождение',
  'about.source.p':
    'Канонический репозиторий — на GitHub: там полная история коммитов, теги и релизы. Теги подписываются SSH-ключом; как проверить подлинность сборки и что делать, если вы видите копию, выдающую себя за оригинал, — в PROVENANCE.md.',
  'about.source.repo': 'Репозиторий на GitHub',
  'about.source.releases': 'Релизы и история изменений',
  'about.source.provenance': 'Происхождение и проверка подлинности',
  'about.docs.title': 'Документация',
  'about.docs.p':
    'Руководство по эксплуатации и полный список возможностей — на русском и английском. Проектные разборы решений (архитектура, модель данных, частые дефекты) — на русском, это записи для сопровождающего.',
  'about.docs.run': 'Запуск и эксплуатация',
  'about.docs.features': 'Что умеет платформа',
  'about.docs.architecture': 'Архитектура и модель данных',
  'about.privacy.title': 'Данные и приватность',
  'about.privacy.p':
    'В коде нет ни аналитики, ни телеметрии: сервер не звонит домой. Единственный внешний запрос — к тому провайдеру модели, который указали на этом стенде, и только если помощник включён. Тексты, кадры, карточки и вложения вашего проекта остаются на этом сервере и принадлежат вам: лицензия покрывает программу, а не созданное в ней.',
  'about.privacy.anonPrefix': 'Разделы с проектами появятся после входа или регистрации —',
  'about.privacy.anonLink': 'публичная лента',
  'about.privacy.anonSuffix': 'открыта и без входа.',
  'about.third.title': 'Сторонние компоненты',
  'about.third.p':
    'Платформа собрана на открытых компонентах: Go, React, PostgreSQL, Yjs (CRDT), KaTeX, Mermaid. Полный состав с лицензиями и дословными текстами — в THIRD-PARTY-NOTICES.md и каталоге licenses/. Если вы раздаёте сборку или Docker-образ, приложите LICENSE, NOTICE, THIRD-PARTY-NOTICES.md и тексты из licenses/.',
  'about.third.notices': 'Сторонние компоненты и лицензии',
  'about.third.texts': 'Полные тексты лицензий',
  'about.contact.title': 'Связь',
  'about.contact.p':
    'Ошибки и предложения — в issues репозитория. Об уязвимостях — приватно владельцу проекта, до публикации.',
  'about.contact.issues': 'Issues и предложения',
  'about.contact.owner': 'Владелец проекта на GitHub',
  'about.en.title': 'About this project (English)',
  'about.en.p1':
    'SkyFraze is an open-source platform for collaborative story development for games, film, animation and books. It is licensed under Apache-2.0: use, modify and host it, including commercially, as long as you keep the copyright notices (a trademark grant is not included). The license will not change, and contributions are accepted under the same terms — no CLA.',
  'about.en.p2':
    'Self-host it for your own team: there is no telemetry, and the stories you create stay yours. Operations guide and the full feature list exist in English:',
  'about.en.and': 'and',
  'about.foot': 'SkyFraze™ · Apache-2.0 · © 2026 SkyFraze contributors',
} as const
