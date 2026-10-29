import type { ru } from './ru'

/**
 * Английский словарь интерфейса (0.115.0).
 *
 * Тип `Record<Key, string>` — не украшение: он делает пропущенный ключ ошибкой `tsc` и не даёт
 * добавить лишний. Ключи, которых в фазе 1 ещё нет, появятся здесь же, когда их переведут.
 *
 * Правила перевода (см. docs/ui-localization.md): подписи — по-английски, названия элементов
 * интерфейса, которые человек увидит по-русски (у него русская панель), не выдумываем; русский
 * остаётся оригиналом данных и не переводится никогда.
 */
type Key = keyof typeof ru

export const en: Record<Key, string> = {
  'app.loadingSection': 'Opening the section…',

  'nav.aria': 'Main navigation',
  'nav.feed': 'Feed',
  'nav.projects': 'My projects',
  'nav.coauthors': 'Co-authors',
  'nav.people': 'Residents',
  'nav.profile': 'Profile',
  'nav.admin': 'Admin',
  'nav.about': 'About',
  'header.more': 'More',
  'header.moreAria': 'More sections',
  'header.menuAria': 'Sections',
  'header.themeDark': 'dark',
  'header.themeLight': 'light',
  'header.themeToDark': 'Dark theme',
  'header.themeToLight': 'Light theme (cream-mint)',
  'header.toggleTheme': 'Switch theme',
  'header.toggleLang': 'Switch language',
  'header.logout': 'Sign out',
  'header.login': 'Sign in',
  'header.userTitle': 'profile: name, nick, access keys and sign-in log',

  'login.subtitle': 'Sign in to your account',
  'login.email': 'email',
  'login.password': 'password',
  'login.submit': 'Sign in',
  'login.passwordAccepted': 'Password accepted.',
  'login.confirmBoth': 'Confirm with an access key or an app code.',
  'login.confirmKey': 'Confirm with an access key.',
  'login.confirmCode': 'Enter the code from your authenticator app.',
  'login.passkey': 'Sign in with an access key',
  'login.noKey': 'No key at hand?',
  'login.useRecovery': 'Enter a recovery code',
  'login.codeApp': 'app code',
  'login.codeRecovery': 'recovery code',
  'login.codeAppAria': 'Two-factor sign-in code',
  'login.codeRecoveryAria': 'Recovery code',
  'login.confirm': 'Confirm',
  'login.noPhone': 'No phone at hand? Enter one of the recovery codes.',
  'login.back': 'Back',
  'login.noAccount': 'No account yet?',
  'login.register': 'Sign up',
  'login.publicStories': 'Public stories',
  'login.publicStoriesNoAuth': '— no sign-in needed',
  'login.errRejected': 'The access request was rejected by the administrator.',
  'login.errPending': 'The access request has not been approved yet — wait for the administrator.',
  'login.errBadCreds': 'Wrong e-mail or password (or two-factor code)',
  'login.errTooMany': 'Too many attempts — wait a minute and try again.',
  'login.errFailed': 'Sign-in failed',

  'register.loading': 'Loading…',
  'register.sentTitle': 'Request sent',
  'register.sentTextPrefix': 'The administrator will review the request for',
  'register.sentTextSuffix': 'You will be able to sign in with the password you set, right after approval.',
  'register.toLogin': '← Back to sign-in',
  'register.titleOpen': 'Sign up',
  'register.titleBootstrap': 'First administrator',
  'register.titleRequest': 'Access request',
  'register.hintOpen': 'Registration is open: the account is created immediately.',
  'register.hintBootstrap':
    'The installation is still empty: the first account becomes the administrator, and registration continues by request afterwards.',
  'register.hintRequest':
    'Registration on this installation is by request. Describe why you need access: the administrator will review it.',
  'register.name': 'name',
  'register.email': 'email',
  'register.password': 'password (min. 8)',
  'register.message': 'what you do / why you need access (optional)',
  'register.create': 'Create',
  'register.send': 'Send request',
  'register.haveAccount': 'Already have an account?',
  'register.login': 'Sign in',
  'register.publicStories': 'Public stories',
  'register.publicStoriesTail': 'can be read without an account.',
  'register.errEmailTaken': 'This e-mail is already taken, or a request with it is already pending.',
  'register.errClosed': 'Registration is closed: access is granted by request.',
  'register.errInvalid': 'Check the fields: name, e-mail and password (at least 8 characters).',
  'register.errFailed': 'Registration failed',

  'about.title': 'About',
  'about.lead':
    'SkyFraze is a platform for collaborative story development for games, film, animation and books: a project is split into chapters and sub-events, each shown as a frame of a staged timeline, and the finished story can be published. You can self-host the platform and work with your own team.',
  'about.build.loading': 'Checking the build version…',
  'about.build.unknown': 'Build version unknown — the server did not answer',
  'about.build.value': 'Build {version}',
  'about.build.noVersion': 'no version',
  'about.license.title': 'License',
  'about.license.p1':
    'Apache License 2.0: use, modify, host and sell the code as part of your product as long as you keep the copyright notices. A patent grant comes with it, a trademark grant does not: the SkyFraze™ name and logo are not covered.',
  'about.license.p2':
    'The license does not change, no paid or closed edition is planned, and contributions are accepted under the same terms (no CLA, now or later).',
  'about.license.text': 'License text',
  'about.license.notice': 'Copyright notices (NOTICE)',
  'about.license.contributing': 'How to contribute',
  'about.source.title': 'Source code and provenance',
  'about.source.p':
    'The canonical repository is on GitHub: it holds the full commit history, tags and releases. Tags are signed with an SSH key; how to verify a build and what to do if you see a copy claiming to be the original is described in PROVENANCE.md.',
  'about.source.repo': 'Repository on GitHub',
  'about.source.releases': 'Releases and changelog',
  'about.source.provenance': 'Provenance and authenticity check',
  'about.docs.title': 'Documentation',
  'about.docs.p':
    'The operations guide and the full feature list exist in Russian and English. Design notes (architecture, data model, common defects) are in Russian — they are maintainer records.',
  'about.docs.run': 'Running and operations',
  'about.docs.features': 'What the platform can do',
  'about.docs.architecture': 'Architecture and data model',
  'about.privacy.title': 'Data and privacy',
  'about.privacy.p':
    'There is no analytics and no telemetry in the code: the server does not phone home. The only outbound request goes to the model provider configured on this installation, and only when the assistant is enabled. The text, frames, cards and attachments of your project stay on this server and belong to you: the license covers the software, not what is created with it.',
  'about.privacy.anonPrefix': 'Project sections appear after sign-in or registration —',
  'about.privacy.anonLink': 'the public feed',
  'about.privacy.anonSuffix': 'is open without signing in.',
  'about.third.title': 'Third-party components',
  'about.third.p':
    'The platform is built on open components: Go, React, PostgreSQL, Yjs (CRDT), KaTeX, Mermaid. The full inventory with licenses and verbatim texts is in THIRD-PARTY-NOTICES.md and the licenses/ directory. If you distribute a build or a Docker image, ship LICENSE, NOTICE, THIRD-PARTY-NOTICES.md and the texts from licenses/.',
  'about.third.notices': 'Third-party components and licenses',
  'about.third.texts': 'Full license texts',
  'about.contact.title': 'Contact',
  'about.contact.p':
    'Bugs and suggestions go to the repository issues. Report vulnerabilities privately to the project owner before disclosure.',
  'about.contact.issues': 'Issues and suggestions',
  'about.contact.owner': 'Project owner on GitHub',
  'about.en.title': 'О проекте (по-русски)',
  'about.en.p1':
    'SkyFraze — платформа для совместной разработки сюжетов: главы и под-события, сценический таймлайн, публичная лента. Лицензия Apache-2.0, закрытой редакции не планируется, CLA нет.',
  'about.en.p2':
    'Документация на русском — в run.md и features.md:',
  'about.en.and': 'и',
  'about.foot': 'SkyFraze™ · Apache-2.0 · © 2026 SkyFraze contributors',
}
