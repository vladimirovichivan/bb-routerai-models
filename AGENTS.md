# RouterAI Managed Profile — документация проекта для агентов

Этот файл — точка входа для любой новой сессии. Прочитай его целиком перед
первым изменением кода. Пользовательская документация (установка, команды,
spike-отчёты) лежит в `README.md`; здесь — устройство, инварианты, грабли и
порядок работы.

---

## 1. Что это

bb-плагин `routerai-managed-profile`, который даёт в bb отдельного
ACP-провайдера `routerai-managed` — «managed-профиль OpenCode для RouterAI»:

- кэширует каталог моделей RouterAI (`GET https://routerai.ru/api/v1/models`);
- даёт страницу в боковой панели и CLI `bb routerai-managed`, где пользователь
  выбирает модели и уровень reasoning, видит цены в рублях;
- собирает из выбора inline-конфиг OpenCode (`OPENCODE_CONFIG_CONTENT`) и
  отдаёт его агенту через штатный ACP-мост bb (`opencode acp`);
- **никогда** не читает и не изменяет `~/.config/opencode/opencode.json`.

Вариант реализации — A2 из исходного задания: ключ лежит прямо в переменной
окружения треда, профили не пишутся в чужие плагины и файлы.

Соседствует с официальным плагином `routerai@0.2.0` (провайдер `routerai`,
команда `bb routerai`): разные id провайдеров, разные имена команд, разные
ключи в хранилище. Оба могут работать одновременно.

---

## 2. Состояние проекта

| Что | Значение |
| --- | --- |
| Репозиторий | корень этого репозитория, файлы в корне (одно-плагинный репозиторий) |
| Версия | `0.0.2` (`package.json`) |
| Совместимость | bb `>=0.50`, plugin SDK `>=0.6.157`, OpenCode 2.x |
| Тесты | 48, `node --test tests` — зелёные; `npx tsc --noEmit` — чисто |
| Лицензия | MIT (`LICENSE`) |

Выбор моделей, ключ и кэш каталога живут только в локальной установке bb и в
репозиторий не попадают. Ниже — типичный размер конфига на 5 моделях: около
2,3 КБ при лимите 24 КБ.

Проверить состояние:

```powershell
bb routerai-managed status
bb provider models routerai-managed
node tools/acp-probe.mjs
```

---

## 3. Окружение и установка

- Менеджер пакетов: npm 11, Node 26 (`node --test` понимает `.ts` напрямую).
- Зависимости ставятся `npm ci` (lock-файл в репо).
- Сборка: `bb plugin build` → `dist/` (в git не попадает).
- Установка: `bb plugin install . --yes` (без `--yes` откажется).
- Перезагрузка после сборки: `bb plugin reload routerai-managed-profile`.
- Ключ: настройка плагина `apiKey` (секрет) или переменные окружения
  `ROUTERAI_API_KEY` / `ROUTERAI_WINDOWS_API_KEY`. Значение нигде не логируется.
- Логи: `%USERPROFILE%\.bb\logs\server.N.log`, строки плагина помечены
  `[plugin:routerai-managed-profile]`.

При переустановке с другого пути bb переносит настройки, секреты и расписания
(они привязаны к id плагина `routerai-managed-profile`).

---

## 4. Инварианты — что нельзя ломать

1. **Пользовательский `~/.config/opencode/opencode.json` не трогать.** Тест
   `tests/user-config-unchanged.test.ts` сверяет SHA-256 до и после генерации
   конфига.
2. **Сеть — только по явному refresh.** Ни открытие страницы, ни фильтр, ни
   сортировка, ни переключение модели, ни смена reasoning не ходят в RouterAI.
   Разрешены: RPC `refresh`, кнопка «Обновить список моделей», CLI
   `bb routerai-managed refresh`, фоновое обновление раз в сутки (по умолчанию
   выключено). Каждый refresh пишет в лог ровно одну строку
   `RouterAI: запрос каталога моделей (…)` — по ней считаются запросы в приёмке.
3. **Ключ не печатать.** `show-config` маскирует его как `***`; в RPC и UI
   уходит только `hasApiKey`/`apiKeySource`. Не добавляй ключ в сообщения
   об ошибках, reason-строки и тесты.
4. **`providerId = routerai-managed` и имя CLI `routerai-managed` неизменны.**
   id провайдера сохраняется в тредах bb; переименование сломает существующие
   треды. Команда названа так, потому что `bb routerai` уже занята официальным
   плагином.
5. **Провайдер объявляется только через `bb.providers.register`.** Никаких
   записей в настройки других плагинов и никакой зависимости от `provider-acp`.
   `host.ts` обязан реэкспортировать `experimental_acpProviderBridge` — без
   этого bb не поднимет ACP-мост.
6. **`modalities.input` — только значения из схемы OpenCode**
   (`text | audio | image | video | pdf`). Одно постороннее значение делает
   невалидным весь конфиг, и провайдер отвечает `CatalogNotReady` (см. §10).
7. **Выбор пользователя неприкосновенен.** Отладка не должна оставлять
   изменённый набор моделей, снятые reasoning-уровни или другой ключ. Если для
   проверки пришлось включить модели — верни ровно исходный набор и проверь
   `bb routerai-managed status`.
8. **Лимит inline-конфига 24 КБ.** При превышении провайдер продолжает работу
   на последнем конфиге, который влез (`lastRegisteredConfig`), а UI/CLI
   показывают ошибку. Не «поднимай» лимит — Windows ограничивает блок
   окружения процесса 32767 символами.
9. **Детерминизм и отсутствие сети в тестах.** `core/*` — чистые функции без
   I/O; всё сетевое и storage-зависимое живёт в `server.ts`.
10. **Порядок выбора = порядок включения.** `toggledActiveIds` (RPC и CLI)
    сохраняет его, поэтому default-модель не «прыгает» при добавлении новых.
11. **Подтверждения инструментов — только по явному выбору пользователя.**
    Нативная настройка bb (`acpDialect: "opencode"`) — значение по умолчанию:
    bb управляет разрешениями через режим треда, и плагин не должен молча это
    отключать. Настройка `disableApprovalPrompts` (default **false**) переводит
    декларацию на generic-диалект `acp` и добавляет `ACP_LAUNCH_ENV`
    (`OPENCODE_CLIENT=acp`, `OPENCODE_ENABLE_QUESTION_TOOL=false`,
    `OPENCODE_PERMISSION` со всеми `allow`). Тогда подтверждения не
    запрашиваются, но и переключатель режима разрешений bb на эти треды больше
    не действует. Не меняй значение по умолчанию на `true`: новая установка
    обязана начинать с нативного поведения bb.

---

## 5. Архитектура и поток данных

```
                    RouterAI /api/v1/models  (только явный refresh)
                                 │
                                 ▼
core/models.ts   normalizeCatalog()  →  CatalogModel[]  (text→text + tools,
                                 │                        цены ₽/1M, уровни)
                                 ▼
                    bb.storage.kv "catalog"   ◄──── ETag/Last-Modified (304)
                                 │
   выбор пользователя           ▼
   (UI / CLI / RPC)  ──►  kv "selection"  { activeIds[], reasoning{} }
                                 │
                                 ▼
core/config.ts   buildManagedConfig()  →  OPENCODE_CONFIG_CONTENT (JSON)
                                 │               ├─ enabled_providers: [routerai-managed]
                                 │               ├─ provider.npm: @ai-sdk/openai-compatible
                                 │               ├─ options.baseURL/apiKey
                                 │               └─ models{}: limit, cost, capabilities,
                                 │                          modalities, options.reasoningEffort
                                 ▼
core/provider.ts buildProviderDeclaration()  →  bb.providers.register()
                                 │                  experimental_bridgeOptions.acpLaunchSpec
                                 │                  = opencode acp + env OPENCODE_CONFIG_CONTENT
                                 ▼
              bb ACP-мост (host.ts → experimental_acpProviderBridge)
                                 │  + experimental_contributeEnv (свежий конфиг
                                 │    на каждый запуск и на опрос моделей)
                                 ▼
                    opencode acp  →  session/new → список моделей для пикера
```

Ключевые механизмы:

- **Регистрация провайдера идемпотентна.** `syncProviderRegistration()`
  сравнивает `providerSignature()` (JSON декларации). Совпало — регистрация не
  пересоздаётся, пикер не переопрашивается.
- **Два канала доставки конфига.** `acpLaunchSpec.env` в декларации (для
  запуска агента) и `experimental_contributeEnv` (для опроса моделей и для
  тредов, где конфиг изменился после регистрации). Ключ не попадает в
  сохранённые настройки провайдера, потому что значение вычисляется на лету.
- **Сборка конфига никогда не бросает наружу.** Даже пустой каталог даёт
  валидный провайдер с нулём моделей — так пикер не наполняется моделями
  самого OpenCode.
- **`applyNow()` сериализован** через `applyChain`, чтобы быстрые переключения
  не гонялись за регистрацией.
- **Realtime.** После любого изменения публикуется `routerai-managed-changed`;
  страница подписана через `useRealtime` и перечитывает состояние RPC `state`.

---

## 6. Карта файлов

| Путь | Назначение |
| --- | --- |
| `package.json` | манифест bb: `server`, `host`, `app`, `experimental_providers` (`kind: agent`, `id: routerai-managed`) |
| `server.ts` | вся серверная часть: настройки, KV, refresh, регистрация провайдера, `contributeEnv`, RPC, CLI, фоновый сервис, dispose |
| `host.ts` | реэкспорт `experimental_acpProviderBridge` + пустой host-entry |
| `app.tsx` | страница в боковой панели: статус, размер конфига, кнопка apply, фильтр, списки активных/выключенных; у активной модели — название, ключ провайдера, ползунок reasoning и цены справа |
| `core/models.ts` | тип `CatalogModel`, `normalizeCatalog`, фильтр text→text+tools, цены ₽/1M, `modelKey`, уровни reasoning, `toggledActiveIds` |
| `core/config.ts` | `buildManagedConfig`, `MAX_CONFIG_BYTES = 24 KiB`, `MAX_OUTPUT_TOKENS = 32 000`, маппинг модальностей, `redactConfig`, `ConfigTooLargeError` |
| `core/provider.ts` | декларация провайдера (`acpDialect` — нативный `opencode` по умолчанию или generic `acp` при `disableApprovalPrompts`; `fork: tip`, `permissionModes`, `reasoningLevels`), `ACP_LAUNCH_ENV`, `acpCommand`, `providerSignature` |
| `core/sort.ts` | группировка активных/выключенных по имени, `missingIds`, `sanitizeReasoning` |
| `core/refresh.ts` | тексты ошибок refresh (сеть, 401/403, 429, прочие HTTP) и сообщения о работе на кэше |
| `core/state.ts` | wire-типы RPC и страницы (без рантайм-импортов) |
| `PLUGIN_OVERVIEW.md` | длинное описание для страницы в маркетплейсе (≤ 4000 символов) |
| `docs/PUBLISHING.md` | как выпустить релиз и открыть PR в `get-bb/marketplace` |
| `.github/workflows/ci.yml` | GitHub Actions: `npm ci`, тесты, `tsc --noEmit` |
| `tests/*.test.ts` | 48 тестов: каталог, конфиг, провайдер, refresh-сообщения, сортировка, неизменность пользовательского конфига |
| `skills/routerai-managed/SKILL.md` | скилл для агентов bb (как включать модели, обновлять каталог, применять конфиг) |
| `tools/acp-probe.mjs` | dev-утилита: прогнать конфиг через `opencode acp` и увидеть, какие модели реально дошли до агента |
| `README.md` | пользовательская документация, установка, команды, spike A–D |
| `AGENTS.md` | этот файл |

Компоненты `components/ui/*`, `lib/*`, `hooks/*` — стандартный UI-кит из
шаблона bb-плагина; менять их без нужды не стоит.

---

## 7. Хранилище, настройки, RPC, CLI

**KV плагина (`bb.storage.kv`):**

| Ключ | Содержимое |
| --- | --- |
| `catalog` | `{ fetchedAt, etag, lastModified, models[], rawCount }` |
| `selection` | `{ activeIds[], reasoning{id→level}, updatedAt }` |
| `apply` | `{ lastAppliedAt, appliedModelCount, appliedBytes }` |
| `refresh` | `{ lastAttemptAt, lastError, lastErrorAt }` |

**Настройки (схема settings):** `apiKey` (secret), `autoRefreshDaily` (bool,
default false), `opencodeCommand` (строка, пусто = `opencode` из PATH),
`disableApprovalPrompts` (bool, default false — включает generic-диалект ACP и
снимает подтверждения инструментов bb).

**RPC:** `state`, `refresh`, `set_active({id, active})`,
`set_reasoning({id, level})`, `apply`, `set_auto_refresh({enabled})`,
`set_disable_approval_prompts({disabled})`.
Контракт описан zod-схемами в `server.ts` и типизирован в `core/state.ts`.

**CLI:**

```
bb routerai-managed refresh
bb routerai-managed list [--all]
bb routerai-managed enable <model-id>
bb routerai-managed disable <model-id>
bb routerai-managed reasoning <model-id> <low|medium|high|default>
bb routerai-managed apply
bb routerai-managed approvals <on|off>
bb routerai-managed status
bb routerai-managed show-config
```

`--json` принимает любая команда. `<model-id>` — это id RouterAI вида
`vendor/model`.

**Фоновый сервис** (`bb.background.service("routerai-managed")`) просыпается
раз в час; если `autoRefreshDaily` включён и кэшу больше 24 часов — вызывает
`refreshCatalog()`.

---

## 8. Как bb запускает агента (важно понимать)

1. bb читает декларацию провайдера, видит `family: "acp"` и launch spec
   `opencode acp` с `env.OPENCODE_CONFIG_CONTENT`.
2. Для списка моделей bb запускает агент и делает `initialize` → `session/new`;
   OpenCode возвращает `configOptions[0]` (`id: model`) со списком моделей из
   конфига, `configOptions[1]` (`effort`) с уровнями reasoning.
3. При старте треда bb поднимает тот же агент с тем же env; выбранная в пикере
   модель приходит в `session/prompt` как `routerai-managed/<key>`.
4. bb кэширует список моделей провайдера примерно на 10 минут — после `apply`
   пользователю нужно переоткрыть пикер.

Проверено: при пустом/невалидном конфиге OpenCode отвечает
`-32603 Internal error: No models are available` с
`{"errorName":"CatalogNotReady"}` — именно так выглядит «провайдер без моделей».

---

## 9. Команды разработки и проверки

```powershell
npm ci                      # зависимости (один раз / после смены lock)
node --test tests           # 48 тестов, без сети
npx tsc --noEmit            # типы
bb plugin build             # dist/
bb plugin reload routerai-managed-profile
bb routerai-managed status
bb provider models routerai-managed
node tools/acp-probe.mjs    # что реально видит opencode acp
```

Сквозная проверка треда (не забыть удалить тред):

```powershell
bb thread spawn --project <project-id> --provider routerai-managed `
  --model 'routerai-managed/<provider-key>' --reasoning-level high `
  --title 'smoke' --prompt 'Reply with one short sentence.' --json
bb thread wait <thread-id> --status idle
bb thread log <thread-id>
bb thread delete <thread-id> --yes
```

`--model` требует префикс `routerai-managed/`; ключ — это `key` из
`bb provider models` (слаг), а не id RouterAI.

Переустановка после смены пути или манифеста:

```powershell
bb plugin install . --yes      # сохраняет настройки/секреты/расписания
```

---

## 10. Диагностика: симптомы и причины

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `bb provider models routerai-managed` → `CatalogNotReady`, пикер пуст | OpenCode отверг весь конфиг: невалидное значение (исторически — `modalities: "file"`), битый JSON, конфиг > 24 КБ | `node tools/acp-probe.mjs` покажет ошибку; проверить `show-config`, провалидировать значения по схеме OpenCode |
| Провайдер зарегистрирован, но моделей меньше, чем выбрано | Модель исчезла из каталога (`missingIds` в статусе) | `bb routerai-managed refresh`, затем убрать/перевыбрать модель |
| После `apply` пикер показывает старый набор | bb кэширует каталог провайдера ~10 мин | переоткрыть пикер; в UI об этом есть подсказка |
| «Слишком много активных моделей… N байт при лимите 24576» | выбор не влезает в переменную окружения | отключить часть моделей; провайдер пока работает на последнем удачном конфиге |
| `refresh` падает, но всё работает | сеть/ключ/429; плагин остался на кэше | смотреть `bb routerai-managed status` (последняя ошибка и дата кэша) |
| `opencode models` показывает не то, что в конфиге | фоновый сервис OpenCode игнорирует `OPENCODE_CONFIG_CONTENT` | проверять через `opencode models --standalone` или `node tools/acp-probe.mjs` |
| Тред падает `model not found: <key>` | в `--model` нет префикса провайдера | `--model 'routerai-managed/<key>'` |
| Reasoning не применяется | модель не заявляет `reasoning_effort` (`levels: []`) | выбрать другую модель; уровни берутся только из каталога |
| В треде `routerai-managed` постоянно всплывают окна «Approval needed», даже при Full access | bb управляет разрешениями, потому что провайдер объявлен с нативным диалектом `acpDialect: "opencode"` (это значение по умолчанию); в уже созданном треде смена режима на Full access не переписывает внедрённые правила | включить `bb routerai-managed approvals off` (настройка `disableApprovalPrompts`) и открыть новый тред; проверить `git log -p core/provider.ts` |

Счётчик сетевых запросов:

```powershell
$f = (Get-ChildItem "$env:USERPROFILE\.bb\logs\server*.log" |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
(Select-String -Path $f -Pattern "RouterAI: " -SimpleMatch).Count
```

---

## 11. Подводные камни платформы (проверено на практике)

- **PowerShell + bb + ssh-подобные команды.** Двойные кавычки внутри
  `cmd /c "…"` ломаются: `git commit -m "…"` через `cmd /c` распадается на
  pathspec-и. Надёжно — вызывать бинарь напрямую из PowerShell
  (`& git commit -m '…'`) или использовать одинарные кавычки.
- **`Select-Object -First N` обрывает пайплайн** и даёт код возврата 1 —
  не принимай это за ошибку команды.
- **Кириллица в консоли** отображается как mojibake (`������`); искать в логах
  нужно ASCII-подстроки (`RouterAI: `), а не русский текст.
- **`bb plugin rpc call`** понимает только `--input-file <path>` (флага
  `--input` нет). JSON-файл удобно писать в ASCII.
- **`bb thread delete`** требует `--yes` в неинтерактивной сессии.
- **`bb thread spawn`** не принимает позиционные аргументы — только флаги.
- **Каталог RouterAI отдаёт BOM**, если сохранять ответ через
  `Invoke-WebRequest`; при чтении снимать `\uFEFF`.
- **RouterAI не проверяет ключ на `/models`**: неверный Bearer тоже получает
  200, поэтому ветки 401/403 нельзя воспроизвести на живом API — только
  юнит-тестами `core/refresh.ts`.
- **`opencode acp --standalone` не существует** (ACP и так поднимает свой
  сервер); `--standalone` есть у `opencode models`.
- **`OPENCODE_CONFIG_CONTENT` — одна переменная**: на Windows блок окружения
  процесса ограничен 32767 символами, отсюда лимит 24 КБ.
- **`acpDialect: "opencode"` включает принудительные разрешения bb.** Для этого
  диалекта ACP-мост патчит сессию OpenCode (`mergeOpenCodePermissionRules` в
  `provider-acp/dist/host.js`): режим `accept-edits` превращается в `ask` для
  `edit`/`shell`/`webfetch`/`external_directory` на ресурсе `*`, и bb выдаёт
  правила, которые затирают конфиговые `permission`/`permissions`. Смена режима
  на Full access помогает только новым тредам: в уже созданном треде сессия
  OpenCode продолжает работать со старыми правилами. Generic-диалект `acp`
  (`Us = {id: "acp"}`) таких правил не добавляет — именно так ведёт себя
  вручную зарегистрированный `opencode acp`. Плагин включает его только по
  настройке `disableApprovalPrompts`.
- **Старые треды живут по тому диалекту, с которым стартовали.** Правка
  декларации не меняет уже запущенную ACP-сессию: чтобы увидеть новые правила,
  нужен новый тред (или перезапуск агента в треде).

---

## 12. Границы и известные ограничения

- Только text→text модели с `tools`; медиа, embeddings, rerank и
  image-output отбрасываются.
- Лимит вывода RouterAI не публикует: в конфиг пишется `min(32 000, context)`.
- Цены — только из `pricing` с единицами `token`, в рубли за 1M, 4 знака;
  `cache_read`/`cache_write` при отсутствии берутся по цене входа (как в
  официальном плагине).
- `ETag`/`Last-Modified` поддерживаются, но RouterAI сейчас их не присылает.
- Ключ живёт в окружении треда (требование A2). Альтернатива на будущее —
  `options.apiKey: { file: … }` с файлом `0600`, как у официального плагина.
- Нет учёта расходов и проксирования трафика (`maintenance.usage: false`).
- Нет профилей на проект: набор моделей один на установку bb.
- `opencodeCommand` — единственное место, где допускается абсолютный путь;
  по умолчанию всегда просто `opencode`.

---

## 13. Направления развития

Приоритет сверху вниз (по полезности и риску):

1. **Вынести логику `server.ts` в тестируемые функции.** Сейчас CLI/RPC-ветки
   (порядок выбора, обработка missing-моделей, лимит) проверяются только
   вручную; чистые хелперы в `core/` + тесты уменьшат регрессии.
2. **Предвалидация выбора.** Считать байты до сохранения и отказывать в
   `enable`, если конфиг выйдет за лимит (сейчас модель включается, а ошибка
   появляется после apply). Плюс подсказка «сколько моделей ещё влезет».
3. **Валидация сгенерированного конфига по схеме OpenCode** в тестах
   (например, через `ajv` и сохранённую копию `config.json`-схемы), чтобы
   ловить такие баги, как `modalities: "file"`, до ручной проверки.
4. **Устойчивость каталога.** Логировать/показывать, сколько записей отброшено
   и почему (не text, нет tools, нет цены); при появлении новых модальностей
   или полей — маппинг и тест.
5. **Ретраи и таймауты refresh** (сейчас один запрос без ретраев; 429 — просто
   сообщение), уважение `Retry-After`.
6. **Файл с ключом вместо env** (опция «усиленный режим»): `options.apiKey:
   { file: … }`, файл `0600` в data-каталоге хоста. Оставить inline по
   умолчанию, как требует A2.
7. **Группировка и поиск в UI** по вендору, показ контекста/модальностей,
   «выбрать всё из вендора».
8. **Провайдерская модель по умолчанию** — явная настройка вместо «первая
   включённая» (например, `defaultModel` в settings → порядок `activeIds`).
9. **Учёт расходов** через usage-хуки bb (`maintenance.usage: true`) либо
   отображение расчётной цены за типичный тред.
10. **Публикация** как отдельного плагина (git-источник), если появится
    необходимость ставить на другие машины.

---

## 14. Правила работы агента в этом репозитории

1. Сначала прочитать `AGENTS.md` (этот файл) и `README.md`.
2. Перед изменениями — `git status`; рабочее дерево должно быть чистым, иначе
   уточнить у пользователя происхождение правок.
3. Менять только то, что нужно для задачи; не переформатировать чужие файлы и
   не трогать `components/ui/*` без причины.
4. Соблюдать инварианты §4. Особое внимание: не менять пользовательский
   `opencode.json`, не сбрасывать выбор моделей и уровни reasoning, не
   печатать ключ.
5. После правок обязательно: `node --test tests`, `npx tsc --noEmit`,
   `bb plugin build`, `bb plugin reload routerai-managed-profile`, затем
   `bb routerai-managed status` и `node tools/acp-probe.mjs`.
6. Если для проверки пришлось менять выбор — восстановить исходный набор и
   убедиться, что `status` совпадает с исходным.
7. Коммиты — маленькие и осмысленные, на русском или английском, но
   единообразно; не коммитить `dist/`, `node_modules/`, ключи и временные
   файлы.
8. Документацию обновлять вместе с кодом: `README.md` — для пользователя,
   `AGENTS.md` — для агентов, `skills/routerai-managed/SKILL.md` — для скилла.
9. Заметил новую платформенную грабли — допиши в §11, заметил новое решение —
   в §15.

---

## 15. История решений (кратко)

- **2026-11-24. Архитектура A2.** Провайдер через `bb.providers.register` +
  `experimental_bridgeOptions.acpLaunchSpec`, `host.ts` реэкспортирует
  `experimental_acpProviderBridge`. Официальный плагин RouterAI использует тот
  же механизм; мы не зависим от `provider-acp` и не пишем в чужие настройки.
- **2026-11-24. Сосуществование с `routerai@0.2.0`.** Команда названа
  `routerai-managed`, id провайдера — `routerai-managed`, ключи хранилища
  уникальны.
- **2026-11-24. `contributeEnv` для `threadId === null`.** Возврат `[]` при
  опросе моделей оказался ненадёжным — bb иногда не видел список. Теперь конфиг
  отдаётся в обоих случаях; при превышении лимита — последний рабочий.
- **2026-11-24. `CatalogNotReady` из-за `modalities: "file"`.** Один
  посторонний модальти-токен ломал весь конфиг (127 записей каталога).
  Исправлено маппингом `file → pdf` и фильтрацией по перечислению OpenCode
  (`core/config.ts`), регрессионный тест — в `tests/config.test.ts`.
- **2026-11-24. Порядок выбора = порядок включения.** `toggledActiveIds`
  (ранее порядок пересобирался по алфавиту каталога, из-за чего default-модель
  незаметно менялась). Тест — в `tests/catalog.test.ts`.
- **2026-11-24. Публичный репозиторий.** Источник истины — этот репозиторий;
  личные пути, имена машин, id проектов и снимок выбора моделей из документации
  удалены, добавлены `LICENSE`, `PLUGIN_OVERVIEW.md`, CI.
- **2026-11-24. Переключатель подтверждений (`disableApprovalPrompts`).** С
  `acpDialect: "opencode"` ACP-мост bb применял к OpenCode свой режим
  разрешений: в `accept-edits` каждый shell-вызов, webfetch и запись вне
  workspace требовали подтверждения, а в уже открытом треде смена режима на
  Full access не помогала (сессия сохраняла старые правила). Сначала generic-
  диалект был объявлен безусловно, но это молча отключало нативную защиту bb,
  поэтому теперь им управляет настройка (default **false** — нативное
  поведение). При включении декларация переходит на `acpDialect: "acp"`, а
  `OPENCODE_CLIENT=acp`, `OPENCODE_ENABLE_QUESTION_TOOL=false` и allow-all
  `OPENCODE_PERMISSION` отдаёт сам плагин (`ACP_LAUNCH_ENV`). Проверено обоими
  режимами на тредах с `accept-edits`: с настройкой `bb thread interactions
  list` → `[]`, без неё появляется `approval`; после теста настройка возвращена
  во включённое состояние. Тесты — `tests/provider.test.ts`.

---

## 16. Передача проекта в новую сессию

Мини-чеклист для агента, который видит проект впервые:

1. Прочитать `AGENTS.md` и `README.md`.
2. `git status` — понять, есть ли незакоммиченные правки.
3. `bb plugin list | findstr routerai` — убедиться, что плагин установлен из
   этого репозитория и запущен.
4. `bb routerai-managed status` и `bb provider models routerai-managed` —
   зафиксировать исходное состояние (каталог, выбор, конфиг, провайдер).
5. `node --test tests`, `npx tsc --noEmit` — базовая линия зелёная.
6. Только после этого менять код; проверять по §9; не забывать §14.
