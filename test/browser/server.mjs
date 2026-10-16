// Test server for the browser tests: a minimal console, the test apps, the built SDK (dist/) and
// a fake Thinger API. The app frame is sandboxed (opaque origin), so the API answers CORS.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

// tokens: the console hands out T1; after a refresh, T2. The API only accepts T2 for devices,
// so the first call exercises the 401 → refresh → retry path.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const T1 = b64({ alg: 'HS256' }) + '.' + b64({ usr: 'alice', n: 1 }) + '.x';
const T2 = b64({ alg: 'HS256' }) + '.' + b64({ usr: 'alice', n: 2 }) + '.x';
const calls = [];

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
}

function send(res, status, body) {
    cors(res);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
        cors(res);
        res.writeHead(204);
        return res.end();
    }
    if (path === '/test/tokens') return send(res, 200, { T1, T2 });
    if (path === '/test/calls') return send(res, 200, calls);
    if (path.startsWith('/v1/') || path.startsWith('/v2/') || path.startsWith('/v3/')) {
        calls.push({ path: path + url.search, auth: req.headers.authorization || null });
        if (path === '/v1/server/version') return send(res, 200, { version: '7.5.0' });
        if (path === '/v1/users/alice/devices') {
            if (req.headers.authorization !== 'Bearer ' + T2)
                return send(res, 401, { error: { message: 'expired' } });
            return send(
                res,
                200,
                url.searchParams.get('index') === '0' ? [{ device: 'd1' }, { device: 'd2' }] : [],
            );
        }
        return send(res, 404, { error: { message: 'not found' } });
    }
    const file = normalize(
        join(root, path.startsWith('/dist/') ? path : join('test/browser/pages', path)),
    );
    if (!file.startsWith(root)) return send(res, 403, {});
    try {
        const body = await readFile(file);
        // module scripts of the sandboxed (opaque-origin) frame are CORS requests
        cors(res);
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end();
    }
}).listen(port, () => console.log('test server on http://localhost:' + port));
