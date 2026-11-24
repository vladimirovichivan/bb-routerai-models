---
name: routerai-managed
description: Pick RouterAI models for the `routerai-managed` bb provider. Use when the user asks which RouterAI models are enabled, wants to enable or disable one, wants reasoning levels or ruble prices, or needs the inline OpenCode config applied.
---

# RouterAI Managed Profile

Этот плагин держит каталог RouterAI в кэше bb и отдаёт OpenCode
`OPENCODE_CONFIG_CONTENT` через ACP-мост. Пользовательский
`~/.config/opencode/opencode.json` не меняется никогда.

## Что можно делать без сети

Каталог уже в кэше, поэтому список, фильтр и сортировка ничего не запрашивают.

```bash
bb routerai-managed list            # активные модели, цены, статус
bb routerai-managed list --all      # плюс выключенные
bb routerai-managed list --json     # для разбора в коде
```

## Включить или выключить модель

```bash
bb routerai-managed enable deepseek/deepseek-v4.1-flash
bb routerai-managed disable deepseek/deepseek-v4.1-flash
```

Идентификатор — это id RouterAI (`<author>/<model>`), он же виден в выводе
`list --all`. После изменения конфиг пересобирается и провайдер
перерегистрируется автоматически. Модель, включённая первой, остаётся моделью по
умолчанию в пикере bb, пока её не выключат.

## Уровень reasoning

```bash
bb routerai-managed reasoning deepseek/deepseek-v4.1-flash high
bb routerai-managed reasoning deepseek/deepseek-v4.1-flash default
```

Допустимы только уровни, которые модель заявила (`low`, `medium`, `high`,
`default`). Если в выводе «уровни не заявлены», модель не поддерживает
`reasoning_effort`, и уровень менять не нужно.

## Обновление каталога

Единственный сетевой вызов — явный refresh. Не вызывай его без просьбы: он
ходит в RouterAI и меняет кэш.

```bash
bb routerai-managed refresh
```

Если refresh упал, плагин продолжает работать на старом кэше; дата кэша видна в
`status`.

## Применение и проверка

```bash
bb routerai-managed apply           # пересобрать и зарегистрировать провайдера
bb routerai-managed show-config     # конфиг с замаскированным ключом
bb provider models routerai-managed # что реально видит bb
```

После `apply` напомни пользователю переоткрыть пикер моделей: bb кэширует список
моделей провайдера примерно на 10 минут.

## Подтверждения инструментов

По умолчанию провайдер объявляет нативный диалект bb (`acpDialect: "opencode"`):
bb управляет разрешениями через режим треда, и в `accept-edits` спрашивает перед
командами shell, webfetch и записью вне workspace. Это штатное поведение, и
новая установка начинает с него.

Если пользователь просит убрать окна «Approval needed», включи настройку
`disableApprovalPrompts`:

```bash
bb routerai-managed approvals off     # без подтверждений bb
bb routerai-managed approvals on      # вернуть нативное поведение
```

Включённая настройка переводит декларацию на generic-диалект ACP: агент работает
по настройкам OpenCode, инструменты разрешены, переключатель режима разрешений
bb на эти треды не влияет. Настройка действует на **новые** треды — уже
открытая ACP-сессия сохраняет прежний диалект. Не меняй значение по умолчанию на
`true`: плагин не должен молча отключать защиту bb.

## Границы

- Не редактируй `~/.config/opencode/opencode.json` и не меняй чужие плагины.
- Не печатай ключ RouterAI: `show-config` его маскирует, не обходи это.
- Если конфиг больше 24 КБ, плагин откажется применяться — предложи выключить
  часть моделей, а не увеличивать лимит.
