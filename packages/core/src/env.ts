/** The caller's env minus every paid route (API key, gateway, Bedrock, Vertex): a spawned claude runs on the subscription login. */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE_CODE_USE_')) out[k] = v;
  return out;
}
