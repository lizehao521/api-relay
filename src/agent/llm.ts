/**
 * Agent 的 LLM 入口：走本网关 /v1/chat/completions（自托管自证闭环）。
 * 每次调用自然被网关的鉴权/预检/路由/归因/计量保护。
 */

import type { AgentLlmCall } from './runner.js';

export interface AgentLlmOptions {
  /** 网关自身 base URL（http://127.0.0.1:8787） */
  baseUrl: string;
  /** 用于调 LLM 的客户端 key（明文；来自 config.clients 里 agent 专用的那条） */
  key: string;
  /** 默认模型（config.agent.model） */
  model: string;
  fetchImpl?: typeof fetch;
}

export function createAgentLlm(opts: AgentLlmOptions): AgentLlmCall {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let baseUrl = opts.baseUrl;
  const llm: AgentLlmCall & { setBaseUrl?: (u: string) => void } = {
    async chat(messages, callOpts) {
      const body = {
        model: callOpts.model || opts.model,
        messages,
        temperature: 0.1, // 运维决策要稳定，不采样
        max_tokens: 1024,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callOpts.timeoutMs || 60_000);
      try {
        const base = baseUrl.replace(/\/$/, '');
        const res = await fetchImpl(base + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + opts.key,
            // Agent 自指纹：网关会把它识别成 agent 型客户（client_kind=agent），计量里可区分
            'user-agent': 'api-relay-ops-agent/1.0',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error('LLM 上游 ' + res.status + ': ' + text.slice(0, 200));
        }
        const data = (await res.json()) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content ?? '';
        return {
          content,
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    setBaseUrl(u: string) { baseUrl = u; },
  };
  return llm;
}
