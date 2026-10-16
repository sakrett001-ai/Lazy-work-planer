import { createHash, randomUUID } from 'node:crypto';
import type { Connection } from './llm-config.ts';

export class ProviderError extends Error {
  code: string;
  constructor(code: string) { super('Не удалось получить подтверждённый ответ от выбранного подключения.'); this.code = code; }
}
export type ModelReply = { text: string; inputTokens?: number; outputTokens?: number };
export type ModelRequest = { connection: Connection; key: string; model: string; system: string; prompt: string; signal?: AbortSignal };
const endpoints = {
  openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages',
  vsegpt: 'https://api.vsegpt.ru/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  gigachat: 'https://api.giga.chat/v1/chat/completions',
};
const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function createModelClient(fetcher: typeof fetch = fetch) {
  // Cache is scoped to a client and to the credential, connection and OAuth scope.
  // Rotating a key can never reuse the old account's access token.
  const oauth = new Map<string, { token: string; expires: number }>();
  async function post(url: string, headers: Record<string, string>, body: string, parent?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(45000), signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    try {
      const response = await fetcher(url, { method: 'POST', headers, body, redirect: 'error', signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'provider');
      }
      if (!response.body) throw new ProviderError('protocol');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 262144) { await reader.cancel(); throw new ProviderError('response_size'); }
        chunks.push(value);
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
        return value;
      } catch { throw new ProviderError('protocol'); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? 'timeout' : 'network');
    }
  }
  async function gigaToken(connection: Connection, key: string, signal?: AbortSignal) {
    const scope = connection.scope || 'GIGACHAT_API_PERS';
    const id = createHash('sha256').update(JSON.stringify([connection.id, scope, key])).digest('hex');
    const previous = oauth.get(id);
    if (previous && previous.expires > Date.now() + 60000) return previous.token;
    const result = await post('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', RqUID: randomUUID(), authorization: `Basic ${key}`,
    }, new URLSearchParams({ scope }).toString(), signal);
    // Documentation/examples include both Unix seconds and milliseconds.
    const expires = typeof result.expires_at === 'number' ? result.expires_at * (result.expires_at < 1e12 ? 1000 : 1) : 0;
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16384 || /\s/.test(result.access_token) || expires <= Date.now() + 60000) throw new ProviderError('protocol');
    for (const [cachedId, cached] of oauth) if (cached.expires <= Date.now()) oauth.delete(cachedId);
    if (oauth.size >= 40) oauth.clear();
    oauth.set(id, { token: result.access_token, expires: Math.min(expires, Date.now() + 30 * 60000) });
    return result.access_token;
  }
  return async function complete({ connection, key, model, system, prompt, signal }: ModelRequest): Promise<ModelReply> {
    if (!connection.models.includes(model) || !endpoints[connection.provider]) throw new ProviderError('configuration');
    if (system.length + prompt.length > 48000) throw new ProviderError('context_size');
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    let body: Record<string, unknown>;
    if (connection.provider === 'anthropic') {
      headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
      body = { model, system, messages: [{ role: 'user', content: prompt }], max_tokens: connection.maxOutputTokens };
    } else {
      headers.authorization = `Bearer ${connection.provider === 'gigachat' ? await gigaToken(connection, key, signal) : key}`;
      body = connection.provider === 'openai'
        ? { model, instructions: system, input: [{ role: 'user', content: prompt }], max_output_tokens: connection.maxOutputTokens, store: false }
        : { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: connection.maxOutputTokens, stream: false };
      if (connection.provider === 'openrouter') body.provider = { allow_fallbacks: false };
      if (connection.provider === 'gigachat') body.function_call = 'none';
    }
    const result = await post(endpoints[connection.provider], headers, JSON.stringify(body), signal);
    let text: unknown, inputTokens: unknown, outputTokens: unknown;
    if (connection.provider === 'openai') {
      if (result.status !== 'completed' || !Array.isArray(result.output)) throw new ProviderError('incomplete');
      const messages = result.output.filter((item: any) => item.type === 'message');
      if (result.output.some((item: any) => !['message', 'reasoning'].includes(item.type)) || messages.some((m: any) => !Array.isArray(m.content) || m.content.some((c: any) => c.type !== 'output_text'))) throw new ProviderError('protocol');
      text = messages.flatMap((m: any) => m.content).map((c: any) => c.text).join('\n');
      inputTokens = result.usage?.input_tokens; outputTokens = result.usage?.output_tokens;
    } else if (connection.provider === 'anthropic') {
      if (result.stop_reason !== 'end_turn' || !Array.isArray(result.content) || result.content.some((c: any) => c.type !== 'text')) throw new ProviderError('incomplete');
      text = result.content.map((c: any) => c.text).join('\n');
      inputTokens = result.usage?.input_tokens; outputTokens = result.usage?.output_tokens;
    } else {
      const choice = result.choices?.[0];
      if (result.choices?.length !== 1 || choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length || choice.message?.function_call) throw new ProviderError('incomplete');
      text = choice.message?.content; inputTokens = result.usage?.prompt_tokens; outputTokens = result.usage?.completion_tokens;
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 24000) throw new ProviderError('protocol');
    return { text, inputTokens: tokens(inputTokens), outputTokens: tokens(outputTokens) };
  };
}
