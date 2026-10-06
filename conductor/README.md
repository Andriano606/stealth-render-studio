# Stealth Render Studio — Conductor scripts

Lifecycle-скрипти для **ізольованих воркспейсів [Conductor](https://www.conductor.build)**:
кожен воркспейс має власний порт, власну БД Postgres, власні `profile.json` і `uploads/`,
а Postgres-контейнер — один спільний.

```
/home/andrii/Documents/stealth-render-studio            <- основний checkout застосунку
/home/andrii/Documents/stealth-render-studio/conductor  <- ЦЯ ТЕКА (у репо, тека conductor/)
```

Тека закомічена в репо застосунку, але Conductor викликає скрипти саме з **основного
checkout** за абсолютним шляхом (копії в worktree-воркспейсах не використовуються).
Стан `.state/` — у `conductor/.gitignore`.

## Підключення до Conductor

Conductor → Settings → репозиторій **stealth-render-studio**:

| Hook | Command |
|------|---------|
| Setup   | `bash /home/andrii/Documents/stealth-render-studio/conductor/setup.sh` |
| Run     | `bash /home/andrii/Documents/stealth-render-studio/conductor/run.sh` |
| Archive | `bash /home/andrii/Documents/stealth-render-studio/conductor/archive.sh` |

Run-script mode: **concurrent**. (`conductor.json` — лише довідка, Conductor її не читає.)

## Що робить кожен hook

- **setup.sh** (раз на воркспейс): `asdf install nodejs` з `.tool-versions` (якщо бракує),
  піднімає спільний Postgres, створює БД `stealth_dev_<slug>`, `npm ci` (+ postinstall-патч
  camoufox-js), **імпортує бандл** пресетів і сценаріїв у НОВУ БД (див. нижче), копіює
  `profile.json` з основного checkout (якщо він там є, а тут — ні), перевіряє Chrome /
  Camoufox, перевіряє що worktree git-clean.
- **run.sh** (кнопка Run): переконується, що Postgres і БД є, запускає `node server.js` на
  порту воркспейсу. INT/TERM/HUP → TERM → коректне завершення (браузер, сесії, БД).
- **archive.sh** (перед видаленням): видаляє БД воркспейсу, звільняє індекс порту.
  Спільний контейнер лишається працювати.

## Ізоляція

Застосунок читає все з ENV (`lib/config.js`), тож у worktree нічого не пишеться, крім
gitignored-шляхів:

| Що | Значення |
|----|----------|
| `PORT` | `CONDUCTOR_PORT` (інакше перший вільний від `3201 + index`) |
| `DATABASE_URL` | `postgres://stealth:stealth@127.0.0.1:5437/stealth_dev_<slug>` |
| `PROFILE_FILE` | `<worktree>/profile.json` (gitignored) |
| `UPLOAD_DIR` | `<worktree>/uploads` (gitignored) |

Таблиці створює сам застосунок при старті (`initDb`). Бінарник Camoufox (`~/.cache/camoufox`)
і системний Google Chrome — спільні для всіх.

## 📥 Автоімпорт бандла (пресети + сценарії)

Поклади файл 📤 Експорту застосунку (`stealth-bundle-*.json`) сюди:

```
/home/andrii/Documents/stealth-render-studio/conductor/.state/import-bundle.json   (gitignored)
```

і кожен НОВИЙ воркспейс одразу отримає ці пресети, сценарії та файли кроків.
`import_bundle.mjs` бере код самого воркспейсу — `initDb` (таблиці + засівання вбудованих
пресетів) і роут `POST /import` (та сама валідація й одна транзакція, що в UI) — без
запуску браузера. Стратегія конфліктів — **replace**: однойменні (зокрема вбудовані
«🧹 Clear all» / «☁️ Cloudflare» / «📋 Ashby») перезаписуються версією з бандла, однакові —
пропускаються, решта створюється. Файли кроків пишуться в `uploads/` з тим самим `fileId`.
Збій імпорту лише попереджає (воркспейс робочий, можна імпортувати руками через 📥).

Файл тримається поза git, бо містить введений у форми текст і вкладені файли (CV тощо).

## Спільна інфраструктура (docker-compose.yml)

**Postgres 17**, контейнер `stealth-cdt-postgres`, порт хоста **5437** (5432 — mysql,
5433/5436 зайняті). Логін `stealth` / `stealth`.

```bash
docker exec -it stealth-cdt-postgres psql -U stealth -l      # список БД воркспейсів
```

## Прапорці (env Conductor-а або перед ручним запуском)

- `CONDUCTOR_SKIP_DEPS=1` — без `npm ci`.
- `CONDUCTOR_SKIP_DB=1` — setup без Postgres.
- `CONDUCTOR_SEED_FROM=<ім'я воркспейсу>` — НОВУ БД заповнити копією БД іншого воркспейсу
  (сценарії, пресети).
- `CONDUCTOR_FETCH_CAMOUFOX=1` — завантажити Camoufox (~1.3 ГБ, раз на користувача), якщо немає.
- `CONDUCTOR_IMPORT_BUNDLE=<шлях>` — інший бандл замість `.state/import-bundle.json`.
- `CONDUCTOR_IMPORT_FORCE=1` — імпортувати й в УЖЕ наявну БД воркспейсу (однойменні
  сценарії/пресети, змінені у воркспейсі, буде перезаписано).
- `CONDUCTOR_SKIP_IMPORT=1` — без імпорту бандла.
- `CONDUCTOR_KEEP_DB=1` — archive не видаляє БД (щоб потім `CONDUCTOR_SEED_FROM`).

## Вимоги

- **asdf** (Node з `.tool-versions` застосунку; Ruby 3.4.8 для оркестратора — обирається
  через `ASDF_RUBY_VERSION` у `.sh`, бо глобальний Ruby тут 2.5.8).
- **Docker** + Compose, **Google Chrome**.

## Ручний запуск

```bash
cd <worktree застосунку>
CONDUCTOR_WORKSPACE_NAME=my-ws CONDUCTOR_PORT=3255 bash /home/andrii/Documents/stealth-render-studio/conductor/setup.sh
CONDUCTOR_WORKSPACE_NAME=my-ws CONDUCTOR_PORT=3255 bash /home/andrii/Documents/stealth-render-studio/conductor/run.sh
```

## Troubleshooting

- **Порт 5437 зайнятий** — змініть у `docker-compose.yml` і `PG_HOST_PORT` у `conductor_helpers.rb`.
- **Тест-гейт (pre-commit/pre-push) не працює у воркспейсах** — один раз:
  `git -C /home/andrii/Documents/stealth-render-studio config core.hooksPath .githooks`
  (setup лише нагадує, конфіг репо не змінює).
- **E2E-тести поруч із запущеним сервером** — див. CLAUDE.md застосунку
  (`TMPDIR=… UI_TMP=… UI_PORT=<не порт воркспейсу> npm run test:e2e`).
