/**
 * 应用装配：把配置、存储、上游池、路由、鉴权、降损层、网关与管理接口连成一体。
 *
 * 刻意保持"显式装配"（无 IoC 容器）：中转站的依赖图应该一眼看完，
 * 因为排障时最贵的成本是"不知道谁依赖谁"。
 */

import { Logger } from './core/logger.js';
import type { RelayConfig } from './core/types.js';
import { createStore, SqliteStore, type Store, type StoredKeyMeta } from './store/index.js';
import { ProviderPool } from './upstream/pool.js';
import { closeH2Sessions } from './upstream/http2.js';
import { Router } from './upstream/pool.js';
import { KeyRegistry } from './gateway/keys.js';
import { Meter } from './loss/meter.js';
import { TraceStore } from './loss/tracer.js';
import { Engine } from './gateway/engine.js';
import { RelayServer } from './gateway/server.js';
import { AdminApi } from './admin/api.js';
import { KbStore } from './kb/store.js';
import { AgentRunner } from './agent/runner.js';
import { createAgentLlm } from './agent/llm.js';
import { createAgentContext } from './agent/context.js';

export interface App {
  config: RelayConfig;
  logger: Logger;
  store: Store;
  /** 知识库存储（垂直 Agent 能力；未启用时 undefined） */
  kb?: KbStore | undefined;
  /** 内部 Agent 系统（自托管运维/迭代决策环；未启用时 undefined） */
  agent?: AgentRunner | undefined;
  pool: ProviderPool;
  router: Router;
  keys: KeyRegistry;
  meter: Meter;
  traceStore: TraceStore;
  engine: Engine;
  server: RelayServer;
  admin: AdminApi;
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
  /** 优雅退出（flush 度量、关闭数据库与连接池） */
  shutdown(): Promise<void>;
}

export async function createApp(config: RelayConfig, baseLogger?: Logger): Promise<App> {
  const logger = baseLogger ?? new Logger(config.logLevel);

  /* ---------- 存储（数据库故障自动降级为内存） ---------- */
  const store = await createStore({
    driver: config.storage.driver,
    path: config.storage.path,
    batchSize: config.lossReduction.meter.batchSize,
    flushIntervalMs: config.lossReduction.meter.flushIntervalMs,
    logger,
  });

  /* ---------- 知识库（垂直 Agent 能力，独立 SQLite 库；未配置则不建） ---------- */
  let kb: KbStore | undefined;
  if (config.kb?.path) {
    kb = new KbStore({ path: config.kb.path, chunkSize: config.kb.chunkSize, chunkOverlap: config.kb.chunkOverlap });
    await kb.init();
    logger.info('kb.ready', { path: config.kb.path, ok: kb.ok, chunkSize: config.kb.chunkSize });
  }

  /* ---------- 上游池（可恢复熔断状态） ---------- */
  const restored = store instanceof SqliteStore || 'loadBreakers' in store ? safeLoadBreakers(store) : new Map();
  const pool = new ProviderPool(config, logger, {
    ...(restored.size > 0 ? { restoredBreakers: restored } : {}),
    breakerPersist: (id, state) => {
      if (store instanceof SqliteStore) store.saveBreaker(id, state);
    },
  });

  const router = new Router(pool, config);
  // 恢复面板创建的 key（只有哈希可用；明文不可恢复，这是刻意的安全取舍）
  const storedKeyMeta = (store as unknown as { listKeyMeta?: () => StoredKeyMeta[] }).listKeyMeta?.() ?? [];
  const keys = new KeyRegistry({
    config,
    store,
    logger,
    restoredKeys: storedKeyMeta
      .filter((m) => m.origin === 'panel' && !!m.keyHash)
      .map((m) => ({
        keyId: m.keyId,
        label: m.label,
        tier: m.tier,
        tenantId: m.tenantId,
        enabled: m.enabled,
        keyHash: m.keyHash,
        ...(m.allowedModels ? { allowedModels: m.allowedModels } : {}),
        ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
        ...(m.quotaOverride !== undefined ? { quotaOverride: m.quotaOverride } : {}),
        // 这里逐字段列举，漏一个就等于"落了库但重启即丢" —— 按钱的额度就踩过一次。
        ...(m.costQuotaOverride !== undefined ? { costQuotaOverride: m.costQuotaOverride } : {}),
      })),
  });

  const meter = new Meter({ store, enabled: config.lossReduction.meter.enabled, hashPayloads: config.lossReduction.meter.hashPayloads });
  const traceStore = new TraceStore(
    config.lossReduction.trace.ringSize,
    (t) => store.recordTrace(t),
    config.lossReduction.trace.enabled,
  );

  const engine = new Engine({ config, logger, store, pool, router, keys, meter, traceStore });

  const admin: AdminApi = new AdminApi({
    config,
    logger,
    engine,
    pool,
    router,
    keys,
    meter,
    store,
    traceStore,
    kb,
    serverStats: () => server.stats,
  });
  /* ---------- 内部 Agent 系统（自托管运维/迭代决策环；未启用则不建） ---------- */
  let agent: AgentRunner | undefined;
  if (config.agent?.enabled) {
    const agentKeyRec = config.clients.find((c) => c.id === config.agent!.clientId);
    const agentKey = agentKeyRec?.key ?? '';
    // Agent 调 LLM 走本网关（自证闭环）；baseUrl 在 start() 里回填（listen 之后才知道确切 host）
    const llm = createAgentLlm({ baseUrl: 'http://127.0.0.1', key: agentKey, model: config.agent.model ?? 'default' });
    // baseUrl 需要真实端口，先用占位，start() 时替换
    const context = createAgentContext({
      pool, store, meter, kb,
      recentEvents: config.agent.recentEvents,
    });
    agent = new AgentRunner({
      config: config.agent,
      logger,
      llm,
      context,
      kb,
      store,
      kbId: config.agent.kbId ?? 'kb_demo',
    });
  }

  // 回填 agent 到 admin.deps（AdminDeps.agent 可选字段；agent 构建在 admin 之后）
  if (agent) {
    const adminRef = admin as unknown as { deps: { agent?: AgentRunner } };
    adminRef.deps.agent = agent;
  }

  const server = new RelayServer({ config, engine, admin, logger, kb, keys });

  return {
    config,
    logger,
    store,
    kb,
    agent,
    pool,
    router,
    keys,
    meter,
    traceStore,
    engine,
    server,
    admin,
    async start() {
      const bound = await server.listen();
      // 回填 Agent 的 LLM base URL（listen 之后才知道确切 host:port），并启动周期巡检
      if (agent) {
        agent.setBaseUrl(bound.url);
        agent.start();
      }
      logger.info('relay.listening', {
        url: bound.url,
        providers: config.providers.length,
        clients: keys.listKeys().length,
        precheck: config.lossReduction.precheck.enabled,
        attribution: config.lossReduction.attribution.enabled,
        meter: config.lossReduction.meter.enabled,
      });
      return { url: bound.url };
    },
    async stop() {
      await server.close(config.server.shutdownGraceMs);
    },
    async shutdown() {
      agent?.stop();
      await server.close(config.server.shutdownGraceMs);
      await store.close();
      await kb?.close();
      // 关掉上游 HTTP/2 会话（平时已 unref，不拦退出；这里显式收尾更干净）
      closeH2Sessions();
      logger.info('relay.shutdown_complete', {});
    },
  };
}

function safeLoadBreakers(store: Store): Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }> {
  try {
    const s = store as unknown as { loadBreakers?: () => Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }> };
    return s.loadBreakers ? s.loadBreakers() : new Map();
  } catch {
    return new Map();
  }
}

/** 供 CLI/测试复用：内存配置（不读文件） */
export function memoryConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      trustProxy: false,
      maxBodyBytes: 8 * 1024 * 1024,
      upstreamTimeoutMs: 60_000,
      upstreamTtfbTimeoutMs: 10_000,
      shutdownGraceMs: 1_000,
      ...(overrides.server ?? {}),
    },
    storage: { driver: 'memory', path: ':memory:', ...(overrides.storage ?? {}) },
    lossReduction: overrides.lossReduction ?? {
      precheck: { enabled: true, onBlock: 'reject', budgetUs: 3_000, maxMessages: 512, maxTools: 128, maxTokensCeiling: 1_000_000, dangerousCommandPatterns: ['rm\\s+-rf\\s+/(?!\\w)'] },
      attribution: {
        enabled: true,
        includeEvidence: false,
        autoRetry: 1,
        siblingModelFallback: true,
        backoffBaseMs: 10,
        backoffMaxMs: 200,
        retryableReasons: ['rate_limited', 'upstream_timeout', 'upstream_unavailable', 'network_error', 'model_overloaded', 'stream_interrupted'],
        breakerThreshold: 3,
        breakerCooldownMs: 1_000,
      },
      meter: { enabled: true, batchSize: 50, flushIntervalMs: 100, retentionDays: 7, hashPayloads: true, hashSalt: 'test-salt' },
      trace: { enabled: true, ringSize: 100, persist: true, maxSteps: 64 },
      fingerprint: { enabled: true, agentThreshold: 0.6 },
    },
    tiers: overrides.tiers ?? {
      free: { id: 'free', label: 'free', precheck: 'off', attribution: 'off', meterDetail: false, smartRouting: false, rpm: 1000, maxConcurrency: 8, billing: 'none', periodQuotaTokens: null, priority: 0 },
      standard: { id: 'standard', label: 'standard', precheck: 'observe', attribution: 'header', meterDetail: true, smartRouting: false, rpm: 1000, maxConcurrency: 32, billing: 'token', periodQuotaTokens: null, priority: 10 },
      pro: { id: 'pro', label: 'pro', precheck: 'enforce', attribution: 'full', meterDetail: true, smartRouting: false, rpm: 1000, maxConcurrency: 64, billing: 'subscription', periodQuotaTokens: null, priority: 20 },
    },
    providers: overrides.providers ?? [],
    clients: overrides.clients ?? [],
    modelAliases: overrides.modelAliases ?? {},
    // 之前这里漏了阶梯与能力表：传进来会被静默丢掉，测试只能建完再赋值，
    // 于是"配置里到底有什么模型"这件事没法在构造时表达（写测试时踩过）。
    ...(overrides.modelLadders ? { modelLadders: overrides.modelLadders } : {}),
    ...(overrides.modelCapabilities ? { modelCapabilities: overrides.modelCapabilities } : {}),
    logLevel: overrides.logLevel ?? 'error',
    ...(overrides.defaultProvider ? { defaultProvider: overrides.defaultProvider } : {}),
    ...(overrides.sourcePath ? { sourcePath: overrides.sourcePath } : {}),
  };
}
