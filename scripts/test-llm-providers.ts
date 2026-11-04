/**
 * Pins how an AI provider is chosen for a scan.
 *
 * Run with:  npm run test:llm
 *
 * The rule that matters: the server default keeps working exactly as before, an explicit
 * per-request choice wins, a provider without its API key is still buildable (so the error
 * comes from the provider itself with a clear message), and Hunyuan's default models are
 * the vision reader for images and turbos for text.
 */

import {
  activeProviderId,
  providerSupportsPdf,
  generateText,
} from '../src/server/llm/index.ts';
import {
  getProvider,
  isProviderConfigured,
  resolveDefaultModel,
  resolveModelOverrides,
  resolveProviderId,
  resetProviderCache,
} from '../src/server/llm/config.ts';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    resetProviderCache();
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetProviderCache();
  }
}

console.log('\nChoosing the default provider from the environment');

withEnv({}, () => {
  check('no keys at all falls back to gemini', resolveProviderId() === 'gemini');
  check('gemini is reported unconfigured', !isProviderConfigured('gemini'));
});

withEnv({ GEMINI_API_KEY: 'g-1', DEEPSEEK_API_KEY: 'd-1', HUNYUAN_API_KEY: 'h-1' }, () => {
  check('an explicit LLM_PROVIDER wins over key presence', (() => {
    process.env.LLM_PROVIDER = 'hunyuan';
    const id = resolveProviderId();
    delete process.env.LLM_PROVIDER;
    return id === 'hunyuan';
  })());
  check(
    'without an explicit choice, key precedence is unchanged (gemini first)',
    resolveProviderId() === 'gemini'
  );
  check('all three providers report configured', ['deepseek', 'gemini', 'hunyuan'].every((p) => isProviderConfigured(p as any)));
});

withEnv({ DEEPSEEK_API_KEY: 'd-1' }, () => {
  check('a lone DeepSeek key still selects DeepSeek', resolveProviderId() === 'deepseek');
});

withEnv({ HUNYUAN_API_KEY: 'h-1' }, () => {
  check('a lone Hunyuan key selects Hunyuan', resolveProviderId() === 'hunyuan');
});

console.log('\nDefault models and override chains');

withEnv({}, () => {
  check('hunyuan vision reads with hunyuan-vision-latest', resolveDefaultModel('hunyuan', 'vision') === 'hunyuan-vision-latest');
  check('hunyuan text defaults to hunyuan-turbos-latest', resolveDefaultModel('hunyuan', 'text') === 'hunyuan-turbos-latest');
  check(
    'hunyuan vision honours HUNYUAN_VISION_MODEL',
    resolveModelOverrides('hunyuan', 'vision')[0] === 'hunyuan-vision-latest'
  );
});

withEnv({ HUNYUAN_VISION_MODEL: 'hunyuan-t1-vision-20250916' }, () => {
  const chain = resolveModelOverrides('hunyuan', 'vision');
  check('the vision override heads the chain', chain[0] === 'hunyuan-t1-vision-20250916');
  check(
    'with no explicit fallback the override is the whole chain (same as DeepSeek)',
    chain.length === 1
  );
});

withEnv({ HUNYUAN_MODEL: 'hunyuan-lite' }, () => {
  check(
    'a bare HUNYUAN_MODEL covers both kinds',
    resolveModelOverrides('hunyuan', 'text')[0] === 'hunyuan-lite'
  );
});

console.log('\nProviders are built per id and keep their capabilities');

withEnv({}, () => {
  check('the hunyuan adapter reports its own id', getProvider('hunyuan').id === 'hunyuan');
  check('the deepseek adapter reports its own id', getProvider('deepseek').id === 'deepseek');
  check('the default provider is unchanged', activeProviderId() === resolveProviderId());
  check('a request names its own provider', activeProviderId({ provider: 'hunyuan' }) === 'hunyuan');
  check('hunyuan needs rasterised pages (not pdf native)', !providerSupportsPdf({ provider: 'hunyuan' }));
  check('gemini stays pdf native', providerSupportsPdf({ provider: 'gemini' }));
  check('deepseek stays image only', !providerSupportsPdf({ provider: 'deepseek' }));
  check(
    'the same instance is reused for the same id',
    getProvider('hunyuan') === getProvider('hunyuan')
  );
  check(
    'an unknown id falls back to the default rather than throwing',
    activeProviderId({ provider: 'nope' as any }) === resolveProviderId()
  );
});

console.log('\nA chosen provider without a key fails loudly, not silently');

async function runMissingKeyChecks(): Promise<void> {
  withEnv({}, () => {
    let message = '';
    try {
      void generateText({
        provider: 'hunyuan',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }).catch((err: any) => {
        // The rejection lands here because generateText walks the fallback chain before throwing.
        message = String(err?.message || err);
      });
    } catch (err: any) {
      message = String(err?.message || err);
    }
    // generateText is async; give the rejected promise a moment to settle.
    setTimeout(() => {
      check('the missing key is named in the error', message.includes('HUNYUAN_API_KEY'), message);
      console.log(`\n${passed} passed, ${failed} failed\n`);
      if (failed > 0) process.exit(1);
    }, 50);
  });
}

void runMissingKeyChecks();
