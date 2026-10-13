// dsh-cc-gateway —— 把 cc-lens 的 Claude Code 客户端指纹注入搬进 DSH 宿主进程。
//
// 不少公司内网网关（new-api / one-api 及其衍生）按 5 项客户端特征联合判定
// 请求是否来自 Claude Code，缺一不可（参照 D:\common\cc-lens 的抓包结论）：
//   1. user-agent: claude-cli/x.x.x (external, sdk-cli)
//   2. x-app: cli
//   3. anthropic-beta 含 claude-code-20250219
//   4. system[0].text 以 x-anthropic-billing-header 计费行开头
//   5. metadata.user_id 为含 device_id/session_id 的 JSON 字符串
//
// 本插件不自己实现协议：dsh-llm-pi-ai 的路由（api: anthropic-messages）直连
// 内网网关，本插件在宿主进程里装一个**作用域受限**的全局 fetch 改写器，
// 仅对 upstreams 里配置的源（scheme://host:port）生效：
//   - 所有命中请求：补/改上面 1–3 项请求头（模型发现 GET /v1/models 同样受益）
//   - POST */v1/messages：再补 4–5 项请求体字段
// 其余请求原样放行，插件内部任何异常都不会影响原始调用。
//
// 卸载（disable / HMR 重载）时恢复原 fetch，不会叠层。

import { randomUUID } from "node:crypto";

// ---- cc-lens 的实测指纹常量（网关升级检测后优先改这里） ----
export const DEFAULTS = Object.freeze({
  claudeVersion: "2.1.294",
  entrypoint: "sdk-cli",
  betaTag: "claude-code-20250219",
  deviceId: "61314638cb1ce5bd350d02fa8aad25ed27e39fa0eb02f29f7686eeffdd807995",
  accountUuid: "",
});

const GUARD = Symbol.for("dsh-cc-gateway.patched-fetch");
const RESTORE = Symbol.for("dsh-cc-gateway.restore");

// ---------- 配置 ----------

export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULTS, ...raw };
  for (const key of ["claudeVersion", "entrypoint", "betaTag", "deviceId", "accountUuid"]) {
    if (merged[key] != null && typeof merged[key] !== "string") {
      throw new Error(`[dsh-cc-gateway] config.${key} 必须是字符串`);
    }
  }
  let upstreams = raw.upstreams ?? [];
  if (typeof upstreams === "string") upstreams = [upstreams];
  if (!Array.isArray(upstreams)) {
    throw new Error("[dsh-cc-gateway] config.upstreams 必须是字符串或字符串数组");
  }
  const targets = upstreams.map((value) => {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      throw new Error(`[dsh-cc-gateway] 无法解析 upstream 地址: ${JSON.stringify(value)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`[dsh-cc-gateway] upstream 必须是 http(s) 地址: ${value}`);
    }
    return { origin: url.origin, host: url.host.toLowerCase(), protocol: url.protocol };
  });
  if (targets.length === 0) {
    throw new Error("[dsh-cc-gateway] config.upstreams 不能为空：插件不知道该改写哪些请求");
  }
  return { ...merged, upstreamTargets: targets };
}

export function billingBlockOf(cfg) {
  return (
    `x-anthropic-billing-header: cc_version=${cfg.claudeVersion}.0a5; ` +
    `cc_entrypoint=${cfg.entrypoint};\n\n` +
    "You are Claude Code, Anthropic's official CLI for Claude."
  );
}

// ---------- 指纹注入（与 cc-lens lib/fingerprint.js 保持一致） ----------

export function patchHeaders(headers, cfg) {
  headers["user-agent"] = `claude-cli/${cfg.claudeVersion} (external, ${cfg.entrypoint})`;
  headers["x-app"] = "cli";
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  // 只带 Authorization: Bearer 的客户端，补上 Anthropic 必需的 x-api-key
  if (!headers["x-api-key"] && headers["authorization"]) {
    headers["x-api-key"] = String(headers["authorization"]).replace(/^Bearer\s+/i, "");
  }
  const betas = String(headers["anthropic-beta"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!betas.includes(cfg.betaTag)) betas.push(cfg.betaTag);
  headers["anthropic-beta"] = betas.join(",");
  return headers;
}

export function patchBody(body, cfg) {
  const block = { type: "text", text: billingBlockOf(cfg) };
  if (body.system == null) {
    body.system = [block];
  } else if (typeof body.system === "string") {
    body.system = [block, { type: "text", text: body.system }];
  } else if (Array.isArray(body.system)) {
    body.system = [block, ...body.system];
  }
  body.metadata = {
    user_id: JSON.stringify({
      device_id: cfg.deviceId,
      account_uuid: cfg.accountUuid,
      session_id: randomUUID(),
    }),
  };
  return body;
}

// ---------- fetch 改写器 ----------

function headersToPlain(headers) {
  const plain = {};
  if (!headers) return plain;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, name) => {
      plain[name.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) plain[String(name).toLowerCase()] = String(value);
  } else if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) plain[name.toLowerCase()] = String(value);
  }
  return plain;
}

function matchesTarget(url, cfg) {
  try {
    const parsed = new URL(url);
    return cfg.upstreamTargets.some(
      (t) => parsed.protocol === t.protocol && parsed.host.toLowerCase() === t.host
    );
  } catch {
    return false;
  }
}

/**
 * 返回改写后的 { input, init }；不需要改写时返回 null。
 * 任何失败都抛给调用方，由调用方兜底放行原始请求。
 */
export function rewriteRequest(input, init, cfg) {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input && typeof input === "object" && typeof input.url === "string"
        ? input.url
        : null;
  if (!url || !matchesTarget(url, cfg)) return null;

  const parsed = new URL(url);
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  let headers = headersToPlain(init?.headers ?? input?.headers);
  let body = init?.body;

  // Request 对象且需要改体时，读出文本再走 init 风格转发
  if (body == null && input && typeof input === "object" && typeof input.body !== "undefined" && method !== "GET" && method !== "HEAD") {
    // 同步上下文读不了流；标记为需要调用方先 clone/await（见 rewriteRequestAsync）
    return { needsBodyRead: true, input: url, request: input, init, cfg };
  }

  let payload = body;
  if (method === "POST" && parsed.pathname.includes("/v1/messages")) {
    let text;
    if (typeof payload === "string") text = payload;
    else if (payload instanceof Uint8Array) text = new TextDecoder().decode(payload);
    if (typeof text === "string") {
      try {
        const obj = JSON.parse(text);
        patchBody(obj, cfg);
        payload = JSON.stringify(obj);
      } catch {
        // 非 JSON：原样转发，让上游报错（与 cc-lens 行为一致）
      }
    }
  }

  patchHeaders(headers, cfg);
  if (typeof payload === "string") headers["content-length"] = String(Buffer.byteLength(payload));

  const nextInit = { ...(init ?? {}) };
  nextInit.method = method;
  nextInit.headers = headers;
  if (method !== "GET" && method !== "HEAD") nextInit.body = payload;
  else delete nextInit.body;
  return { input: url, init: nextInit };
}

/** rewriteRequest 的异步外壳：处理 Request 流体的情形。 */
export async function rewriteRequestAsync(input, init, cfg) {
  const plan = rewriteRequest(input, init, cfg);
  if (!plan || !plan.needsBodyRead) return plan;
  const text = await plan.request.clone().text();
  const nextInit = { ...(plan.init ?? {}) };
  if (nextInit.method == null) nextInit.method = plan.request.method;
  nextInit.body = text;
  return rewriteRequest(plan.input, nextInit, plan.cfg);
}

/**
 * 给全局 fetch 装上改写器，返回恢复函数。
 * 若已存在本插件旧实例的补丁，先恢复，保证不叠层。
 */
export function installFetchRewriter(getConfig, logger) {
  const previous = globalThis.fetch;
  if (previous && typeof previous === "function" && previous[GUARD] && typeof previous[RESTORE] === "function") {
    previous[RESTORE]();
  }
  const original = globalThis.fetch;

  const patched = async function fetch(input, init) {
    let rewritten = null;
    try {
      const cfg = getConfig();
      if (cfg) rewritten = await rewriteRequestAsync(input, init, cfg);
    } catch (error) {
      try {
        logger?.warn?.("[dsh-cc-gateway] 改写请求失败，按原样放行: %o", error);
      } catch {}
    }
    if (rewritten) return original(rewritten.input, rewritten.init);
    return original(input, init);
  };
  patched[GUARD] = true;

  const restore = () => {
    if (globalThis.fetch === patched) globalThis.fetch = original;
  };
  patched[RESTORE] = restore;
  globalThis.fetch = patched;
  return restore;
}

// ---------- cordis 插件 ----------

export const name = "cc-gateway";

let restoreFetch = null;
let activeConfig = null;

export function apply(ctx, config) {
  activeConfig = normalizeConfig(config);
  const logger = ctx?.logger;
  restoreFetch = installFetchRewriter(
    () => activeConfig,
    logger
  );
  logger?.info?.(
    "[dsh-cc-gateway] 指纹改写器已启用，命中源: %s（Claude Code %s / %s）",
    activeConfig.upstreamTargets.map((t) => t.origin).join(", "),
    activeConfig.claudeVersion,
    activeConfig.betaTag
  );
}

/** 配置热更新：只换配置对象，不动 fetch 补丁。 */
export function update(ctx, config) {
  activeConfig = normalizeConfig(config);
  ctx?.logger?.info?.(
    "[dsh-cc-gateway] 配置已更新，命中源: %s",
    activeConfig.upstreamTargets.map((t) => t.origin).join(", ")
  );
}

export function dispose() {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  activeConfig = null;
}
