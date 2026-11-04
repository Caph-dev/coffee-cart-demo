#!/usr/bin/env node
/**
 * 静态前端 + SSE 点单 API。
 *   PORT=8787 node src/server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENU, menuNames } from './menu.mjs';
import { readConfig, PROJECT_ROOT } from './jev.mjs';
import { runCart } from './cart.mjs';

const WEB_ROOT = path.join(PROJECT_ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null;
  return full;
}

async function serveStatic(req, res) {
  const filePath = safeJoin(WEB_ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let target = filePath;
  try {
    const st = await fs.promises.stat(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await fs.promises.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function readBody(req, limit = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleOrder(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: error.message === 'body_too_large' ? '请求体过大' : 'JSON 无效' });
    return;
  }
  const request = typeof body.request === 'string' ? body.request.trim() : '';
  if (!request) {
    sendJson(res, 400, { error: '请填写点单内容' });
    return;
  }
  if (request.length > 500) {
    sendJson(res, 400, { error: '点单内容过长' });
    return;
  }

  const config = readConfig();
  if (!config.apiKey) {
    sendJson(res, 503, { error: '服务器未配置 JEV_API_KEY' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeEvent = (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  req.on('close', () => {
    // client aborted; runCart will keep going but writes become no-ops
  });

  try {
    writeEvent({ type: 'hello', menu: menuNames() });
    await runCart(config, request, writeEvent);
  } catch (error) {
    writeEvent({ type: 'error', message: error?.message || String(error) });
  } finally {
    if (!res.writableEnded) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
    }
  }
}

function handleMenu(_req, res) {
  sendJson(res, 200, {
    items: MENU.map(({ id, name, desc }) => ({ id, name, desc })),
  });
}

function handleHealth(_req, res) {
  const config = readConfig();
  sendJson(res, 200, {
    ok: true,
    hasKey: Boolean(config.apiKey),
    model: config.model,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(req, res);
    if (req.method === 'GET' && url.pathname === '/api/menu') return handleMenu(req, res);
    if (req.method === 'POST' && url.pathname === '/api/order') return handleOrder(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    res.writeHead(405).end('Method not allowed');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器错误' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const config = readConfig();
  console.log(`coffee-cart demo  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`Jev key：${config.apiKey ? '已设置' : '未设置'}  model=${config.model}`);
});
