// RouterAI Managed Profile — the plugin's page.
//
// Every interaction below is local. The only call that reaches RouterAI is the
// explicit "Обновить список моделей" button (RPC `refresh`). Filtering,
// sorting, toggling models, and changing reasoning levels never touch the
// network: they read the plugin's cache and write the selection.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { CatalogModel, PluginState, RefreshResult } from "./core/state";
import { groupModels } from "./core/sort";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const CHANGED_CHANNEL = "routerai-managed-changed";

function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPrice(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} ₽`;
}

function formatContext(value: number): string {
  if (value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function usePluginState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PluginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("state", null).then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useRealtime(CHANGED_CHANNEL, refetch);

  const run = useCallback(
    async <T,>(operation: () => Promise<T>, after: (value: T) => void = () => undefined) => {
      setBusy(true);
      try {
        const value = await operation();
        after(value);
        setError(null);
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );

  return { rpc, state, setState, error, report, busy, refetch, run };
}

function StatusBanner({ state }: { state: PluginState }) {
  const { catalog, refresh } = state;
  const tone =
    refresh.inProgress
      ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
      : refresh.lastError !== null
        ? "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300"
        : "border-border bg-card text-muted-foreground";
  let text: string;
  if (refresh.inProgress) {
    text = "Обновляется каталог моделей…";
  } else if (catalog === null) {
    text = "Список моделей ещё ни разу не загружался.";
  } else if (refresh.lastError !== null) {
    text = `Ошибка обновления: ${refresh.lastError} Работаем на кэше от ${formatTime(catalog.fetchedAt)}.`;
  } else {
    text = `Загружено ${formatTime(catalog.fetchedAt)} · ${catalog.models.length} text+tools моделей.`;
  }
  return (
    <div role="status" className={cn("rounded-lg border px-3 py-2 text-sm", tone)}>
      {text}
    </div>
  );
}

function ModelBadges({ model }: { model: CatalogModel }) {
  return (
    <>
      {model.reasoning && (
        <span
          title="Поддерживает reasoning"
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
        >
          reasoning
        </span>
      )}
      {model.input.includes("image") && (
        <span
          title="Принимает изображения на вход"
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
        >
          vision
        </span>
      )}
    </>
  );
}

function ActiveModelRow({
  model,
  level,
  onToggle,
  onReasoning,
  busy,
}: {
  model: CatalogModel;
  level: string | undefined;
  onToggle: (next: boolean) => void;
  onReasoning: (next: string) => void;
  busy: boolean;
}) {
  const hasLevels = model.levels.length > 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
      <Checkbox
        checked
        disabled={busy}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={`Выключить ${model.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2" title={model.name}>
          <span className="truncate font-medium">{model.name}</span>
          <ModelBadges model={model} />
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={model.id}>
          {model.key}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span title="Контекст">ctx {formatContext(model.context)}</span>
        <span title="Цена за 1M токенов, RUB (вход / выход)">
          {formatPrice(model.prices.input)} / {formatPrice(model.prices.output)}
        </span>
      </div>
      {hasLevels ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          reasoning
          <select
            aria-label={`Уровень reasoning для ${model.name}`}
            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
            value={level ?? "default"}
            disabled={busy}
            onChange={(event) => onReasoning(event.target.value)}
          >
            {model.levels.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ) : model.reasoning ? (
        <span className="text-xs text-muted-foreground">уровни не заявлены</span>
      ) : null}
    </li>
  );
}

function InactiveModelRow({
  model,
  onToggle,
  busy,
}: {
  model: CatalogModel;
  onToggle: (next: boolean) => void;
  busy: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-muted/20 px-4 py-2.5 text-sm text-muted-foreground">
      <Checkbox
        checked={false}
        disabled={busy}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={`Включить ${model.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium opacity-80">{model.name}</span>
          <ModelBadges model={model} />
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {model.key}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span title="Контекст">ctx {formatContext(model.context)}</span>
        <span title="Цена за 1M токенов, RUB">
          {formatPrice(model.prices.input)} / {formatPrice(model.prices.output)}
        </span>
      </div>
    </li>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-4">
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {hint === undefined ? null : <span className="ml-2 font-normal normal-case">{hint}</span>}
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </ul>
    </section>
  );
}

function RouteraiPage() {
  const { rpc, state, setState, error, busy, run } = usePluginState();
  const [filter, setFilter] = useState("");

  const grouped = useMemo(() => {
    if (state === null) return { active: [], inactive: [] };
    const visible = state.catalog?.models ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered =
      needle === ""
        ? visible
        : visible.filter(
            (model) =>
              model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
          );
    return groupModels(filtered, state.selection.activeIds);
  }, [state, filter]);

  if (state === null) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-4 md:px-5">
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {error ?? "Загрузка состояния…"}
          </p>
        </div>
      </div>
    );
  }

  const refresh = async () => {
    await run(
      () => rpc.call("refresh", null) as Promise<RefreshResult>,
      (result) => {
        setState(result);
      },
    );
  };
  const toggle = (id: string, active: boolean) =>
    run(() => rpc.call("set_active", { id, active }), setState);
  const setReasoning = (id: string, level: string) =>
    run(() => rpc.call("set_reasoning", { id, level }), setState);
  const apply = () => run(() => rpc.call("apply", null), setState);
  const setAutoRefresh = (enabled: boolean) =>
    run(() => rpc.call("set_auto_refresh", { enabled }), setState);
  const setApprovalPrompts = (disabled: boolean) =>
    run(() => rpc.call("set_disable_approval_prompts", { disabled }), setState);

  const { config } = state;
  const activeCount = state.selection.activeIds.length;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold">RouterAI Managed</h1>
            <p className="text-xs text-muted-foreground">
              Отдельный managed-профиль OpenCode. Пользовательский{" "}
              <code>opencode.json</code> не читается и не изменяется.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={state.settings.autoRefreshDaily}
                disabled={busy}
                onCheckedChange={(checked) => setAutoRefresh(checked === true)}
                aria-label="Обновлять каталог раз в сутки"
              />
              автообновление раз в сутки
            </label>
            <label
              className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
              title="Включает generic-диалект ACP: bb больше не управляет разрешениями в этих тредах, инструменты выполняются без окон «Approval needed». Действует на новые треды."
            >
              <Checkbox
                checked={state.settings.disableApprovalPrompts}
                disabled={busy}
                onCheckedChange={(checked) => setApprovalPrompts(checked === true)}
                aria-label="Не запрашивать подтверждения инструментов"
              />
              без подтверждений bb
            </label>
            <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
              <Icon name="RefreshCw" className="size-4" />
              {state.refresh.inProgress ? "Обновляется…" : "Обновить список моделей"}
            </Button>
          </div>
        </div>

        <div className="mt-3">
          <StatusBanner state={state} />
        </div>

        {state.settings.hasApiKey ? null : (
          <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Ключ RouterAI не задан. Откройте Settings → Installed plugins → RouterAI Managed Profile
            и заполните «RouterAI API key».
          </p>
        )}

        {error === null ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="text-muted-foreground">
              Конфиг:{" "}
              <span className={cn(config.tooLarge && "text-destructive")}>
                {config.bytes} / {config.maxBytes} байт
              </span>{" "}
              · моделей {config.modelCount} · провайдер{" "}
              {state.provider.registered ? (
                <span>
                  {state.provider.id} ({state.provider.modelCount} в пикере)
                </span>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">не зарегистрирован</span>
              )}
            </div>
            <Button size="sm" disabled={busy || config.tooLarge} onClick={apply}>
              <Icon name="Check" className="size-4" />
              Применить конфиг
            </Button>
          </div>
          {config.error === null ? null : (
            <p
              className={cn(
                "mt-2 text-xs",
                config.tooLarge ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {config.error}
            </p>
          )}
          {config.lastAppliedAt === null ? null : (
            <p className="mt-1 text-xs text-muted-foreground">
              Применено {formatTime(config.lastAppliedAt)} · {config.appliedModelCount} моделей ·{" "}
              {config.appliedBytes} байт. Чтобы увидеть новый набор в пикере моделей, переоткройте
              выбор модели (bb кэширует каталог провайдера).
            </p>
          )}
          {state.provider.error === null ? null : (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Провайдер bb не обновлён: {state.provider.error}
            </p>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Фильтр по названию или id (локально, без запросов)"
            aria-label="Фильтр моделей"
          />
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            активно {activeCount}
          </span>
        </div>

        {state.catalog === null ? (
          <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Каталог пуст. Нажмите «Обновить список моделей» — это единственный запрос к RouterAI.
          </p>
        ) : (
          <>
            {state.missingIds.length > 0 && (
              <Section
                title="Модель больше не доступна"
                hint="id сохранён в выборе, но исчез из каталога"
              >
                {state.missingIds.map((id) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-amber-700 dark:text-amber-300">
                      {id}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => toggle(id, false)}
                    >
                      Убрать из выбора
                    </Button>
                  </li>
                ))}
              </Section>
            )}

            <Section title="Активные" hint="вверху списка">
              {grouped.active.length === 0 ? (
                <li className="px-4 py-4 text-sm text-muted-foreground">
                  Ничего не выбрано. Отметьте модели ниже.
                </li>
              ) : (
                grouped.active.map((model) => (
                  <ActiveModelRow
                    key={model.id}
                    model={model}
                    level={state.selection.reasoning[model.id]}
                    busy={busy}
                    onToggle={(next) => toggle(model.id, next)}
                    onReasoning={(level) => setReasoning(model.id, level)}
                  />
                ))
              )}
            </Section>

            <Section
              title="Выключенные"
              hint={`${grouped.inactive.length} моделей · цены справочно, ₽ за 1M токенов`}
            >
              {grouped.inactive.length === 0 ? (
                <li className="px-4 py-4 text-sm text-muted-foreground">
                  {filter.trim() === "" ? "Все модели из каталога включены." : "Ничего не найдено."}
                </li>
              ) : (
                grouped.inactive.map((model) => (
                  <InactiveModelRow
                    key={model.id}
                    model={model}
                    busy={busy}
                    onToggle={(next) => toggle(model.id, next)}
                  />
                ))
              )}
            </Section>
          </>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Сортировка и фильтр выполняются локально по кэшу. Изменение выбора сохраняется по id
          модели и переживает обновление каталога и перезапуск bb.
        </p>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "routerai-managed",
    title: "RouterAI Managed",
    icon: "AiContentGenerator01",
    path: "routerai-managed",
    component: RouteraiPage,
  });
});
