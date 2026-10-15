// Load the authored TS tools with the real eve defineTool; no framework/network mocks.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/agent/')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    return next(specifier, context);
  },
});
export const context = (id, callId = 'test-call') => ({ callId, session: { auth: { current: { principalId: id } } } });
export async function invoke(tool, input, id, callId) {
  return tool.execute(tool.inputSchema.parse(input), context(id, callId));
}
