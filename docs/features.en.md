# What SkyFraze can do

[Русский](features.md) · **English**

The complete feature list — one item per feature. `README.en.md` keeps the essentials; this file has
everything else, with links to the documents where each decision is analysed (those are in Russian).

Items are grouped the same way as in the README: text and frames first, then the project as a whole,
then people and access.

## Features

- Projects (stories) with an owner and a team
- **Project trash**: deleting a project does not erase the manuscript but moves it to the trash for
  30 days — the project disappears from the list, from the API and from the public feed (for the team
  as well) and comes back with one button together with all text, files and history. Permanent
  deletion is a separate button with confirmation; after the term expires it is done by the nightly
  cleanup (`docs/architecture.md`, section "Trash")
- Staged timeline: a fixed stage, scrolling switches frames and text segments (composition inspired
  by scroll-world)
- Every event is its own frame: a chapter, then its sub-events one at a time (numbering 01.1, 01.1.1)
- **Event images are frames too**: scrolling down walks the photos one by one (01.1·1, 01.1·2), and
  only then does the next sub-event or the next event begin; an image is shown in full and is not
  cropped at the edges
- **Full-screen image viewer**: a click on a thumbnail (in a frame or in the editor) opens a separate
  layer above the site — swipe left/right, arrow keys ← →, a "2 / 5" counter, closing with Esc, a
  click on the background or the button
- Configurable frame background: same as the chapter / custom tone / an image from the event's
  attachments
- **Markdown in the event text**: headings, lists, quotes, code, **tables**, **formulas** ($…$ and
  $$…$$, rendered by KaTeX) and Mermaid **diagrams** (flowcharts, sequences, timelines, relations,
  plans, state machines). The text is edited both in the panel field and in a separate window with
  live preview, an insert panel and "text / preview / side by side" modes. Raw HTML is forbidden,
  rendered HTML is sanitised — readers of the public story see exactly the same thing
- **AI agent "Nestor"** — a co-author of the project that helps build it: it creates chapters and
  sub-events with Markdown descriptions through tools. It has its own name and its own member
  record: its edits are signed by it, and its rights are those of an editor co-author (it writes
  text but cannot publish or delete). The project owner sets its role (chronicler, editor,
  co-author-sci-fi writer, planner) and instructions, or disables it in this project. The answer
  arrives **as a stream** (you can watch the model write) with a "Stop" («Стоп») button; a question
  can carry an **image** if the model can see images; token usage is visible and can be capped per
  day on the instance. Everyone connects **their own model server** (llama.cpp, vLLM, LM Studio,
  Ollama on their machine) right in the assistant settings — by URL, without editing the server's
  `.env`. Details — `docs/ai-assistant.md`
- **Project version history**: snapshots are taken automatically along the way (every 5 minutes) and
  by button, and from the "Versions" («Версии») window the project can be rolled back to any of them
  — with a preview of what exactly will come back (`docs/versions.md`)
- Two themes: dark and a light cream-mint one (switch in the header)
- Sketches / drawings / asset files (filesystem in the MVP, MinIO/S3 in Phase 2). **Batch upload**:
  in a frame and in the file list you can select several files at once — they go one by one (the
  server recompresses images), with progress "uploading 3 of 7" and a summary "5 of 7 uploaded" with
  the reasons for refusals; when the space runs out the rest is not sent. **Moving an attachment
  between frames**: the file list shows in which chapters and sub-events a file lives, and it can be
  moved to another frame (or attached to the first one) — the background of the source frame is
  cleared, and in an empty target the image becomes the background
- Real-time collaborative narrative editing over Yjs (CRDT) with autosave
- Teams with owner / editor / viewer roles; invitations by e-mail or invite token
- **Co-authors** — a creative circle: searching people by nick (`@nick`) and name, application and
  consent, specialisations (proofreading, hero or villain development, technical concepts, magic
  systems, landscapes, art…). The owner can use a switch to open their **private projects to a
  co-author as read-only**, and the circle list is available right when a member is added to a
  project (`/coauthors`)
- **Residents** (`/people`) — a shared catalogue of registered users: a short "about" summary,
  specialisations, how many stories the person published and what relation they have to you
  (co-author, incoming or outgoing application). Search by nick and name, filter by specialisation,
  expanding a row with public stories and a co-author request right from the catalogue
- **Profile** (`/profile`) — a dedicated tab for everything about the account (0.99.0): name, nick,
  summary and specialisations, visibility in the residents catalogue (visible by default; unchecking
  hides you both from the catalogue and from co-author search), the "e-mail me notes" checkbox, the
  second sign-in factor and a sign-in log with active sessions. The name in the header leads here
  too, while the co-author circle kept its own page
- **Frame text unfolds by scrolling**: a long chapter gets a longer track, and its text scrolls past
  as you read — there is no separate scroll inside the sheet, neither on a phone nor on a wide screen
- **Reordering events by dragging**: a row in the editor tree can be dragged with a mouse or a
  finger (on a phone — by its handle) and dropped "before", "after" or "inside" — level and order
  change in one motion, a subtree moves as a whole; with a keyboard use Alt+↑/↓/←/→. Edits go to the
  CRDT in one transaction
- **Search by project title and text**: the field in the "Editors" («Редакторы») panel searches the
  entire frame text, not just headings, and shows a snippet around the match. It runs over the live
  document in the browser, so it also finds what has not reached the server yet
  (`docs/realtime-editor.md`, phase 6)
- **Project tabs for the owner and co-authors**: "Project" («Проект», stage and frame text),
  "Editors" («Редакторы»), "Relations" («Связи»), "Versions" («Версии») — one area at a time, with no
  overlapping strips; the assistant is available on each through its own floating button. The public
  version and guests see the previous scrolling flow "stage → relations → editors" (0.83.0)
- **Project relations — character, place and theme cards**: the **"Relations" («Связи»)** section —
  a tab for the owner, a scrolling section for a reader (the button next to "Editors"): a graph in
  "space", cards with **aliases** ("Anna", "Anya", "Anna's") so that "the same Anna" does not fall
  apart into three spellings, mention counters, a chronology and a "who shares a chapter" matrix.
  **Selecting a card** in the graph moves it to the centre (320 ms) and unfolds its values: kind,
  aliases, description, nearest links (0.84.0); a link line breaks where its label sits. A name is
  unique within a project case-insensitively; any member reads cards and an editor changes them
  (`docs/entity-links.md`); **the AI assistant sees cards** (`list_entities`) and proposes new ones
  (`propose_entities`), but a human creates them. **Custom card kinds** live in the project:
  "Faction", "Artifact", anything, next to the starting Character/Place/Theme
  (`docs/entity-types.md`, migration `0034`); a **card template** of a kind (a description with
  `{{name}}` and typical aliases) is prefilled into the form and edited by a human (0.85.0). A
  **project template** transfers the project's setup between projects and installations: kinds with
  templates, selected cards and assistant settings (`GET/POST …/template`, `template.json` in the
  archive, "create from a sample"); the merge never deletes and is idempotent — repeating it changes
  nothing. **Links between cards** ("Anya lives on Earth") are a separate line per link in the card,
  with a direction label and removal; beyond five links the list collapses into "Show all N", and
  **renaming does not lose the link to the text**: the previous name stays an alias and a note says
  how many times it still occurs in frames
- **Frame discussions**: under the selected frame you can leave a note and **reply to it** in a thread
  (one thread per note — deeper does not read in a narrow panel); **`@nick`** addresses the note to a
  person — participant suggestions by `@`, nick highlighting in the text and a "you were mentioned"
  banner in the bell; **reactions** "agree" and "done" answer with one click without taking a line in
  the thread; a note can be attached **to a selected text fragment** — the anchor lives in the CRDT
  and survives edits (the quote and the "fragment in place / removed" status are shown in the panel).
  Tree rows and the project list show where there are **new** notes (the counter goes out once the
  discussion is opened). In the header there is a **bell** with the total unread count and a list of
  "how many in which project": a co-author's note is visible even if you work in the editor rather
  than in the project list. Deleting your own note is soft: the row stays as "Comment deleted"
  («Комментарий удалён») while replies to it live on. Comments go neither into the book nor into the
  Markdown export: this is a conversation about the text, not the text (`docs/comments.md`
  §5.3–5.7)
- **Attachments can live in S3/MinIO** (`STORAGE_DRIVER=s3`): files stop being part of the instance's
  machine and the bucket gains versioning. Backups stay complete — `deploy/backup.sh` can take
  attachments from the bucket (`docs/storage-s3.md` §11)
- **Markdown export and import**: a project downloads as a single feed (`.md`) or as a zip with
  assets — `story.md`, a `story/` folder with one file per frame, images and a transfer manifest (the
  same archive works for moving to another instance). The other way is "Import folder": a folder of
  md files or a zip, a tree preview and project creation (folder = project, subdirectories =
  chapters, the number comes from the file name), and **images and other files are attached to their
  events** — a file mentioned in the text becomes an attachment of that event and the frame
  background. The format is described in `docs/import-export.md`; the storage and snapshot plan is in
  `docs/storage-compression.md`
- **The book as a file**: a project downloads as **EPUB** (chapters and sub-events, a table of
  contents built from the tree, frame illustrations — for e-readers and phones) or as **DOCX**
  (headings as styles, emphasis, lists, tables, images — for editing in Word/LibreOffice)
  (`docs/import-export.md` §1.3)
- **Custom DOCX styling**: a real `.docx` template with a `{{content}}` placeholder is uploaded into
  the project, the server parses it and shows a report — a style map (which style became which),
  warnings, whether the placeholder was found; several templates can be kept, one is active, and it
  can be changed right in the "Book" («Книга») menu before downloading. The frame editor also has a
  **"DOCX markup" («Разметка DOCX»)** panel — a page break and a table of contents are inserted as
  markers that do not disturb the text or break highlighting; the same panel has template help and a
  "download a sample" button (the sample must be accepted by our own parser — and that is checked)
  (`docs/docx-template.md`)
- **"Into place" import**: the same set of md files can be inserted into an **existing** project — the
  editors panel parses a folder (or a zip) and shows a chunk that is dragged onto a tree row (the
  left half of the row means "before/after", the right half "inside"); the place can also be chosen
  from a list (for touch and keyboard). The insertion goes into the project's CRDT document, so
  everyone who has it open sees it immediately — without reloading the page
- **Project-wide chat**: a separate window with a switch between **discussion** and **chat** — a
  conversation about the project as a whole, not tied to a frame. A message can be **edited**
  (deletion is intentionally absent: a conversation must not lose its history), **replied to**, and a
  **link to a frame** with a quote can be inserted — following it takes the chat to that frame.
  **Nestor** in chat answers on a button or on an `@Nestor` mention, **only reading** the project: it
  changes neither chapters nor cards. New messages arrive without a reload and show up in the bell;
  e-mails about messages are sent with the person's consent and never to the author
  (`docs/project-chat.md`)
- **Public feed** (`/feed`) and a **public story page** (`/s/{slug}`): anyone can read and rate,
  nobody but the project team can edit
- Views with de-duplication (one visitor — one view per day) and ratings 1–5 (one rating per user, an
  author cannot rate their own story); feed sorting "newest / by rating / by views"
- **Deployment administration**: the administrator decides whether new users are let in freely or
  only by request (by request by default) and reviews requests in `/admin`
- **Interface language** (0.115.0) — Russian and English: an **EN / RU** switch in the header, and
  on a phone a "More" («Ещё») menu item named after the language itself; the choice is stored in the
  browser and `<html lang>` follows it. The "shell" is translated so far: navigation and menu, sign-in,
  registration and requests, the About page, the project list and the trash, the project page tabs; the rest stays Russian — phases and volume measurement
  in `docs/ui-localization.md`
- **"About" («О проекте»)** (`/about`) — a page instead of a site footer: what the platform is, the
  license and copyright notices, source and releases, documentation in Russian and English, privacy
  (no telemetry, data stays on your server), third-party components, contacts and the **build number
  from the server** — the thing people quote in "it does not work for me". Open without signing in,
  reachable from the header (in the "More" («Ещё») menu on a phone)

## Where to read more

| Document | About |
|---|---|
| `docs/architecture.md` | data model, invariants, analysis of common defects |
| `docs/entity-links.md`, `docs/entity-types.md` | world cards: mentions, links, custom kinds |
| `docs/comments.md`, `docs/fragment-comments.md` | frame discussions and fragment notes |
| `docs/project-chat.md` | project-wide chat, Nestor in chat, notifications |
| `docs/import-export.md`, `docs/import-export-folders.md` | export and import, folder import and "into place" |
| `docs/docx-template.md` | DOCX book styling: placeholder, style map, help |
| `docs/versions.md`, `docs/realtime-editor.md` | version history and realtime editing phases |
| `docs/ai-assistant.md` | the assistant: tools, model providers, keys |
| `docs/security.md`, `docs/webauthn.md` | permissions and tokens, access keys |
| `docs/storage-compression.md`, `docs/storage-s3.md`, `docs/backups.md` | server disk space, S3, backups |
| `docs/diagnostics.md` | catalogue of live checks and diagnostic scripts |
