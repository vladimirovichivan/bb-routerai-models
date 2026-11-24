// Pure refresh helpers: turning a thrown fetch error into a short Russian
// message, and describing where the stale cache came from. No I/O, so the
// failure paths can be unit-tested without a network.

/**
 * Keeps the message actionable and free of headers or credentials. The plugin
 * never logs request headers, so nothing here can leak the API key.
 */
export function describeFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return "Запрос к RouterAI отменён";
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return "Нет связи с RouterAI. Используется сохранённый каталог.";
  }
  if (/HTTP 401|HTTP 403/.test(message)) {
    return "RouterAI отклонил ключ (проверьте ключ в настройках плагина).";
  }
  if (/HTTP 429/.test(message)) {
    return "RouterAI ограничил частоту запросов. Попробуйте позже.";
  }
  const http = /HTTP (\d{3})/.exec(message);
  if (http !== null) return `RouterAI ответил HTTP ${http[1]}. Используется сохранённый каталог.`;
  return message.slice(0, 400);
}

/** Message for a failed refresh that still has a catalog to fall back on. */
export function staleCacheMessage(reason: string, fetchedAt: number, locale = "ru-RU"): string {
  return (
    `Не удалось обновить каталог: ${reason} ` +
    `Продолжаем на кэше от ${new Date(fetchedAt).toLocaleString(locale)}.`
  );
}

/** Message for a failed first refresh, when there is nothing to fall back on. */
export function emptyCacheMessage(reason: string): string {
  return `Не удалось загрузить каталог: ${reason}`;
}
