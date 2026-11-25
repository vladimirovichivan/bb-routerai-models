# Публикация плагина

Две независимые вещи:

1. **Публичный Git-репозиторий** — оттуда bb ставит плагин напрямую
   (`git:`-источник) и оттуда его читает маркетплейс.
2. **Запись в каталоге BB Community** — meta-данные (описание, иконка,
   скриншоты, источник) в репозитории
   [get-bb/marketplace](https://github.com/get-bb/marketplace). Код там не
   лежит: маркетплейс только ссылается на Git-источник.

## 0. Что должно быть в репозитории до публикации

- `package.json` с `name`, `version`, `license`, `repository`, `engines`.
- `README.md` (русский, основной) и `README.en.md` (английский), `LICENSE`,
  `CHANGELOG.md`.
- `PLUGIN_OVERVIEW.md` — длинное описание для страницы в магазине
  (≤ 4000 символов, только `##`-заголовки, ссылки только абсолютные `https`,
  без HTML, картинок и таблиц).
- `.gitignore` без `dist/`, `node_modules/`, `.env`, логов.
- Зелёные `node --test tests`, `npx tsc --noEmit`, `bb plugin build`.
- Ни ключа, ни личных путей, ни имён машин, ни id проектов.

Проверить историю перед публикацией:

```bash
git log -p | rg -i 'api[_-]?key|bearer|secret|token'
rg -i 'D:\\|C:\\Users|@[a-z0-9.-]+\.(ru|com)' --glob '!package-lock.json'
```

## 1. Репозиторий на GitHub

Репозиторий называется `bb-routerai-models`, а имя npm-пакета остаётся
`bb-plugin-routerai-managed-profile`: из него bb выводит id плагина
`routerai-managed-profile` (снимает префикс `bb-plugin-`). Id менять нельзя — он
уже сохранён в тредах и в хранилище. Файл записи в маркетплейсе должен
называться по id.

```bash
git remote add origin git@github.com:<owner>/bb-routerai-models.git
git push -u origin main
```

Релиз — аннотированный тег, он же источник для bb:

```bash
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin v0.0.2
```

Проверить, что тег виден:

```bash
git ls-remote --tags https://github.com/<owner>/bb-routerai-models.git
```

Установка у пользователя:

```bash
bb plugin install git:https://github.com/<owner>/bb-routerai-models@^0.0.2
```

Осторожно с диапазонами до 1.0.0: `^0.0.2` разрешает только патчи `0.0.x`.
Для магазина удобнее `">=0.0.2 <1.0.0"` — тогда новые `0.0.x` и `0.1.x`
подхватываются без нового PR.

CI включён: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) запускает
`npm ci`, `node --test tests` и `npx tsc --noEmit` на push в `main` и на pull
request. Если у `gh` нет scope `workflow`, он не сможет запушить файл в
`.github/workflows/` — добавьте scope командой `gh auth refresh -s workflow`.

## 2. Запись в каталоге BB Community

Контракт живёт в [get-bb/marketplace](https://github.com/get-bb/marketplace);
перед PR прочитайте его `README.md` и
`schema/marketplace-v2.schema.json` — они могут меняться независимо от bb.

Порядок:

1. Форк `get-bb/marketplace`, ветка от `main`.
2. `entries/routerai-managed-profile.json` (имя файла = `id`).
3. Иконка в `icons/`: либо имя иконки bb-хоста (`"icon": "Sparkles"`), либо
   файл `icons/<plugin-id>-<sha256[0:8]>.(svg|png|webp)`, ≤ 256 КБ.
4. Скриншоты в `screenshots/routerai-managed-profile/`: PNG/JPEG/WebP,
   ≥ 1200 px по ширине, ≤ 2 МиБ, до шести файлов, с реальным содержимым.
5. `overview/routerai-managed-profile.md` — копия `PLUGIN_OVERVIEW.md`.
6. `npm ci && npm run build` в маркетплейсе (валидирует запись, иконку,
   скриншоты и овервью).
7. PR из аккаунта, указанного в `author.github`.

Запись:

```json
{
  "id": "routerai-managed-profile",
  "displayName": "RouterAI Managed Profile",
  "description": "Picks RouterAI models for bb and runs threads on them through OpenCode. The sidebar page filters the whole catalog, toggles models and sets a reasoning level per model, with prices in rubles and the size of the generated config. Threads use an inline OpenCode config, so your own opencode.json stays untouched. Needs a RouterAI account and key, and OpenCode on the host.",
  "icon": "Sparkles",
  "tags": [
    "routerai",
    "provider",
    "models",
    "reasoning",
    "opencode",
    "acp",
    "rubles",
    "model-picker"
  ],
  "author": {
    "name": "Ivan",
    "github": "vladimirovichivan"
  },
  "category": "agents-and-providers",
  "secondaryCategories": ["token-usage-and-limits"],
  "screenshots": [
    "./screenshots/routerai-managed-profile/panel.png"
  ],
  "overview": "./overview/routerai-managed-profile.md",
  "source": {
    "git": {
      "url": "https://github.com/vladimirovichivan/bb-routerai-models.git",
      "range": ">=0.0.2 <1.0.0"
    }
  }
}
```

`publishedAt` не пишется — его выставляет сборка. `version` и `engines` в
записи отсутствуют: совместимость берётся из манифеста плагина.

После мержа запись появляется в
`https://getbb.app/marketplace/v2/marketplace.json`, и установка выглядит так:

```bash
bb plugin install routerai-managed-profile@bb-community
```

## 3. Что дальше

- Новый совместимый релиз внутри `>=0.0.2 <1.0.0` не требует нового PR:
  достаточно тега `v0.0.x` в репозитории.
- Новый PR нужен при смене источника, имени, описания, овервью, категории,
  иконки или скриншотов, а также при выходе за диапазон (например `1.0.0`).
- bb не устанавливает плагины автоматически: каталог только показывает запись,
  установку и обновление запускает пользователь.
