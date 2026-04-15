import { NextRequest } from 'next/server';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
export const runtime = 'nodejs';

// Prefer IPv4 when both A/AAAA are present to avoid IPv6-only refusals in some envs
try { (dns as any).setDefaultResultOrder?.('ipv4first'); } catch {}

const DEBUG_PROXY = process.env.DEBUG_PROXY === 'true' || process.env.DEBUG === 'true';
const dbg = (...args: any[]) => {
  if (DEBUG_PROXY) {
    try {
      console.error('[proxy]', ...args);
    } catch {}
  }
};

const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const INSECURE = process.env.BACKEND_INSECURE_SKIP_TLS_VERIFY === 'true';
const BACKEND_CA_CERT = process.env.BACKEND_CA_CERT;

// If explicitly insecure, disable TLS verification globally as a last resort
if (INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function buildTargetUrl(pathSegments: string[], search: string): string {
  const base = BACKEND_URL.replace(/\/$/, '');
  const hasApi = /\/api\/?$/.test(base);
  const joinPath = pathSegments.join('/');
  const target = hasApi ? `${base}/${joinPath}` : `${base}/api/${joinPath}`;
  return `${target}${search || ''}`;
}

async function forward(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params;
  const url = buildTargetUrl(path || [], req.nextUrl.search || '');
  dbg('Request start', { method: req.method, url });
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    // Drop hop-by-hop and problematic headers that undici rejects
    if (
      [
        'host',
        'origin',
        'referer',
        'connection',
        'keep-alive',
        'proxy-connection',
        'transfer-encoding',
        'upgrade',
        'te',
        'trailer',
        'proxy-authenticate',
        'proxy-authorization',
        'content-length',
      ].includes(key.toLowerCase())
    )
      return;
    headers.set(key, value);
  });
  if (DEBUG_PROXY) {
    const headerNames: string[] = [];
    headers.forEach((_, k) => headerNames.push(k));
    dbg('Request headers (names only)', headerNames.sort());
  }

  let bodyBuffer: Buffer | undefined = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ab = await req.arrayBuffer();
    bodyBuffer = Buffer.from(ab);
  }

  const isHttps = url.startsWith('https://');
  let res: globalThis.Response;

  const statusAllowsBody = (code?: number) => {
    if (code === undefined) return true;
    if ((code >= 100 && code < 200) || code === 204 || code === 205 || code === 304) return false;
    return true;
  };

  const sanitizeNoBodyHeaders = (h: Headers) => {
    h.delete('content-length');
    h.delete('content-type');
    h.delete('content-encoding');
  };
  try {
    // If TLS is custom/insecure, prefer node https request directly
    if (isHttps && (INSECURE || BACKEND_CA_CERT)) {
      dbg('Using nodeRequest due to INSECURE/CA override', { url });
      const nodeRes = await nodeRequest(url, req.method, headers, bodyBuffer);
      const respHeaders = new Headers();
      Object.entries(nodeRes.headers as http.IncomingHttpHeaders).forEach(([k, v]) => {
        if (
          !k ||
          [
            'transfer-encoding',
            'connection',
            'keep-alive',
            'proxy-connection',
            'upgrade',
            'te',
            'trailer',
          ].includes(k.toLowerCase())
        )
          return;
        if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
        else if (typeof v === 'string') respHeaders.set(k, v);
      });
      const status = nodeRes.statusCode || 502;
      dbg('nodeRequest response', { status });
      if (!statusAllowsBody(status) || req.method === 'HEAD') {
        sanitizeNoBodyHeaders(respHeaders);
        return new Response(null, { status, headers: respHeaders });
      }
      const rb = await streamToBuffer(nodeRes);
      // Response typings don't accept Buffer; wrap to Uint8Array to satisfy BodyInit
      return new Response(new Uint8Array(rb), { status, headers: respHeaders });
    }

    res = await fetch(url, {
      method: req.method,
      headers,
      body: bodyBuffer as any,
      redirect: 'manual',
      cache: 'no-store',
    } as any);
    dbg('fetch response', { status: res.status });
  } catch (err: any) {
    const code = err?.code || err?.cause?.code;
    const isCertErr = code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT';
    dbg('fetch error', {
      url,
      method: req.method,
      code: err?.code,
      message: err?.message,
      name: err?.name,
      causeCode: err?.cause?.code,
      syscall: err?.syscall,
      address: err?.address,
      port: err?.port,
    });
    if ((INSECURE || BACKEND_CA_CERT) && isCertErr) {
      // Fallback to Node http/https request with custom agent
      dbg('Falling back to nodeRequest after TLS error', { url, code });
      const nodeRes = await nodeRequest(url, req.method, headers, bodyBuffer);
      const respHeaders = new Headers();
      Object.entries(nodeRes.headers as http.IncomingHttpHeaders).forEach(([k, v]) => {
        if (
          !k ||
          [
            'transfer-encoding',
            'connection',
            'keep-alive',
            'proxy-connection',
            'upgrade',
            'te',
            'trailer',
          ].includes(k.toLowerCase())
        )
          return;
        if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
        else if (typeof v === 'string') respHeaders.set(k, v);
      });
      const status = nodeRes.statusCode || 502;
      dbg('nodeRequest response (fallback)', { status });
      if (!statusAllowsBody(status) || req.method === 'HEAD') {
        sanitizeNoBodyHeaders(respHeaders);
        return new Response(null, { status, headers: respHeaders });
      }
      const rb = await streamToBuffer(nodeRes);
      return new Response(new Uint8Array(rb), { status, headers: respHeaders });
    }
    throw err;
  }

  const responseHeaders = new Headers();
  res.headers.forEach((value, key) => {
    // Avoid setting hop-by-hop or security-contradictory headers
    if (
      [
        'transfer-encoding',
        'connection',
        'keep-alive',
        'proxy-connection',
        'upgrade',
        'te',
        'trailer',
      ].includes(key.toLowerCase())
    )
      return;
    responseHeaders.set(key, value);
  });

  const status = res.status;
  if (!statusAllowsBody(status) || req.method === 'HEAD') {
    sanitizeNoBodyHeaders(responseHeaders);
    return new Response(null, { status, headers: responseHeaders });
  }
  const arrayBuffer = await res.arrayBuffer();
  if (DEBUG_PROXY && status >= 400) {
    try {
      const preview = Buffer.from(arrayBuffer).toString('utf8').slice(0, 512);
      dbg('Error response preview', { status, preview });
    } catch {}
  }
  return new Response(arrayBuffer, { status, headers: responseHeaders });
}

export const GET = forward as any;
export const POST = forward as any;
export const PUT = forward as any;
export const PATCH = forward as any;
export const DELETE = forward as any;
export const OPTIONS = forward as any;

async function nodeRequest(urlString: string, method: string, headers: Headers, body?: Buffer) {
  const u = new URL(urlString);
  const isHttps = u.protocol === 'https:';
  const agent = isHttps ? new https.Agent({ rejectUnauthorized: !INSECURE, ca: BACKEND_CA_CERT }) : undefined;
  const hObj: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (
      [
        'host',
        'origin',
        'referer',
        'content-length',
        'transfer-encoding',
        'connection',
        'keep-alive',
        'proxy-connection',
        'upgrade',
        'te',
        'trailer',
        'proxy-authenticate',
        'proxy-authorization',
      ].includes(k.toLowerCase())
    )
      return;
    hObj[k] = v;
  });
  if (body) hObj['content-length'] = String(body.length);

  const options: https.RequestOptions = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: `${u.pathname}${u.search}`,
    method,
    headers: hObj,
    agent,
  };

  const mod = isHttps ? https : http;
  return await new Promise<http.IncomingMessage>((resolve, reject) => {
    dbg('nodeRequest start', { protocol: options.protocol, hostname: options.hostname, port: options.port, path: options.path, method: options.method });
    const req = mod.request(options, (res) => resolve(res));
    req.on('error', (e: any) => {
      dbg('nodeRequest error', { code: e?.code, message: e?.message, syscall: e?.syscall, address: e?.address, port: e?.port });
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function streamToBuffer(res: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}
