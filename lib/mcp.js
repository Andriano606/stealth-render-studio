// Мінімальний сервер Model Context Protocol (JSON-RPC 2.0) без зовнішніх залежностей:
// initialize / ping / tools/list / tools/call (+ сповіщення без відповіді). Транспорт
// (Streamable HTTP, POST /mcp) — у routes/mcp.js; тут лише чиста обробка повідомлень.
//
// tools: [{ name, title?, description, inputSchema, annotations?, handler(args, extra) }]
//   handler → { content:[…], isError? } або рядок (стане text-блоком). Кинута помилка →
//   результат з isError:true (за специфікацією помилки виконання тула — не JSON-RPC-помилки,
//   щоб модель бачила текст і могла виправитись); невідомий тул → JSON-RPC -32602.

// Версії протоколу, які ми розуміємо (перша — найновіша). Клієнт просить свою — віддаємо її,
// якщо підтримуємо, інакше — найновішу (клієнт сам вирішить, чи продовжувати).
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

export const RPC = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 });

export const negotiateVersion = (asked) => (MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]);

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// Повідомлення без id — сповіщення (відповіді немає).
const isNotification = (m) => m && typeof m === 'object' && !Array.isArray(m) && !('id' in m) && typeof m.method === 'string';

export function toolResult(out) {
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
  if (out && Array.isArray(out.content)) return out;
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

export function createMcpServer({ name, version, title, instructions, tools = [], log = console }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map(({ handler, ...t }) => t); // eslint-disable-line no-unused-vars

  async function handleOne(msg, extra = {}) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && typeof msg === 'object' ? msg.id : null, RPC.INVALID_REQUEST, 'Invalid Request');
    }
    if (isNotification(msg)) return null; // notifications/initialized, notifications/cancelled, …
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version, ...(title ? { title } : {}) },
          ...(instructions ? { instructions } : {}),
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: listed });
      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) return rpcError(id, RPC.INVALID_PARAMS, 'Unknown tool: ' + params.name);
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        try {
          return rpcResult(id, toolResult(await tool.handler(args, extra)));
        } catch (e) {
          const text = (e && e.message) || String(e);
          if (!(e && e.expected)) log.error('MCP ' + params.name + ':', text);
          return rpcResult(id, { content: [{ type: 'text', text: '❌ ' + text }], isError: true });
        }
      }
      // Інших можливостей (resources/prompts/logging) не оголошуємо — пусті списки для сумісності.
      case 'resources/list': return rpcResult(id, { resources: [] });
      case 'resources/templates/list': return rpcResult(id, { resourceTemplates: [] });
      case 'prompts/list': return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, RPC.METHOD_NOT_FOUND, 'Method not found: ' + method);
    }
  }

  // body — розібраний JSON (обʼєкт або батч-масив). → відповідь (обʼєкт/масив) або null (лише сповіщення).
  async function handle(body, extra = {}) {
    if (Array.isArray(body)) {
      if (!body.length) return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request');
      const out = (await Promise.all(body.map((m) => handleOne(m, extra)))).filter(Boolean);
      return out.length ? out : null;
    }
    return handleOne(body, extra);
  }

  return { handle, tools: listed };
}

// Помилка тула «очікувана» (неправильні аргументи тощо) — без запису в лог сервера.
export function toolError(message) {
  const e = new Error(message);
  e.expected = true;
  return e;
}
