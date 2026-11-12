// 手元で動かすサーバー（データベースは PGlite＝メモリ上。止めると消える）
//   npm run dev            → http://localhost:8787
//   DEV_SEED=1 npm run dev → 架空のデータ入り（管理者「管理者」／暗証番号 1234）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, normalize, extname } from 'node:path';
import { handle } from '../src/app.js';
import { createPgliteDb, migrate } from '../src/db.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// 本番（vercel.json）と同じセキュリティヘッダーを付ける。CSP 違反を手元の画面テストで見つけられるようにするため。
const VERCEL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json'), 'utf8'));
const SECURITY = Object.fromEntries(VERCEL.headers[0].headers.map(h => [h.key, h.value]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function memoryBlob() {
  const store = new Map();
  return {
    put: async (k, body) => void store.set(k, { body, uploadedAt: new Date() }),
    get: async k => {
      if (!store.has(k)) throw new Error('not found');
      return store.get(k).body;
    },
    list: async prefix => [...store].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.body.length, uploadedAt: v.uploadedAt })),
    del: async k => void store.delete(k),
  };
}

export async function createDevEnv() {
  const db = await createPgliteDb();
  await migrate(db);
  return { db, blob: memoryBlob(), PIN_PEPPER: 'dev-pepper-0123456789abcdef', ADMIN_SETUP_TOKEN: 'dev-setup', CRON_SECRET: 'dev-cron', ENVIRONMENT: 'development' };
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname);
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function startServer(env, port = 8787) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (await serveStatic(url.pathname, res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('見つかりません');
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const response = await handle(new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env);
      const out = {};
      response.headers.forEach((v, k) => {
        if (k !== 'set-cookie') out[k] = v;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end('error');
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = await createDevEnv();
  if (process.env.DEV_SEED) {
    const { seedDemo } = await import('./dev-seed.mjs');
    await seedDemo(env);
  }
  const port = Number(process.env.PORT || 8787);
  await startServer(env, port);
  console.log(`http://localhost:${port}  （止めるとデータは消えます）`);
}
