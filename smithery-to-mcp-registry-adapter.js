#!/usr/bin/env node
/**
 * Smithery -> MCP Registry (official OpenAPI) adapter
 * ---------------------------------------------------
 * Your Paradigm app only ingests the OFFICIAL MCP Registry OpenAPI shape:
 *     { "servers": [ { "server": {...}, "_meta": {...} } ], "metadata": { ... } }
 * Public directories like Smithery expose their OWN shape, which is why adding
 * them directly returns 404. This service sits in the middle: it pulls Smithery's
 * (unauthenticated) catalog and re-serves it in the official format so your app
 * can sync it as an upstream.
 *
 * Endpoints served (it matches ANY version prefix, so /v0, /v0.1, /v1 or none all work):
 *     GET  /v0/servers            and  /v0.1/servers            -> list (cursor paginated)
 *     GET  /v0/servers/:name/versions                           -> versions of one server
 *     GET  /v0/servers/:name/versions/:version                  -> one server version
 *     GET  /v0/health  /v0/ping  /health                        -> {"status":"healthy"}
 *
 * Requirements: Node 18+ (uses the built-in global fetch). No npm install needed.
 * Run:          node smithery-to-mcp-registry-adapter.js
 * Then point your app's "Base URL" at this server's root (Authentication = None).
 *
 * Config (all optional, via environment variables):
 *   PORT                  Port to listen on                      (default 8080)
 *   SMITHERY_BASE         Smithery registry base                 (default https://registry.smithery.ai)
 *   SMITHERY_CONNECT_BASE Hosted MCP connection base             (default https://server.smithery.ai)
 *   SMITHERY_API_KEY      Optional bearer token for Smithery     (default none; listing works without it)
 *   REGISTRY_NAMESPACE    Reverse-DNS namespace for server names (default ai.smithery)
 *   DESC_MAX              Max description length (chars)          (default 100)
 *   ONLY_DEPLOYED         "true" to keep only live remote servers (default false)
 *   SCHEMA_URL            server.json $schema value               (default 2025-12-11 schema)
 */

'use strict';
const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SMITHERY_BASE = (process.env.SMITHERY_BASE || 'https://registry.smithery.ai').replace(/\/+$/, '');
const SMITHERY_CONNECT_BASE = (process.env.SMITHERY_CONNECT_BASE || 'https://server.smithery.ai').replace(/\/+$/, '');
const SMITHERY_API_KEY = process.env.SMITHERY_API_KEY || '';
const NAMESPACE = (process.env.REGISTRY_NAMESPACE || 'ai.smithery').toLowerCase();
const DESC_MAX = Math.max(20, parseInt(process.env.DESC_MAX || '100', 10) || 100);
const ONLY_DEPLOYED = /^(1|true|yes)$/i.test(process.env.ONLY_DEPLOYED || '');
const SCHEMA_URL = process.env.SCHEMA_URL ||
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const DEFAULT_LIMIT = 100;

// generatedName -> official ServerResponse, filled as pages are served (for versions lookups)
const index = new Map();

// ---- helpers ---------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function clamp(n, lo, hi) {
  n = Number.isFinite(n) ? n : lo;
  return Math.min(hi, Math.max(lo, n));
}

function sanitizeNamePart(s) {
  const out = String(s == null ? '' : s)
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return out || 'server';
}

function toOfficialName(qualifiedName) {
  return `${NAMESPACE}/${sanitizeNamePart(qualifiedName)}`;
}

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!s) return 'MCP server from Smithery';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Map ONE Smithery server object into an official MCP Registry ServerResponse.
function mapServer(s) {
  const qn = s.qualifiedName || s.name || s.slug || 'unknown';
  const name = toOfficialName(qn);
  const created = s.createdAt || new Date().toISOString();

  const server = {
    $schema: SCHEMA_URL,
    name,
    description: truncate(s.description || s.displayName || qn, DESC_MAX),
    title: String(s.displayName || qn),
    version: '1.0.0',
    remotes: [
      { type: 'streamable-http', url: `${SMITHERY_CONNECT_BASE}/${qn}/mcp` },
    ],
  };
  if (s.homepage && /^https?:\/\//i.test(s.homepage)) server.websiteUrl = s.homepage;
  if (s.iconUrl && /^https?:\/\//i.test(s.iconUrl)) server.icons = [{ src: s.iconUrl }];

  const entry = {
    server,
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        publishedAt: created,
        updatedAt: created,
        isLatest: true,
      },
      'ai.smithery/source': {
        qualifiedName: qn,
        useCount: typeof s.useCount === 'number' ? s.useCount : undefined,
        verified: !!s.verified,
      },
    },
  };
  index.set(name, entry);
  return entry;
}

async function fetchSmithery(page, pageSize, q) {
  const u = new URL(SMITHERY_BASE + '/servers');
  u.searchParams.set('page', String(page));
  u.searchParams.set('pageSize', String(pageSize));
  if (q) u.searchParams.set('q', q);
  const headers = { Accept: 'application/json' };
  if (SMITHERY_API_KEY) headers.Authorization = `Bearer ${SMITHERY_API_KEY}`;
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`Smithery responded ${r.status} ${r.statusText}`);
  return r.json();
}

// ---- HTTP plumbing ---------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS));
  res.end(body);
}

// ---- route handlers --------------------------------------------------------

async function handleList(res, urlObj) {
  const limit = clamp(parseInt(urlObj.searchParams.get('limit') || String(DEFAULT_LIMIT), 10), 1, 100);
  const cursor = urlObj.searchParams.get('cursor');
  const search = urlObj.searchParams.get('search') || urlObj.searchParams.get('q') || '';
  const page = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;

  const data = await fetchSmithery(page, limit, search);
  let list = Array.isArray(data.servers) ? data.servers : [];
  if (ONLY_DEPLOYED) list = list.filter((s) => s.isDeployed !== false && s.remote !== false);

  const servers = list.map(mapServer);
  const pag = data.pagination || {};
  const current = pag.currentPage || page;
  const totalPages = pag.totalPages || current;

  const metadata = { count: servers.length };
  if (current < totalPages) metadata.nextCursor = String(current + 1);
  sendJSON(res, 200, { servers, metadata });
}

async function lookup(name) {
  if (index.has(name)) return index.get(name);
  // Not seen yet: search Smithery by the human tail of the name and match.
  const tail = name.split('/').pop();
  try {
    const data = await fetchSmithery(1, 50, tail);
    for (const s of data.servers || []) {
      const entry = mapServer(s);
      if (entry.server.name === name) return entry;
    }
  } catch (_) { /* fall through to 404 */ }
  return null;
}

async function handleVersions(res, name) {
  const entry = await lookup(name);
  if (!entry) return sendJSON(res, 404, { error: 'server not found', code: 'not_found' });
  sendJSON(res, 200, { servers: [entry], metadata: { count: 1 } });
}

async function handleVersion(res, name, version) {
  const entry = await lookup(name);
  if (!entry) return sendJSON(res, 404, { error: 'server not found', code: 'not_found' });
  if (version !== 'latest' && version !== entry.server.version) {
    return sendJSON(res, 404, { error: 'version not found', code: 'not_found' });
  }
  sendJSON(res, 200, entry);
}

// version-prefix-agnostic routes (matches /v0/.., /v0.1/.., /v1/.. or bare /..)
const VP = '(?:v\\d+(?:\\.\\d+)?\\/)?';
const VERSION_RE = new RegExp(`^/${VP}servers/([^/]+)/versions/([^/]+)/?$`);
const VERSIONS_RE = new RegExp(`^/${VP}servers/([^/]+)/versions/?$`);
const LIST_RE = new RegExp(`^/${VP}servers/?$`);
const HEALTH_RE = new RegExp(`^/${VP}(?:health|ping)/?$`);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = urlObj.pathname;
    log(req.method, p + (urlObj.search || ''));

    let m;
    if ((m = VERSION_RE.exec(p))) return await handleVersion(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if ((m = VERSIONS_RE.exec(p))) return await handleVersions(res, decodeURIComponent(m[1]));
    if (LIST_RE.test(p)) return await handleList(res, urlObj);
    if (HEALTH_RE.test(p)) return sendJSON(res, 200, { status: 'healthy' });
    if (p === '/') {
      return sendJSON(res, 200, {
        name: 'smithery-to-mcp-registry-adapter',
        upstream: SMITHERY_BASE,
        endpoints: ['/v0/servers', '/v0.1/servers'],
        note: 'Re-serves the Smithery catalog in the official MCP Registry OpenAPI format.',
      });
    }
    return sendJSON(res, 404, { error: 'not found', code: 'not_found' });
  } catch (e) {
    log('ERROR', e && e.message);
    sendJSON(res, 502, { error: 'upstream error', code: 'upstream_error', details: String(e && e.message) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    log(`adapter listening on :${PORT}  ->  ${SMITHERY_BASE}`);
    log(`try:  curl "http://localhost:${PORT}/v0/servers?limit=3"`);
  });
}

module.exports = { mapServer, toOfficialName, truncate, sanitizeNamePart };
