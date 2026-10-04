import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

const CHINESE_HUD_SUMMARY_INSTRUCTIONS = [
  "为 God's Eye View 的当前地图视野生成一句简短摘要。",
  '只使用提供的地名、街道、附近地点、已开启图层和 feedProvenance，不推测或编造事件。',
  '优先使用最明确的地名，必要时提及相关图层。',
  '如果已开启图层的状态不是 nominal，必须原样包含相应的大写英文状态标识：STALE、DEGRADED、FALLBACK、LOADING 或 UNAVAILABLE，不得描述为实时正常。',
  '只输出一行简体中文摘要，不超过24个字，不加标题、解释、标点或 Markdown。',
].join(' ');

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chatContent = data?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string' && chatContent.trim()) {
    return chatContent.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toHudSummary(value, language) {
  const text = String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // Chinese words do not use spaces. Keep a short Unicode-safe line instead
  // of applying the original five-space-separated-word limit.
  if (language === 'zh-CN') return Array.from(text).slice(0, 40).join('');
  return text.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey =
    process.env.OPENAI_HUD_SUMMARY_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const format = process.env.OPENAI_HUD_SUMMARY_API_FORMAT || 'responses';
    if (!['responses', 'chat-completions'].includes(format)) {
      throw new Error('Unsupported HUD summary API format');
    }
    const base = new URL(
      process.env.OPENAI_HUD_SUMMARY_BASE_URL || 'https://api.openai.com/v1',
    );
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error('Invalid HUD summary API base URL');
    }
    const endpoint = `${base.href.replace(/\/+$/, '')}/${format === 'chat-completions' ? 'chat/completions' : 'responses'}`;
    // A validated browser preference overrides the deployment's default.
    const language = ['en', 'zh-CN'].includes(context.language)
      ? context.language
      : process.env.OPENAI_HUD_SUMMARY_LANGUAGE;
    const instructions =
      language === 'zh-CN'
        ? CHINESE_HUD_SUMMARY_INSTRUCTIONS
        : HUD_SUMMARY_INSTRUCTIONS;
    const model =
      process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT;
    const effort =
      process.env.OPENAI_HUD_SUMMARY_REASONING_EFFORT ||
      (format === 'chat-completions' ? 'none' : 'minimal');
    const payload =
      format === 'chat-completions'
        ? {
            model,
            messages: [
              { role: 'system', content: instructions },
              { role: 'user', content: JSON.stringify(context) },
            ],
            reasoning_effort: effort,
            max_tokens: 120,
            stream: false,
          }
        : {
            model,
            instructions,
            input: JSON.stringify(context),
            reasoning: { effort },
            max_output_tokens: 100,
          };
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      // The HUD gives a request five seconds. Stop upstream work first so a
      // slow provider cannot keep running after the browser has fallen back.
      signal: AbortSignal.timeout(4500),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    const summary = response.ok
      ? toHudSummary(extractOpenAiResponseText(data), language)
      : '';
    res.statusCode = response.ok
      ? summary
        ? 200
        : 502
      : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error:
          response.ok && summary ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
