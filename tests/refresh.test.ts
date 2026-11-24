import assert from "node:assert/strict";
import test from "node:test";
import { describeFetchError, emptyCacheMessage, staleCacheMessage } from "../core/refresh.ts";

test("a network failure is reported as stale-cache use, not as a stack trace", () => {
  const message = describeFetchError(new TypeError("fetch failed"));
  assert.match(message, /Нет связи с RouterAI/);
  assert.match(message, /сохранённый каталог/);
});

test("socket errors map to the same offline message", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    assert.match(describeFetchError(new Error(`connect ${code} 1.2.3.4`)), /Нет связи/);
  }
});

test("an aborted refresh says so instead of blaming the network", () => {
  assert.match(describeFetchError(new Error("The operation was aborted")), /отменён/);
});

test("auth and rate-limit responses get their own advice", () => {
  assert.match(describeFetchError(new Error("RouterAI вернул HTTP 401 Unauthorized")), /отклонил ключ/);
  assert.match(describeFetchError(new Error("RouterAI вернул HTTP 403 Forbidden")), /отклонил ключ/);
  assert.match(describeFetchError(new Error("RouterAI вернул HTTP 429 Too Many Requests")), /частоту/);
});

test("other HTTP statuses keep the cache and name the code", () => {
  const message = describeFetchError(new Error("RouterAI вернул HTTP 502 Bad Gateway"));
  assert.match(message, /HTTP 502/);
  assert.match(message, /сохранённый каталог/);
});

test("unexpected errors are shortened, never dropped", () => {
  const message = describeFetchError(new Error("x".repeat(900)));
  assert.equal(message.length, 400);
});

test("a failed refresh with a cache names the cache date", () => {
  const at = new Date("2026-11-24T12:00:00Z").getTime();
  const message = staleCacheMessage("Нет связи с RouterAI.", at);
  assert.match(message, /Не удалось обновить каталог/);
  assert.match(message, /Продолжаем на кэше от /);
  assert.ok(!message.includes("Нет связи с RouterAI.  "));
});

test("a failed first refresh does not pretend there is a cache", () => {
  const message = emptyCacheMessage("Нет связи с RouterAI.");
  assert.match(message, /Не удалось загрузить каталог/);
  assert.ok(!message.includes("кэш"));
});

test("neither message ever contains an Authorization header", () => {
  const leaky = new Error("fetch failed with Authorization: Bearer secret-key");
  assert.ok(!describeFetchError(leaky).includes("secret-key"));
});
