// keel placeholder — the page a fresh keel project serves until the real app
// replaces it (set container_image in <env>.tfvars). Zero dependencies, and a
// reference implementation of keel's environment contract:
//   - listens on PORT (injected by Scaleway, defaults to 8080)
//   - enforces Basic Auth when BASIC_AUTH_ENABLED=true, with the
//     BASIC_AUTH_USER / BASIC_AUTH_PASSWORD secrets injected from Infisical
//   - reads PROJECT_NAME / APP_ENVIRONMENT set by the generated Terraform
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .replaceAll('{{PROJECT_NAME}}', escapeHtml(process.env.PROJECT_NAME ?? 'your project'))
  .replaceAll('{{ENVIRONMENT}}', escapeHtml(process.env.APP_ENVIRONMENT ?? 'unknown'));

const logo = readFileSync(new URL('./logo.png', import.meta.url));

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Compare via digests so length differences don't leak timing. */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req) {
  if (process.env.BASIC_AUTH_ENABLED !== 'true') return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  const user = decoded.slice(0, at);
  const password = decoded.slice(at + 1);
  return (
    safeEqual(user, process.env.BASIC_AUTH_USER ?? '') &&
    safeEqual(password, process.env.BASIC_AUTH_PASSWORD ?? '')
  );
}

createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.url === '/logo.png') {
    res
      .writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
      .end(logo);
    return;
  }
  if (!authorized(req)) {
    res
      .writeHead(401, {
        'WWW-Authenticate': 'Basic realm="keel", charset="UTF-8"',
        'Content-Type': 'text/plain',
      })
      .end('Authentication required');
    return;
  }
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(page);
}).listen(PORT, () => {
  console.log(`keel placeholder listening on :${PORT}`);
});
