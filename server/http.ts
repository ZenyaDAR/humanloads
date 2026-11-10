// Node HTTP server around the platform-free handler in app.ts.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP } from 'node:net';

type Handle = (request: Request, client?: string) => Promise<Response>;

// IPv6 clients get a whole /64 per key: one subscriber usually holds that many addresses.
function v6Prefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Railway's edge sets X-Real-IP. Only a well-formed address is used; anything else falls back to the socket.
// If the edge ever passed a client's own value through, a forger would only escape the per-client limit: the global
// limit on new computations still holds.
export function clientKey(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const header = req.headers['x-real-ip'];
  const raw = typeof header === 'string' && isIP(header.trim()) ? header.trim() : (req.socket.remoteAddress ?? '');
  const kind = isIP(raw);
  return kind === 6 ? v6Prefix(raw) : kind === 4 ? raw : 'unknown';
}

export function startServer(handle: Handle, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      // Checked before building a Request, which throws on methods like TRACE and CONNECT.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        return void res.end();
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost'); // only the path is used, whatever host a client names
      } catch {
        res.writeHead(400);
        return void res.end();
      }
      const response = await handle(new Request(url, { method: req.method, headers: { authorization: req.headers.authorization ?? '' } }), clientKey(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(`request failed: ${String(err).slice(0, 200)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  // Behind Railway's proxy, which keeps idle connections up to 60 s: stay open a little longer so it never reuses a
  // socket we just closed (a 502). Slow clients are cut off at the edge.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 70_000;
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
