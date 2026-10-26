/** Standalone transport contract, NOT wired to the web runtime or provider catalog.
 * The future broker must reserve budget durably and verify scope BEFORE calling.
 * Injection is mandatory: no environment/credential reads, default fetch, retries,
 * fallback, accounting claims or runtime enable switch are supplied here.
 * Protocol references (verified 2026-10-25):
 * https://aistudio.yandex.ru/ru/docs/ai-studio/api/Chat-Completions/createChatCompletion
 * https://aistudio.yandex.ru/en/docs/ai-studio/api-ref/authentication
 * https://aistudio.yandex.ru/en/docs/ai-studio/operations/disable-logging
 * Model parameter support and response alias still require an authorized probe.
 */
export const YANDEX_CHAT_ENDPOINT = 'https://ai.api.cloud.yandex.net/v1/chat/completions';
export class YandexContractError extends Error {
  readonly outcome: 'not_started' | 'unknown';
  readonly observedUsage?: Readonly<{ inputTokens: number; outputTokens: number }>;
  constructor(outcome: 'not_started' | 'unknown', observedUsage?: { inputTokens: number; outputTokens: number }) {
    super('Yandex response unavailable or unverified; automatic retry is not permitted.');
    this.name = 'YandexContractError'; this.outcome = outcome;
    if (observedUsage) this.observedUsage = Object.freeze({ ...observedUsage });
  }
}
export type YandexContractConfig = {
  fetchImpl: typeof fetch;
  apiKey: string;
  /** Exact server-owned request URI including the newly approved folder. */
  model: string;
  /** Exact provider response model ID, verified separately for this route. */
  expectedResponseModel: string;
  /** Server-approved model context bound, never estimated from prompt length. */
  maxContextTokens: 65536 | 1048576;
  maxCompletionTokens?: number;
  timeoutMs?: number;
};
const requestModel = /^gpt:\/\/[a-zA-Z0-9_-]{3,80}\/[a-zA-Z0-9_.-]{1,100}(?:\/[a-zA-Z0-9_.-]{1,80})?$/;
const responseModel = /^gpt:\/\/[a-zA-Z0-9_./-]{3,240}$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
export function createYandexContract(config: YandexContractConfig) {
  const { fetchImpl, apiKey, model, expectedResponseModel, maxContextTokens, maxCompletionTokens = 800, timeoutMs = 12000 } = config || {};
  if (typeof fetchImpl !== 'function' || typeof apiKey !== 'string' || !/^[A-Za-z0-9_.-]{8,256}$/.test(apiKey)
    || typeof model !== 'string' || !requestModel.test(model) || typeof expectedResponseModel !== 'string' || !responseModel.test(expectedResponseModel)
    || ![65536, 1048576].includes(maxContextTokens)
    || !integer(maxCompletionTokens) || maxCompletionTokens < 1 || maxCompletionTokens > 2048
    || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000) throw new YandexContractError('not_started');
  return async ({ system, prompt, signal }: { system: string; prompt: string; signal?: AbortSignal }) => {
    if (typeof system !== 'string' || !system.trim() || typeof prompt !== 'string' || !prompt.trim()
      || system.length + prompt.length > 48000 || signal?.aborted) throw new YandexContractError('not_started');
    const controller = new AbortController();
    let observedUsage: { inputTokens: number; outputTokens: number } | undefined;
    let started = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const body = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      n: 1, stream: false, store: false, max_completion_tokens: maxCompletionTokens, response_format: { type: 'json_object' } });
    try {
      // Race also bounds a non-conforming injected transport/body reader which
      // ignores AbortSignal. A timed-out request remains unknown, never retried.
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new YandexContractError(started ? 'unknown' : 'not_started')), { once: true });
        timer = setTimeout(cancel, timeoutMs);
      });
      const operation = async () => {
        if (signal?.aborted) { cancel(); throw new YandexContractError('not_started'); }
        started = true;
        const response = await fetchImpl(YANDEX_CHAT_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', Authorization: `Api-Key ${apiKey}`, 'x-data-logging-enabled': 'false' }, body });
        if (controller.signal.aborted) throw new YandexContractError('unknown');
        if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length')) > 32768) {
          void response.body?.cancel().catch(() => {}); throw new YandexContractError('unknown');
        }
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0, text = '';
        const abortReader = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abortReader, { once: true });
        try {
          while (true) {
            const part = await reader.read();
            if (controller.signal.aborted) throw new YandexContractError('unknown');
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 32768) { void reader.cancel().catch(() => {}); throw new YandexContractError('unknown'); }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } catch (error) {
          // Decoding/read failures can occur before EOF. Cancel the body while
          // its reader is still held, including injected streams ignoring abort.
          void reader.cancel().catch(() => {});
          controller.abort();
          throw error;
        } finally { controller.signal.removeEventListener('abort', abortReader); reader.releaseLock(); }
        const result = JSON.parse(text), choice = result?.choices?.[0], usage = result?.usage;
        // A rejected answer may still have incurred cost. Retain only bounded,
        // validated usage observations; unknown never means free or retryable.
        const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
        if (integer(usage?.prompt_tokens) && integer(usage?.completion_tokens) && integer(usage?.total_tokens)
          && usage.prompt_tokens >= 1 && usage.prompt_tokens <= maxContextTokens && usage.completion_tokens >= 1 && usage.completion_tokens <= maxCompletionTokens
          && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens && usage.total_tokens <= maxContextTokens
          && (reasoning === undefined || (integer(reasoning) && reasoning >= 0 && reasoning <= usage.completion_tokens))) {
          observedUsage = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
        }
        if (result?.model !== expectedResponseModel || result?.choices?.length !== 1 || choice?.index !== 0 || choice?.finish_reason !== 'stop'
          || choice?.message?.role !== 'assistant' || typeof choice.message.content !== 'string' || !choice.message.content.trim()
          || choice.message.content.length > 16000 || choice.message.tool_calls != null || choice.message.function_call != null || choice.message.refusal != null
          || !integer(usage?.prompt_tokens) || !integer(usage?.completion_tokens) || !integer(usage?.total_tokens)
          || usage.prompt_tokens < 1 || usage.prompt_tokens > maxContextTokens || usage.completion_tokens < 1 || usage.completion_tokens > maxCompletionTokens
          || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens || usage.total_tokens > maxContextTokens) throw new YandexContractError('unknown');
        if (reasoning !== undefined && (!integer(reasoning) || reasoning < 0 || reasoning > usage.completion_tokens)) throw new YandexContractError('unknown');
        // Leave the content untouched: the host's strict action/citation schema
        // remains authoritative. No fenced/prose JSON extraction or repair here.
        return { text: choice.message.content as string, inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number };
      };
      return await Promise.race([operation(), interrupted]);
    } catch {
      // Abort before clearing the timer, also on protocol/decode failures.
      controller.abort();
      throw new YandexContractError(started ? 'unknown' : 'not_started', observedUsage);
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
}
