import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { z } from "zod";

// ─── Config from env ─────────────────────────────────────────────────────────
const BASE_URL = process.env.SPRING_BASE_URL ?? "http://localhost:8080";
const ACTUATOR_BASE = process.env.SPRING_ACTUATOR_PATH ?? "/actuator";
const USERNAME = process.env.SPRING_USERNAME;
const PASSWORD = process.env.SPRING_PASSWORD;
const BEARER_TOKEN = process.env.SPRING_BEARER_TOKEN;
const TIMEOUT_MS = parseInt(process.env.SPRING_TIMEOUT_MS ?? "10000", 10);

// ─── Axios client factory ─────────────────────────────────────────────────────
function makeClient(baseURL: string): AxiosInstance {
  const cfg: AxiosRequestConfig = { baseURL, timeout: TIMEOUT_MS };
  if (BEARER_TOKEN) {
    cfg.headers = { Authorization: `Bearer ${BEARER_TOKEN}` };
  } else if (USERNAME && PASSWORD) {
    cfg.auth = { username: USERNAME, password: PASSWORD };
  }
  return axios.create(cfg);
}

const client = makeClient(BASE_URL);

function actuatorUrl(path: string): string {
  return `${ACTUATOR_BASE}${path}`;
}

function fmtError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? "no-response";
    const body = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    return `HTTP ${status}: ${body}`;
  }
  return String(err);
}

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(msg: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true };
}

// ─── Server setup ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "spring-boot-mcp",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════════════════
// ACTUATOR TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 1. Health
server.registerTool(
  "spring_health",
  {
    description:
      "Get the health status of the Spring Boot application via /actuator/health. Shows UP/DOWN status and details of health components (DB, disk, custom indicators).",
    inputSchema: {
      showDetails: z
        .boolean()
        .optional()
        .default(true)
        .describe("Append /detail to get full component breakdown"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ showDetails }) => {
    try {
      const path = showDetails ? actuatorUrl("/health") : actuatorUrl("/health");
      const res = await client.get(path);
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 2. Info
server.registerTool(
  "spring_info",
  {
    description:
      "Get application info from /actuator/info — version, build time, git commit, and any custom info beans.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const res = await client.get(actuatorUrl("/info"));
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 3. Metrics list
server.registerTool(
  "spring_metrics_list",
  {
    description:
      "List all available metrics names from /actuator/metrics. Use this to discover what metrics the app exposes before calling spring_metric_get.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const res = await client.get(actuatorUrl("/metrics"));
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 4. Get specific metric
server.registerTool(
  "spring_metric_get",
  {
    description:
      "Get the value of a specific metric from /actuator/metrics/{name}. Optionally filter by tags (e.g. uri=/api/users).",
    inputSchema: {
      name: z
        .string()
        .describe('Metric name, e.g. "jvm.memory.used" or "http.server.requests"'),
      tags: z
        .string()
        .optional()
        .describe(
          'Comma-separated tag filters, e.g. "uri=/api/orders,method=GET"'
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ name, tags }) => {
    try {
      const params: Record<string, string> = {};
      if (tags) {
        // Actuator expects ?tag=key:value&tag=key2:value2
        tags.split(",").forEach((t) => {
          params[`tag`] = t.trim().replace("=", ":");
        });
      }
      const res = await client.get(actuatorUrl(`/metrics/${name}`), { params });
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 5. Environment
server.registerTool(
  "spring_env",
  {
    description:
      "Get environment properties from /actuator/env. Optionally filter by a key prefix to narrow results.",
    inputSchema: {
      prefix: z
        .string()
        .optional()
        .describe('Key prefix to filter, e.g. "spring.datasource" or "server"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ prefix }) => {
    try {
      const path = prefix
        ? actuatorUrl(`/env/${prefix}`)
        : actuatorUrl("/env");
      const res = await client.get(path);
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 6. Beans
server.registerTool(
  "spring_beans",
  {
    description:
      "List all Spring beans registered in the application context from /actuator/beans. Shows bean name, type, scope, dependencies, and aliases.",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter on bean names, e.g. 'Controller' or 'Repository'"
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ filter }) => {
    try {
      const res = await client.get(actuatorUrl("/beans"));
      const data = res.data as Record<string, unknown>;

      if (!filter) return ok(data);

      // Filter beans by name substring
      const lower = filter.toLowerCase();
      const contexts = (
        data as {
          contexts: Record<
            string,
            { beans: Record<string, unknown> }
          >;
        }
      ).contexts;
      const filtered: Record<string, unknown> = {};
      for (const [ctx, ctxData] of Object.entries(contexts ?? {})) {
        const matching: Record<string, unknown> = {};
        for (const [beanName, beanDef] of Object.entries(ctxData.beans ?? {})) {
          if (beanName.toLowerCase().includes(lower)) {
            matching[beanName] = beanDef;
          }
        }
        if (Object.keys(matching).length > 0) {
          filtered[ctx] = { beans: matching };
        }
      }
      return ok(filtered);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 7. Request Mappings
server.registerTool(
  "spring_mappings",
  {
    description:
      "List all HTTP request mappings (endpoints) from /actuator/mappings. Shows method, path, handler class, and media types. Filter by path substring if needed.",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe('Filter mappings by path substring, e.g. "/api/users"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ filter }) => {
    try {
      const res = await client.get(actuatorUrl("/mappings"));
      if (!filter) return ok(res.data);

      // Flatten and filter
      const lower = filter.toLowerCase();
      const result: unknown[] = [];
      const traverse = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const obj = node as Record<string, unknown>;
        if (obj.predicate && JSON.stringify(obj.predicate).toLowerCase().includes(lower)) {
          result.push(obj);
        }
        for (const v of Object.values(obj)) traverse(v);
      };
      traverse(res.data);
      return ok(result);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 8. Thread Dump
server.registerTool(
  "spring_threaddump",
  {
    description:
      "Get a thread dump from /actuator/threaddump. Shows all JVM threads, their states (RUNNABLE, WAITING, BLOCKED), and stack traces. Useful for diagnosing deadlocks or high CPU.",
    inputSchema: {
      stateFilter: z
        .enum(["RUNNABLE", "WAITING", "TIMED_WAITING", "BLOCKED", "ALL"])
        .optional()
        .default("ALL")
        .describe("Filter threads by state"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ stateFilter }) => {
    try {
      const res = await client.get(actuatorUrl("/threaddump"));
      if (stateFilter === "ALL") return ok(res.data);

      const threads = (res.data as { threads: Array<{ threadState: string }> }).threads ?? [];
      const filtered = threads.filter((t) => t.threadState === stateFilter);
      return ok({ threads: filtered, total: threads.length, shown: filtered.length });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 9. Heap Dump trigger (just returns download guidance — not binary)
server.registerTool(
  "spring_heapdump_url",
  {
    description:
      "Returns the URL to download a heap dump from /actuator/heapdump. Use curl or a browser to actually download it — it is a binary HPROF file.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    return ok({
      url: `${BASE_URL}${ACTUATOR_BASE}/heapdump`,
      instructions:
        "Run: curl -o heapdump.hprof " +
        `${BASE_URL}${ACTUATOR_BASE}/heapdump` +
        " — then open with Eclipse MAT or VisualVM.",
    });
  }
);

// 10. Loggers
server.registerTool(
  "spring_loggers_list",
  {
    description:
      "List all loggers and their configured/effective log levels from /actuator/loggers.",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe('Filter logger names by substring, e.g. "com.mycompany"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ filter }) => {
    try {
      const res = await client.get(actuatorUrl("/loggers"));
      if (!filter) return ok(res.data);

      const lower = filter.toLowerCase();
      const loggers = (
        res.data as { loggers: Record<string, unknown> }
      ).loggers ?? {};
      const filtered: Record<string, unknown> = {};
      for (const [name, lvl] of Object.entries(loggers)) {
        if (name.toLowerCase().includes(lower)) filtered[name] = lvl;
      }
      return ok(filtered);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 11. Set log level (runtime)
server.registerTool(
  "spring_logger_set_level",
  {
    description:
      "Change the log level of a specific logger at runtime via POST /actuator/loggers/{name}. Changes take effect immediately without restart.",
    inputSchema: {
      loggerName: z
        .string()
        .describe('Logger name, e.g. "com.mycompany.service" or "ROOT"'),
      level: z
        .enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "OFF"])
        .describe("New log level"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ loggerName, level }) => {
    try {
      await client.post(actuatorUrl(`/loggers/${loggerName}`), {
        configuredLevel: level,
      });
      return ok({ success: true, logger: loggerName, level });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 12. Scheduled tasks
server.registerTool(
  "spring_scheduledtasks",
  {
    description:
      "List scheduled tasks (cron, fixed-rate, fixed-delay) from /actuator/scheduledtasks.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const res = await client.get(actuatorUrl("/scheduledtasks"));
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 13. Cache list
server.registerTool(
  "spring_caches",
  {
    description:
      "List all Spring caches from /actuator/caches. Shows cache names and their cache manager.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const res = await client.get(actuatorUrl("/caches"));
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 14. Evict cache
server.registerTool(
  "spring_cache_evict",
  {
    description:
      "Evict (clear) a specific cache or all caches via DELETE /actuator/caches/{name}.",
    inputSchema: {
      cacheName: z
        .string()
        .optional()
        .describe("Cache name to evict. Omit to evict ALL caches."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ cacheName }) => {
    try {
      const path = cacheName
        ? actuatorUrl(`/caches/${cacheName}`)
        : actuatorUrl("/caches");
      await client.delete(path);
      return ok({ evicted: cacheName ?? "ALL" });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
// REST API TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 15. GET request
server.registerTool(
  "spring_api_get",
  {
    description:
      "Make a GET request to any REST endpoint of the Spring Boot app. Good for reading resources, listing collections, or checking API responses.",
    inputSchema: {
      path: z.string().describe('Endpoint path, e.g. "/api/users" or "/api/orders/123"'),
      params: z
        .record(z.string())
        .optional()
        .describe('Query parameters, e.g. {"page": "0", "size": "20"}'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Additional request headers, e.g. {"Accept": "application/json"}'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ path, params, headers }) => {
    try {
      const res = await client.get(path, { params, headers });
      return ok({ status: res.status, data: res.data });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 16. POST request
server.registerTool(
  "spring_api_post",
  {
    description:
      "Make a POST request to create a resource or trigger an action on the Spring Boot app.",
    inputSchema: {
      path: z.string().describe('Endpoint path, e.g. "/api/users"'),
      body: z
        .record(z.unknown())
        .optional()
        .describe("JSON request body"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Additional request headers"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ path, body, headers }) => {
    try {
      const res = await client.post(path, body, { headers });
      return ok({ status: res.status, data: res.data });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 17. PUT request
server.registerTool(
  "spring_api_put",
  {
    description:
      "Make a PUT request to update a resource on the Spring Boot app.",
    inputSchema: {
      path: z.string().describe('Endpoint path, e.g. "/api/users/123"'),
      body: z
        .record(z.unknown())
        .optional()
        .describe("JSON request body"),
      headers: z.record(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ path, body, headers }) => {
    try {
      const res = await client.put(path, body, { headers });
      return ok({ status: res.status, data: res.data });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 18. PATCH request
server.registerTool(
  "spring_api_patch",
  {
    description:
      "Make a PATCH request to partially update a resource on the Spring Boot app.",
    inputSchema: {
      path: z.string().describe('Endpoint path, e.g. "/api/users/123"'),
      body: z.record(z.unknown()).optional(),
      headers: z.record(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ path, body, headers }) => {
    try {
      const res = await client.patch(path, body, { headers });
      return ok({ status: res.status, data: res.data });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 19. DELETE request
server.registerTool(
  "spring_api_delete",
  {
    description:
      "Make a DELETE request to remove a resource on the Spring Boot app.",
    inputSchema: {
      path: z.string().describe('Endpoint path, e.g. "/api/users/123"'),
      headers: z.record(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ path, headers }) => {
    try {
      const res = await client.delete(path, { headers });
      return ok({ status: res.status, data: res.data });
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC TOOLS
// ════════════════════════════════════════════════════════════════════════════

// 20. JVM summary
server.registerTool(
  "spring_jvm_summary",
  {
    description:
      "Get a combined JVM health summary: heap used/max, GC pause time, active threads, CPU usage, and uptime. Aggregates multiple metrics into one view.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const fetch = async (name: string): Promise<unknown> => {
      try {
        const r = await client.get(actuatorUrl(`/metrics/${name}`));
        const measurements = (r.data as { measurements: Array<{ statistic: string; value: number }> }).measurements ?? [];
        return measurements.reduce<Record<string, number>>((acc, m) => {
          acc[m.statistic] = m.value;
          return acc;
        }, {});
      } catch {
        return null;
      }
    };

    const [heapUsed, heapMax, gcPause, threads, cpuProcess, uptime] =
      await Promise.all([
        fetch("jvm.memory.used"),
        fetch("jvm.memory.max"),
        fetch("jvm.gc.pause"),
        fetch("jvm.threads.live"),
        fetch("process.cpu.usage"),
        fetch("process.uptime"),
      ]);

    return ok({
      heap: { used: heapUsed, max: heapMax },
      gc: { pause: gcPause },
      threads,
      cpu: cpuProcess,
      uptime,
    });
  }
);

// 21. HTTP request stats
server.registerTool(
  "spring_http_stats",
  {
    description:
      "Get HTTP request statistics: total count, error rate, and percentile latencies (50p, 95p, 99p) across all endpoints or for a specific URI.",
    inputSchema: {
      uri: z
        .string()
        .optional()
        .describe('Filter to a specific URI, e.g. "/api/users"'),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
        .optional()
        .describe("Filter by HTTP method"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ uri, method }) => {
    try {
      const params: Record<string, string> = {};
      if (uri) params["tag"] = `uri:${uri}`;
      if (method) params["tag"] = `method:${method}`;

      const res = await client.get(actuatorUrl("/metrics/http.server.requests"), {
        params,
      });
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 22. Connectivity check
server.registerTool(
  "spring_ping",
  {
    description:
      "Quick connectivity check — calls /actuator/health/ping to verify the app is reachable and responding.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const start = Date.now();
    try {
      await client.get(actuatorUrl("/health/ping"));
      return ok({ reachable: true, responseMs: Date.now() - start, baseUrl: BASE_URL });
    } catch (e) {
      return ok({ reachable: false, error: fmtError(e), baseUrl: BASE_URL });
    }
  }
);

// 23. Flyway / Liquibase migration status
server.registerTool(
  "spring_db_migrations",
  {
    description:
      "Get database migration status from /actuator/flyway or /actuator/liquibase. Shows applied, pending, and failed migrations.",
    inputSchema: {
      tool: z
        .enum(["flyway", "liquibase"])
        .default("flyway")
        .describe("Database migration tool in use"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ tool }) => {
    try {
      const res = await client.get(actuatorUrl(`/${tool}`));
      return ok(res.data);
    } catch (e) {
      return err(fmtError(e));
    }
  }
);

// 24. Datasource / connection pool
server.registerTool(
  "spring_datasource_pool",
  {
    description:
      "Check HikariCP (or other JDBC pool) metrics: active connections, idle, pending, max pool size.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const metricNames = [
      "hikaricp.connections.active",
      "hikaricp.connections.idle",
      "hikaricp.connections.pending",
      "hikaricp.connections.max",
      "hikaricp.connections.min",
    ];

    const results: Record<string, unknown> = {};
    await Promise.all(
      metricNames.map(async (name) => {
        try {
          const r = await client.get(actuatorUrl(`/metrics/${name}`));
          const val = (
            r.data as { measurements: Array<{ value: number }> }
          ).measurements?.[0]?.value;
          results[name] = val;
        } catch {
          results[name] = "n/a";
        }
      })
    );
    return ok(results);
  }
);

// ─── Start transport ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `spring-boot-mcp connected → ${BASE_URL} (actuator: ${ACTUATOR_BASE})\n`
  );
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e}\n`);
  process.exit(1);
});
