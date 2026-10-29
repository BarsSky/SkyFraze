# Происхождение проекта / Project provenance

Этот файл отвечает на два вопроса: «откуда взялся этот код» и «что делать, если вы видите копию,
которая выдаёт себя за оригинал». Он не заменяет лицензию и не ограничивает права, которые она уже
дала: `LICENSE` (Apache-2.0) действует независимо от этого текста.

---

## Русский

### Канонический источник

**<https://github.com/BarsSky/SkyFraze>** — единственный канонический репозиторий проекта.
Первый публичный коммит: **26 сентября 2026** (`66f991c`, 10:12 MSK). На момент 0.111.0 в
репозитории 185 тегов и непрерывная история коммитов от первого до текущего.

SkyFraze развивается как открытая платформа: любой может развернуть её у себя, пригласить свою
команду и вести собственные проекты. Форки, приватные установки и собственные доработки —
ожидаемое и разрешённое использование (Apache-2.0, §2–§4). Ограничение одно и оно про атрибуцию:
при **распространении** сборки сохраняйте `LICENSE` и `NOTICE` и не выдавайте название и логотип
SkyFraze за свои (§4 и §6).

### Как проверить подлинность

Всё проверяется локально, по публичной истории, без доверия к чьим-либо словам:

```bash
git clone --recurse-submodules https://github.com/BarsSky/SkyFraze.git
git log --reverse --format='%ad %h %s' --date=short | head -3   # первые коммиты и их даты
git tag --sort=creatordate | tail -5                            # релизы
git tag -v v0.113.0                                             # подпись тега (см. ниже)
```

Публичный список релизов: <https://github.com/BarsSky/SkyFraze/releases>. Тег и релиз с одинаковым
именем выпускаются одновременно; в логах CI по каждому коммиту видны прогоны тестов.

### Подпись тегов

Теги подписываются SSH-ключом владельца проекта. Отпечаток ключа, которым проверяются подписи:

```
SHA256:ztICw7rO02CzFzNFC5EzVdWMfk+ebUDTRpsFUIuEgjo
```

Проверка без GitHub: добавьте строку `<email автора> <публичный ключ>` в файл `allowed_signers`
и выполните `git -c gpg.ssh.allowedSignersFile=allowed_signers tag -v vX.Y.Z` — Git покажет
«Good "git" signature for …» и отпечаток.

Публичный ключ подписи (тот же, что в `~/.ssh/id_ed25519.pub` владельца):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhxeY+aH2veN9JEsXRoeowWBAghgf9WSEzLxQ3abEpU knaga@SKYWORKER
```

Готовая строка для `allowed_signers` (подставьте её в файл целиком):

```
knagaenko@mail.ru ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhxeY+aH2veN9JEsXRoeowWBAghgf9WSEzLxQ3abEpU comment="knaga@SKYWORKER"
```

Честная оговорка: **теги до 0.112.0 не подписаны** — подпись включена позже истории. Их авторство
подтверждается публичной историей, релизами и прогонами CI, но не криптографией. Начиная с 0.112.0
каждый тег подписан; подписанные и старые теги легко отличить: `git cat-file -p vX.Y.Z` покажет
блок `-----BEGIN SSH SIGNATURE-----` у подписанного.

На GitHub подпись помечается «Verified» только после того, как этот ключ добавлен в профиле как
**Signing Key** (Settings → SSH and GPG keys). До этого GitHub показывает «Unverified» — это
утверждение GitHub о незнакомом ключе, а не о недействительной подписи: проверка `git tag -v`
по ключу выше работает независимо от GitHub.

### Внешний архив (независимая датированная копия)

Публичный архив кода, не зависящий ни от GitHub, ни от владельца проекта, — Software Heritage.
Отправить репозиторий на архивацию (одна минута, нужен браузер):

<https://archive.softwareheritage.org/save/?origin_url=https://github.com/BarsSky/SkyFraze>

После архивации у снимка появляется SWHID — постоянный идентификатор с датой. Он будет добавлен
сюда; до этого внешней архивной копии нет, и это тоже честнее, чем ссылаться на несуществующую.

### Если вы видите копию, которая утверждает, что она оригинал

1. Сверьте даты: первый коммит оригинала — 2026-09-26, дальше непрерывная история. У копии либо
   история короче, либо начинается позже, либо переписана.
2. Сверьте `NOTICE`: добросовестная копия обязана сохранить уведомление об авторстве (Apache-2.0,
   §4(c)). Копия без `NOTICE` или с переписанным copyright нарушает лицензию — это уже не спор об
   авторстве, а нарушение условий распространения.
3. Сверьте название: использовать «SkyFraze» и логотип в названии своего продукта или форка
   лицензия не разрешает (§6). Если кто-то выдаёт сборку за официальный SkyFraze — это
   единственная ситуация, где нужен товарный знак, а не авторское право.
4. Дальше — по существу: сохраните ссылки, даты и скриншоты, и напишите владельцу проекта
   (контакт — в профиле GitHub <https://github.com/BarsSky>).

Отдельно и прямо: **никакой документ не мешает кому-то ложно заявить авторство.** Защищает не
запрет, а доказательство первенства — публичная датированная история, релизы, `NOTICE` и подписи.
Всё перечисленное выше существует именно для этого.

---

## English

### Canonical source

**<https://github.com/BarsSky/SkyFraze>** is the only canonical repository of the project.
First public commit: **September 26, 2026** (`66f991c`, 10:12 MSK). As of 0.111.0 the repository
holds 185 tags and an unbroken commit history from the first commit to the current one.

SkyFraze is an open platform: anyone may self-host it, invite their own team and run their own
projects. Forks, private installations and your own modifications are the expected and permitted
use (Apache-2.0, §2–§4). There is exactly one condition, and it is about attribution: when you
**distribute** a build, keep `LICENSE` and `NOTICE` and do not present the SkyFraze name or logo as
your own (§4 and §6).

### How to verify authenticity

Everything is checkable locally, against the public history — no trust required:

```bash
git clone --recurse-submodules https://github.com/BarsSky/SkyFraze.git
git log --reverse --format='%ad %h %s' --date=short | head -3   # first commits and their dates
git tag --sort=creatordate | tail -5                            # releases
git tag -v v0.113.0                                             # tag signature (see below)
```

Public release list: <https://github.com/BarsSky/SkyFraze/releases>. The tag and the release with the
same name are published together; CI logs per commit are public.

### Tag signing

Tags are signed with the project owner's SSH key. The fingerprint used to verify signatures:

```
SHA256:ztICw7rO02CzFzNFC5EzVdWMfk+ebUDTRpsFUIuEgjo
```

Verification without GitHub: put the line `<author email> <public key>` into an `allowed_signers`
file and run `git -c gpg.ssh.allowedSignersFile=allowed_signers tag -v vX.Y.Z` — Git prints
`Good "git" signature for …` and the fingerprint.

Signing public key (the owner's `~/.ssh/id_ed25519.pub`):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhxeY+aH2veN9JEsXRoeowWBAghgf9WSEzLxQ3abEpU knaga@SKYWORKER
```

Ready-to-use `allowed_signers` line (paste it into the file as is):

```
knagaenko@mail.ru ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhxeY+aH2veN9JEsXRoeowWBAghgf9WSEzLxQ3abEpU comment="knaga@SKYWORKER"
```

Honest caveat: **tags before 0.112.0 are not signed** — signing was introduced later than most of the
history. Their authorship is evidenced by the public history, releases and CI runs, not by
cryptography. From 0.112.0 on every tag is signed; signed and old tags are easy to tell apart:
`git cat-file -p vX.Y.Z` shows a `-----BEGIN SSH SIGNATURE-----` block for a signed one.

GitHub marks a signature "Verified" only after this key is added to the profile as a **Signing Key**
(Settings → SSH and GPG keys). Until then GitHub shows "Unverified" — that is GitHub stating it does
not know the key, not that the signature is invalid: `git tag -v` with the key above works regardless.

### External archive (independent dated copy)

A public code archive independent of both GitHub and the project owner is Software Heritage. Submit
the repository for archiving (one minute, browser required):

<https://archive.softwareheritage.org/save/?origin_url=https://github.com/BarsSky/SkyFraze>

Once archived, the snapshot gets a SWHID — a permanent identifier with a date. It will be recorded
here; until then no external archived copy exists, and saying so is more honest than linking to one.

### If you see a copy claiming to be the original

1. Compare dates: the original's first commit is 2026-09-26, followed by a continuous history. A copy
   either has a shorter history, starts later, or has been rewritten.
2. Compare `NOTICE`: a compliant copy must keep the copyright notice (Apache-2.0, §4(c)). A copy with
   no `NOTICE`, or with rewritten copyright, violates the license — that is no longer a dispute about
   authorship but about distribution terms.
3. Compare the name: using "SkyFraze" and its logo in the name of your product or fork is not
   permitted (§6). If someone presents a build as the official SkyFraze, that is the one case where
   trademark law, not copyright, is the tool.
4. Then keep the evidence: links, dates, screenshots, and contact the project owner (see the GitHub
   profile <https://github.com/BarsSky>).

One thing stated plainly: **no document stops someone from falsely claiming authorship.** What
protects the project is evidence of precedence — a public dated history, releases, `NOTICE` and
signatures. Everything above exists for that purpose.
