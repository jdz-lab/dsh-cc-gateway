// dsh-cc-gateway 本地自测：零依赖，node test/run.mjs
import http from "node:http";
import assert from "node:assert/strict";
import {
  normalizeConfig,
  patchHeaders,
  patchBody,
  installFetchRewriter,
  rewriteRequest,
  DEFAULTS,
  billingBlockOf,
} from "../lib/index.js";

const captures = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captures.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// 未命中源的第二台服务器
const otherCaptures = [];
const other = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    otherCaptures.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.end("{}");
  });
});
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const otherOrigin = `http://127.0.0.1:${other.address().port}`;

const cfg = normalizeConfig({ upstreams: [origin] });
assert.equal(cfg.upstreamTargets[0].origin, origin);

const originalFetch = globalThis.fetch;
const restore = installFetchRewriter(() => cfg, { warn: console.warn, info: console.info });
assert.notEqual(globalThis.fetch, originalFetch);

const jsonHeaders = { "content-type": "application/json", authorization: "Bearer sk-test-123" };

// ---- 1. POST /v1/messages：5 项指纹全部注入 ----
const body1 = JSON.stringify({ model: "claude-opus-5-5", system: "be nice", messages: [], stream: true });
const r1 = await globalThis.fetch(`${origin}/v1/messages`, { method: "POST", headers: { ...jsonHeaders }, body: body1 });
await r1.json();
{
  const cap = captures.at(-1);
  assert.match(cap.headers["user-agent"], /^claude-cli\/2\.1\.294 \(external, sdk-cli\)$/);
  assert.equal(cap.headers["x-app"], "cli");
  assert.ok(cap.headers["anthropic-beta"].split(",").map((s) => s.trim()).includes("claude-code-20250219"));
  assert.equal(cap.headers["x-api-key"], "sk-test-123");
  assert.equal(cap.headers["anthropic-version"], "2023-06-01");
  const sent = JSON.parse(cap.body);
  assert.ok(sent.system[0].text.startsWith("x-anthropic-billing-header: cc_version=2.1.294.0a5; cc_entrypoint=sdk-cli;"));
  assert.ok(sent.system[0].text.endsWith("Anthropic's official CLI for Claude."));
  assert.equal(sent.system[1].text, "be nice");
  const meta = JSON.parse(sent.metadata.user_id);
  assert.equal(meta.device_id, DEFAULTS.deviceId);
  assert.match(meta.session_id, /^[0-9a-f-]{36}$/);
  console.log("1. POST /v1/messages 指纹注入 ✓");
}

// ---- 2. 已有 anthropic-beta 头：合并而不是覆盖 ----
await globalThis.fetch(`${origin}/v1/messages`, {
  method: "POST",
  headers: { ...jsonHeaders, "anthropic-beta": "context-1m-2025-08-07" },
  body: JSON.stringify({ model: "x", messages: [] }),
});
{
  const betas = captures.at(-1).headers["anthropic-beta"].split(",").map((s) => s.trim());
  assert.ok(betas.includes("context-1m-2025-08-07") && betas.includes("claude-code-20250219"));
  console.log("2. anthropic-beta 合并 ✓");
}

// ---- 3. GET /v1/models（模型发现）：只改头，无体 ----
await globalThis.fetch(`${origin}/v1/models`, { headers: { authorization: "Bearer sk-test-123" } });
{
  const cap = captures.at(-1);
  assert.match(cap.headers["user-agent"], /^claude-cli\//);
  assert.equal(cap.body, "");
  console.log("3. GET /v1/models 头注入、无体改动 ✓");
}

// ---- 4. 数组形式的 system 块：前置计费块 ----
await globalThis.fetch(`${origin}/v1/messages`, {
  method: "POST",
  headers: { ...jsonHeaders },
  body: JSON.stringify({ model: "x", messages: [], system: [{ type: "text", text: "s0" }] }),
});
{
  const sent = JSON.parse(captures.at(-1).body);
  assert.equal(sent.system.length, 2);
  assert.equal(sent.system[1].text, "s0");
  console.log("4. system 数组前置 ✓");
}

// ---- 5. 非法 JSON 体：原样放行 ----
await globalThis.fetch(`${origin}/v1/messages`, { method: "POST", headers: { ...jsonHeaders }, body: "{not-json" });
{
  assert.equal(captures.at(-1).body, "{not-json");
  console.log("5. 非法 JSON 原样放行 ✓");
}

// ---- 6. 未命中源：完全不受影响 ----
await globalThis.fetch(`${otherOrigin}/v1/messages`, { method: "POST", headers: { ...jsonHeaders }, body: body1 });
{
  const cap = otherCaptures.at(-1);
  assert.ok(!cap.headers["user-agent"]?.startsWith("claude-cli/"));
  assert.equal(cap.headers["x-app"], undefined);
  const sent = JSON.parse(cap.body);
  assert.equal(sent.metadata, undefined);
  console.log("6. 未命中源不受影响 ✓");
}

// ---- 7. Request 对象风格的调用 ----
const req7 = new Request(`${origin}/v1/messages`, { method: "POST", headers: { ...jsonHeaders }, body: body1 });
await globalThis.fetch(req7);
{
  const sent = JSON.parse(captures.at(-1).body);
  assert.ok(sent.system[0].text.startsWith("x-anthropic-billing-header"));
  console.log("7. Request 对象风格 ✓");
}

// ---- 8. 恢复原 fetch ----
restore();
assert.equal(globalThis.fetch, originalFetch);
console.log("8. dispose 恢复原 fetch ✓");

// ---- 9. 重复安装不叠层：新实例基于原始 fetch ----
const restoreA = installFetchRewriter(() => cfg);
const patchA = globalThis.fetch;
const restoreB = installFetchRewriter(() => cfg); // 先恢复 A，再基于原 fetch 安装 B
assert.notEqual(globalThis.fetch, patchA);
restoreB();
assert.equal(globalThis.fetch, originalFetch); // B 恢复后直接回到原始 fetch，证明 B 不是包在 A 外面
restoreA(); // 幂等：fetch 已不是 A 的补丁，无操作
assert.equal(globalThis.fetch, originalFetch);
console.log("9. 重复安装/恢复幂等 ✓");

// ---- 10. 纯函数：patchHeaders / patchBody / rewriteRequest ----
{
  const h = patchHeaders({}, cfg);
  assert.equal(h["x-app"], "cli");
  const b = patchBody({}, cfg);
  assert.ok(b.system[0].text.startsWith("x-anthropic-billing-header"));
  assert.equal(rewriteRequest("not a url", {}, cfg), null);
  assert.equal(rewriteRequest("https://example.com/v1/messages", {}, cfg), null);
  assert.throws(() => normalizeConfig({ upstreams: [] }));
  assert.throws(() => normalizeConfig({ upstreams: "ftp://x" }));
  assert.ok(billingBlockOf(cfg).includes("cc_version=2.1.294.0a5"));
  console.log("10. 纯函数与校验 ✓");
}

// ---- 11. 本地隧道形态：目标 URL 内嵌在路径里（如 billion-context /bili/<url>） ----
{
  const tunnel = `http://127.0.0.1:18787/bili/${origin}/v1/messages?beta=true`;
  const plan = rewriteRequest(tunnel, { method: "POST", headers: { ...jsonHeaders }, body: body1 }, cfg);
  assert.ok(plan, "隧道 URL 应命中改写");
  assert.equal(plan.init.headers["x-app"], "cli");
  const sent = JSON.parse(plan.init.body);
  assert.ok(sent.system[0].text.startsWith("x-anthropic-billing-header"));
  assert.ok(sent.metadata.user_id);
  // URL 编码过的隧道形态也要命中
  const encoded = `http://127.0.0.1:18787/bili/${encodeURIComponent(`${origin}/v1/messages`)}`;
  assert.ok(rewriteRequest(encoded, {}, cfg), "URL 编码的隧道 URL 应命中改写");
  // 隧道目标不是 upstream：仍然不命中
  assert.equal(rewriteRequest("http://127.0.0.1:18787/bili/https://example.com/v1/messages", {}, cfg), null);
  console.log("11. 本地隧道内嵌 URL 命中 ✓");
}

server.close();
other.close();
console.log("\n全部通过 ✓");
