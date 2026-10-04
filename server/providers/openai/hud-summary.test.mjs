import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleHudSummary } from './hud-summary.js';

const CONFIG_FIELDS = [
  'OPENAI_API_KEY',
  'OPENAI_HUD_SUMMARY_API_KEY',
  'OPENAI_HUD_SUMMARY_BASE_URL',
  'OPENAI_HUD_SUMMARY_API_FORMAT',
  'OPENAI_HUD_SUMMARY_MODEL',
  'OPENAI_HUD_SUMMARY_LANGUAGE',
  'OPENAI_HUD_SUMMARY_REASONING_EFFORT',
  'GEV_RATELIMIT_OPENAI_PER_MIN',
];

function configure(t, values = {}) {
  const previous = new Map(CONFIG_FIELDS.map((key) => [key, process.env[key]]));
  for (const key of CONFIG_FIELDS) delete process.env[key];
  Object.assign(process.env, { GEV_RATELIMIT_OPENAI_PER_MIN: '0', ...values });
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function request(context = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(context))]);
    Object.assign(req, {
      method: 'POST',
      url: '/api/openai/hud-summary',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(body) {
        resolve({ status: this.statusCode, headers, body: JSON.parse(body) });
      },
    };
    Promise.resolve(handleHudSummary(req, res)).catch(reject);
  });
}

test('an independent HUD key uses CPA Chat Completions and a Chinese summary', async (t) => {
  configure(t, {
    OPENAI_HUD_SUMMARY_API_KEY: 'fixture-cpa-key',
    OPENAI_HUD_SUMMARY_BASE_URL: 'http://cli-proxy-api:8317/v1/',
    OPENAI_HUD_SUMMARY_API_FORMAT: 'chat-completions',
    OPENAI_HUD_SUMMARY_MODEL: 'z-ai/glm-5.3-flash',
    OPENAI_HUD_SUMMARY_LANGUAGE: 'zh-CN',
  });
  const context = {
    placeLabels: ['Osaka, Japan'],
    enabledLayerLabels: ['Flights'],
    feedProvenance: { overall: 'stale' },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://cli-proxy-api:8317/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-cpa-key');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'z-ai/glm-5.3-flash');
    assert.equal(payload.reasoning_effort, 'none');
    assert.equal(payload.stream, false);
    assert.match(payload.messages[0].content, /简体中文/);
    assert.match(payload.messages[0].content, /STALE/);
    assert.deepEqual(JSON.parse(payload.messages[1].content), context);
    return Response.json({
      choices: [{ message: { content: '大阪航班图层 STALE，数据待更新。' } }],
    });
  });
  const result = await request(context);
  assert.equal(result.status, 200);
  assert.equal(result.body.summary, '大阪航班图层 STALE 数据待更新');
  assert.equal(result.body.error, null);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(
    process.env.OPENAI_API_KEY,
    undefined,
    'summary does not configure voice',
  );
});

test('the original Responses configuration keeps the key fallback and five-word output', async (t) => {
  configure(t, { OPENAI_API_KEY: 'fixture-openai-key' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer fixture-openai-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'gpt-5-nano');
    assert.equal(payload.reasoning.effort, 'minimal');
    assert.match(payload.instructions, /exactly five words/);
    return Response.json({
      output: [{ content: [{ text: 'Osaka flights over the city today' }] }],
    });
  });
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.summary, 'Osaka flights over the city');
});

test('a provider failure never exposes its message or presents its content as a summary', async (t) => {
  configure(t, { OPENAI_HUD_SUMMARY_API_KEY: 'fixture-cpa-key' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: { message: 'sensitive upstream account fixture-cpa-key' },
        output_text: 'This must not be displayed',
      },
      { status: 503 },
    ),
  );
  const result = await request();
  assert.equal(result.status, 503);
  assert.equal(result.body.summary, null);
  assert.equal(result.body.error, 'OpenAI HUD summary request failed');
  assert.ok(!JSON.stringify(result).includes('fixture-cpa-key'));
});

test('the selected browser language overrides the server default in both directions', async (t) => {
  configure(t, {
    OPENAI_HUD_SUMMARY_API_KEY: 'fixture-cpa-key',
    OPENAI_HUD_SUMMARY_API_FORMAT: 'chat-completions',
    OPENAI_HUD_SUMMARY_LANGUAGE: 'zh-CN',
  });
  const instructions = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    instructions.push(prompt);
    return Response.json({
      choices: [
        {
          message: {
            content: prompt.includes('简体中文')
              ? '大阪附近航班与船舶图层'
              : 'Osaka flights and ships displayed here',
          },
        },
      ],
    });
  });
  const english = await request({ language: 'en' });
  assert.equal(english.body.summary, 'Osaka flights and ships displayed');
  const chinese = await request({ language: 'zh-CN' });
  assert.equal(chinese.body.summary, '大阪附近航班与船舶图层');
  const invalid = await request({ language: 'unexpected-language' });
  assert.equal(invalid.body.summary, '大阪附近航班与船舶图层');
  assert.match(instructions[0], /exactly five words/);
  assert.match(instructions[1], /简体中文/);
  assert.match(instructions[2], /简体中文/);
});

test('a successful response without visible text is a failure, never a successful blank line', async (t) => {
  configure(t, { OPENAI_HUD_SUMMARY_API_KEY: 'fixture-cpa-key' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: '' } }] }),
  );
  const result = await request();
  assert.equal(result.status, 502);
  assert.equal(result.body.summary, null);
  assert.equal(result.body.error, 'OpenAI HUD summary request failed');
});

test('an unconfigured HUD remains local without requesting a provider', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('keyless HUD requested a provider'),
  );
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, false);
  assert.equal(result.body.summary, null);
});
