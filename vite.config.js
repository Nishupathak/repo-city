import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Serves every file in the /api folder locally during `npm run dev`
// (/api/classify -> api/classify.js, /api/analyze -> api/analyze.js, ...)
// and loads your keys from .env. On Vercel the same files run as-is.
const ENV_PREFIXES = ['ANTHROPIC_', 'GITHUB_', 'GEMINI_', 'GROQ_'];

function localApi(env) {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const name = url.pathname.replace(/^\/+|\/+$/g, '');
          if (!/^[a-z0-9_-]+$/i.test(name)) return next();

          const file = path.join(process.cwd(), 'api', `${name}.js`);
          if (!fs.existsSync(file)) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: `No such endpoint: /api/${name}` }));
          }

          // make keys from .env visible to the handler
          for (const key of Object.keys(env)) {
            if (ENV_PREFIXES.some((p) => key.startsWith(p))) process.env[key] = env[key];
          }

          // query string and JSON body, like on Vercel
          req.query = Object.fromEntries(url.searchParams);
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString();
            req.body = raw ? JSON.parse(raw) : {};
          }

          res.status = (code) => {
            res.statusCode = code;
            return res;
          };
          res.json = (obj) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(obj));
          };

          const mod = await server.ssrLoadModule(`/api/${name}.js`);
          await mod.default(req, res);
        } catch (err) {
          console.error('[local-api]', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return { plugins: [localApi(env)] };
});
