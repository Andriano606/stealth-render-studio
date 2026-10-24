// POST /mcp — MCP-сервер стенду (транспорт Streamable HTTP, без станів і без SSE): Claude Code
// підключається командою `claude mcp add --transport http stealth-render http://localhost:3000/mcp`.
// Тули — lib/mcpTools.js, протокол — lib/mcp.js. Host/Origin перевіряє hostGuard (lib/guard.js),
// як і для решти API (специфікація MCP вимагає перевіряти Origin — захист від DNS-rebinding).
import express from 'express';
import { createMcpServer, MCP_PROTOCOL_VERSIONS, RPC } from '../lib/mcp.js';
import { createMcpTools, SERVER_INSTRUCTIONS } from '../lib/mcpTools.js';

export const MCP_PATH = '/mcp';
export const MCP_SERVER_NAME = 'stealth-render';
export const MCP_JSON_LIMIT = '1mb';

export function mcpRoutes(d) {
  const r = express.Router();
  const server = createMcpServer({
    name: MCP_SERVER_NAME, title: 'Stealth Render Studio', version: d.version || '1.0.0',
    instructions: SERVER_INSTRUCTIONS, tools: createMcpTools(d), log: d.log || console,
  });
  const rpcErr = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });

  r.post(MCP_PATH, express.json({ limit: MCP_JSON_LIMIT }), async (req, res, next) => {
    const v = req.get('mcp-protocol-version');
    if (v && !MCP_PROTOCOL_VERSIONS.includes(v)) return rpcErr(res, 400, RPC.INVALID_REQUEST, 'Unsupported MCP-Protocol-Version: ' + v);
    // Клієнт відʼєднався (скасував виклик) — тул закриває контекст браузера і звільняє слот.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const out = await server.handle(req.body, { signal: ac.signal });
      if (res.writableEnded || res.destroyed) return;
      if (out == null) return res.status(202).end(); // лише сповіщення/відповіді
      res.json(out);
    } catch (e) { next(e); }
  });
  // Сервер не відкриває SSE-потік і не тримає сесій.
  r.get(MCP_PATH, (_req, res) => res.set('Allow', 'POST').status(405).json({ ok: false, error: 'MCP: лише POST (Streamable HTTP без SSE)' }));
  r.delete(MCP_PATH, (_req, res) => res.set('Allow', 'POST').status(405).json({ ok: false, error: 'MCP: сесій немає' }));
  // Битий JSON / завелике тіло → JSON-RPC-помилка (а не загальний формат API).
  // eslint-disable-next-line no-unused-vars
  r.use(MCP_PATH, (err, _req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return rpcErr(res, 400, RPC.PARSE, 'Parse error');
    if (err && err.status === 413) return rpcErr(res, 413, RPC.INVALID_REQUEST, 'Request too large');
    next(err);
  });
  return r;
}
