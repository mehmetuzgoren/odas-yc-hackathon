/** Server-side OpenAI configuration shared by the guest and room conversations. */
export function modelConfiguration() {
  return {
    key: process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY,
    model: process.env.CONCIERGE_MODEL || process.env.MODEL_NAME || 'gpt-6-luna',
    baseUrl: (process.env.CONCIERGE_MODEL_BASE_URL || process.env.MODEL_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
}

export function modelStatus() {
  const { key, model } = modelConfiguration();
  const mode = process.env.CONCIERGE_MODE === 'rules' || !key ? 'development_rules' : 'model';
  return { mode, model: mode === 'model' ? model : null };
}

export async function modelResponse(request: Record<string, unknown>, timeoutMs = 45_000) {
  const { key, model, baseUrl } = modelConfiguration();
  if (!key) throw new Error('OPENAI_API_KEY is required for model conversations.');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, model, reasoning: { effort: 'low' }, store: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('The language model could not be reached. Please try again.');
  }
  // Provider bodies may contain private request data; keep failures safe to persist and display.
  if (!response.ok) throw new Error(`Language model request failed (${response.status}). Check the configured credentials and model.`);
  const body = await response.json() as { status: string; output?: any[]; model?: string };
  if (body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('The language model did not complete its response.');
  return body;
}

export function modelText(response: { output?: any[] }) {
  const text = (response.output ?? []).filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
    .map(item => item.text).join('\n').trim();
  if (!text) throw new Error('The language model returned no message.');
  return text;
}
