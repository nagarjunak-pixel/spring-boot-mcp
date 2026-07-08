// @ts-check
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const axios = require("axios");
const { z } = require("zod");

// ─── Config from env ──────────────────────────────────────────────────────────
const BASE_URL      = process.env.SPRING_BASE_URL      ?? "http://localhost:8080";
const ACTUATOR_BASE = process.env.SPRING_ACTUATOR_PATH ?? "/actuator";
const USERNAME      = process.env.SPRING_USERNAME;
const PASSWORD      = process.env.SPRING_PASSWORD;
const BEARER_TOKEN  = process.env.SPRING_BEARER_TOKEN;
const TIMEOUT_MS    = parseInt(process.env.SPRING_TIMEOUT_MS ?? "10000", 10);

// ─── Axios client ─────────────────────────────────────────────────────────────
function makeClient(baseURL) {
  const cfg = { baseURL, timeout: TIMEOUT_MS };
  if (BEARER_TOKEN) {
    cfg.headers = { Authorization: `Bearer ${BEARER_TOKEN}` };
  } else if (USERNAME && PASSWORD) {
    cfg.auth = { username: USERNAME, password: PASSWORD };
  }
  return axios.create(cfg);
}

const client = makeClient(BASE_URL);

function aUrl(path) { return `${ACTUATOR_BASE}${path}`; }

function fmtError(e) {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status ?? "no-response";
    const body   = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 300)
      : e.message;
    return `HTTP ${status}: ${body}`;
  }
  return String(e);
}

function ok(data) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

function err(msg) {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true };
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "spring-boot-mcp", version: "1.0.0" });

// ════════════════════════════════════════════════════════════════════════════
// ACTUATOR TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 1. Health
server.registerTool("spring_health", {
  description: "Get health status via /actuator/health — UP/DOWN + component details (DB, disk, custom indicators).",
  inputSchema: {
    showDetails: z.boolean().optional().default(true).describe("Show full component breakdown"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  try {
    const res = await client.get(aUrl("/health"));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 2. Info
server.registerTool("spring_info", {
  description: "Get app info from /actuator/info — version, build time, git commit, and custom info beans.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  try {
    const res = await client.get(aUrl("/info"));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 3. List all metrics
server.registerTool("spring_metrics_list", {
  description: "List all available metric names from /actuator/metrics. Use before spring_metric_get.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  try {
    const res = await client.get(aUrl("/metrics"));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 4. Get specific metric
server.registerTool("spring_metric_get", {
  description: 'Get a specific metric from /actuator/metrics/{name}, e.g. "jvm.memory.used" or "http.server.requests".',
  inputSchema: {
    name: z.string().describe('Metric name, e.g. "jvm.memory.used"'),
    tags: z.string().optional().describe('Comma-separated tag filters, e.g. "uri=/api/orders,method=GET"'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ name, tags }) => {
  try {
    const params = {};
    if (tags) {
      tags.split(",").forEach(t => { params["tag"] = t.trim().replace("=", ":"); });
    }
    const res = await client.get(aUrl(`/metrics/${name}`), { params });
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 5. Environment
server.registerTool("spring_env", {
  description: 'Get env properties from /actuator/env. Filter by prefix like "spring.datasource" or "server".',
  inputSchema: {
    prefix: z.string().optional().describe('Key prefix to filter, e.g. "spring.datasource"'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ prefix }) => {
  try {
    const path = prefix ? aUrl(`/env/${prefix}`) : aUrl("/env");
    const res = await client.get(path);
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 6. Beans
server.registerTool("spring_beans", {
  description: "List all Spring beans from /actuator/beans. Filter by name substring (e.g. 'Controller').",
  inputSchema: {
    filter: z.string().optional().describe("Substring filter on bean name, e.g. 'Repository'"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ filter }) => {
  try {
    const res = await client.get(aUrl("/beans"));
    if (!filter) return ok(res.data);
    const lower = filter.toLowerCase();
    const contexts = res.data?.contexts ?? {};
    const filtered = {};
    for (const [ctx, ctxData] of Object.entries(contexts)) {
      const matching = {};
      for (const [beanName, beanDef] of Object.entries(ctxData.beans ?? {})) {
        if (beanName.toLowerCase().includes(lower)) matching[beanName] = beanDef;
      }
      if (Object.keys(matching).length > 0) filtered[ctx] = { beans: matching };
    }
    return ok(filtered);
  } catch (e) { return err(fmtError(e)); }
});

// 7. Request Mappings
server.registerTool("spring_mappings", {
  description: 'List all HTTP request mappings from /actuator/mappings. Filter by path substring like "/api/users".',
  inputSchema: {
    filter: z.string().optional().describe('Filter by path substring, e.g. "/api"'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ filter }) => {
  try {
    const res = await client.get(aUrl("/mappings"));
    if (!filter) return ok(res.data);
    const lower = filter.toLowerCase();
    const result = [];
    const traverse = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.predicate && JSON.stringify(node.predicate).toLowerCase().includes(lower)) result.push(node);
      for (const v of Object.values(node)) traverse(v);
    };
    traverse(res.data);
    return ok(result);
  } catch (e) { return err(fmtError(e)); }
});

// 8. Thread Dump
server.registerTool("spring_threaddump", {
  description: "Get a JVM thread dump from /actuator/threaddump. Filter by thread state (RUNNABLE, BLOCKED, WAITING, etc.) to diagnose deadlocks or CPU issues.",
  inputSchema: {
    stateFilter: z.enum(["RUNNABLE", "WAITING", "TIMED_WAITING", "BLOCKED", "ALL"])
      .optional().default("ALL").describe("Filter threads by state"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ stateFilter }) => {
  try {
    const res = await client.get(aUrl("/threaddump"));
    if (stateFilter === "ALL") return ok(res.data);
    const threads = res.data?.threads ?? [];
    const filtered = threads.filter(t => t.threadState === stateFilter);
    return ok({ threads: filtered, total: threads.length, shown: filtered.length });
  } catch (e) { return err(fmtError(e)); }
});

// 9. Heap dump URL
server.registerTool("spring_heapdump_url", {
  description: "Returns the curl command to download a heap dump HPROF file from /actuator/heapdump.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  return ok({
    url: `${BASE_URL}${ACTUATOR_BASE}/heapdump`,
    command: `curl -o heapdump.hprof ${BASE_URL}${ACTUATOR_BASE}/heapdump`,
    note: "Open the file with Eclipse MAT or VisualVM for analysis.",
  });
});

// 10. Loggers list
server.registerTool("spring_loggers_list", {
  description: 'List all loggers and their levels from /actuator/loggers. Filter by package, e.g. "com.myapp".',
  inputSchema: {
    filter: z.string().optional().describe('Substring filter on logger name, e.g. "com.mycompany"'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ filter }) => {
  try {
    const res = await client.get(aUrl("/loggers"));
    if (!filter) return ok(res.data);
    const lower = filter.toLowerCase();
    const loggers = res.data?.loggers ?? {};
    const filtered = {};
    for (const [name, lvl] of Object.entries(loggers)) {
      if (name.toLowerCase().includes(lower)) filtered[name] = lvl;
    }
    return ok(filtered);
  } catch (e) { return err(fmtError(e)); }
});

// 11. Set log level
server.registerTool("spring_logger_set_level", {
  description: "Change a logger's level at runtime via /actuator/loggers/{name}. No restart needed.",
  inputSchema: {
    loggerName: z.string().describe('Logger name, e.g. "com.mycompany.service" or "ROOT"'),
    level: z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "OFF"]).describe("New log level"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ loggerName, level }) => {
  try {
    await client.post(aUrl(`/loggers/${loggerName}`), { configuredLevel: level });
    return ok({ success: true, logger: loggerName, level });
  } catch (e) { return err(fmtError(e)); }
});

// 12. Scheduled tasks
server.registerTool("spring_scheduledtasks", {
  description: "List scheduled tasks (cron, fixed-rate, fixed-delay) from /actuator/scheduledtasks.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  try {
    const res = await client.get(aUrl("/scheduledtasks"));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 13. Caches
server.registerTool("spring_caches", {
  description: "List all Spring caches and cache managers from /actuator/caches.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  try {
    const res = await client.get(aUrl("/caches"));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 14. Evict cache
server.registerTool("spring_cache_evict", {
  description: "Clear a specific cache or ALL caches via DELETE /actuator/caches/{name}.",
  inputSchema: {
    cacheName: z.string().optional().describe("Cache name. Omit to evict ALL caches."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ cacheName }) => {
  try {
    const path = cacheName ? aUrl(`/caches/${cacheName}`) : aUrl("/caches");
    await client.delete(path);
    return ok({ evicted: cacheName ?? "ALL" });
  } catch (e) { return err(fmtError(e)); }
});

// ════════════════════════════════════════════════════════════════════════════
// REST API TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 15. GET
server.registerTool("spring_api_get", {
  description: 'Make a GET request to any endpoint of the Spring Boot app, e.g. "/api/users".',
  inputSchema: {
    path: z.string().describe('Path, e.g. "/api/users"'),
    params: z.record(z.string()).optional().describe('Query params, e.g. {"page":"0","size":"20"}'),
    headers: z.record(z.string()).optional().describe("Extra headers"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ path, params, headers }) => {
  try {
    const res = await client.get(path, { params, headers });
    return ok({ status: res.status, data: res.data });
  } catch (e) { return err(fmtError(e)); }
});

// 16. POST
server.registerTool("spring_api_post", {
  description: 'Make a POST request to create a resource or trigger an action, e.g. "/api/users".',
  inputSchema: {
    path: z.string().describe("Endpoint path"),
    body: z.record(z.unknown()).optional().describe("JSON request body"),
    headers: z.record(z.string()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ path, body, headers }) => {
  try {
    const res = await client.post(path, body, { headers });
    return ok({ status: res.status, data: res.data });
  } catch (e) { return err(fmtError(e)); }
});

// 17. PUT
server.registerTool("spring_api_put", {
  description: 'Make a PUT request to replace a resource, e.g. "/api/users/123".',
  inputSchema: {
    path: z.string().describe("Endpoint path"),
    body: z.record(z.unknown()).optional(),
    headers: z.record(z.string()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ path, body, headers }) => {
  try {
    const res = await client.put(path, body, { headers });
    return ok({ status: res.status, data: res.data });
  } catch (e) { return err(fmtError(e)); }
});

// 18. PATCH
server.registerTool("spring_api_patch", {
  description: 'Make a PATCH request to partially update a resource, e.g. "/api/users/123".',
  inputSchema: {
    path: z.string().describe("Endpoint path"),
    body: z.record(z.unknown()).optional(),
    headers: z.record(z.string()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ path, body, headers }) => {
  try {
    const res = await client.patch(path, body, { headers });
    return ok({ status: res.status, data: res.data });
  } catch (e) { return err(fmtError(e)); }
});

// 19. DELETE
server.registerTool("spring_api_delete", {
  description: 'Make a DELETE request to remove a resource, e.g. "/api/users/123".',
  inputSchema: {
    path: z.string().describe("Endpoint path"),
    headers: z.record(z.string()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ path, headers }) => {
  try {
    const res = await client.delete(path, { headers });
    return ok({ status: res.status, data: res.data });
  } catch (e) { return err(fmtError(e)); }
});

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 20. JVM summary
server.registerTool("spring_jvm_summary", {
  description: "Combined JVM snapshot: heap used/max, GC pause, active threads, CPU usage, uptime.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  const fetchMetric = async (name) => {
    try {
      const r = await client.get(aUrl(`/metrics/${name}`));
      return (r.data?.measurements ?? []).reduce((acc, m) => {
        acc[m.statistic] = m.value;
        return acc;
      }, {});
    } catch { return null; }
  };
  const [heapUsed, heapMax, gcPause, threads, cpu, uptime] = await Promise.all([
    fetchMetric("jvm.memory.used"),
    fetchMetric("jvm.memory.max"),
    fetchMetric("jvm.gc.pause"),
    fetchMetric("jvm.threads.live"),
    fetchMetric("process.cpu.usage"),
    fetchMetric("process.uptime"),
  ]);
  return ok({ heap: { used: heapUsed, max: heapMax }, gc: { pause: gcPause }, threads, cpu, uptime });
});

// 21. HTTP request stats
server.registerTool("spring_http_stats", {
  description: "HTTP request metrics: count, errors, latency percentiles. Optionally filter by URI or method.",
  inputSchema: {
    uri: z.string().optional().describe('Filter to URI, e.g. "/api/users"'),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ uri, method }) => {
  try {
    const params = {};
    if (uri)    params["tag"] = `uri:${uri}`;
    if (method) params["tag"] = `method:${method}`;
    const res = await client.get(aUrl("/metrics/http.server.requests"), { params });
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 22. Ping
server.registerTool("spring_ping", {
  description: "Quick connectivity check — /actuator/health/ping. Returns latency in ms.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  const start = Date.now();
  try {
    await client.get(aUrl("/health/ping"));
    return ok({ reachable: true, responseMs: Date.now() - start, baseUrl: BASE_URL });
  } catch (e) {
    return ok({ reachable: false, error: fmtError(e), baseUrl: BASE_URL });
  }
});

// 23. DB migrations
server.registerTool("spring_db_migrations", {
  description: "Get migration status from /actuator/flyway or /actuator/liquibase.",
  inputSchema: {
    tool: z.enum(["flyway", "liquibase"]).default("flyway"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ tool }) => {
  try {
    const res = await client.get(aUrl(`/${tool}`));
    return ok(res.data);
  } catch (e) { return err(fmtError(e)); }
});

// 24. Datasource / HikariCP pool
server.registerTool("spring_datasource_pool", {
  description: "Check HikariCP connection pool: active, idle, pending, max, min connections.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  const names = [
    "hikaricp.connections.active",
    "hikaricp.connections.idle",
    "hikaricp.connections.pending",
    "hikaricp.connections.max",
    "hikaricp.connections.min",
  ];
  const results = {};
  await Promise.all(names.map(async (name) => {
    try {
      const r = await client.get(aUrl(`/metrics/${name}`));
      results[name] = r.data?.measurements?.[0]?.value ?? "n/a";
    } catch { results[name] = "n/a"; }
  }));
  return ok(results);
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`spring-boot-mcp ready → ${BASE_URL} (actuator: ${ACTUATOR_BASE})\n`);
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e}\n`);
  process.exit(1);
});
