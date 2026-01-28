// Deno Deploy entrypoint.
//
// This repo is primarily a Go project; Deno Deploy can only run Deno/JS/TS.
// We run the Go server as a subprocess and proxy HTTP/WebSocket traffic to it.

const textEncoder = new TextEncoder();

function envGet(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = Deno.env.get(key);
    if (value && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `dd_${b64.replaceAll(/[+/=]/g, "").slice(0, 32)}`;
}

function minimalConfigYAML(opts: {
  host: string;
  port: number;
  authDir: string;
  apiKeys: string[];
  mgmtKey?: string;
}): string {
  const apiKeys = opts.apiKeys.length ? opts.apiKeys : ["deno-deploy-dev-key"];
  const mgmtBlock = opts.mgmtKey
    ? [
      "remote-management:",
      "  allow-remote: true",
      `  secret-key: "${opts.mgmtKey.replaceAll('"', '\\"')}"`,
      "  disable-control-panel: false",
    ].join("\n")
    : [
      "remote-management:",
      "  allow-remote: true",
      "  secret-key: \"\"",
      "  disable-control-panel: false",
    ].join("\n");

  return [
    `host: "${opts.host}"`,
    `port: ${opts.port}`,
    mgmtBlock,
    `auth-dir: "${opts.authDir.replaceAll('"', '\\"')}"`,
    "api-keys:",
    ...apiKeys.map((k) => `  - "${k.replaceAll('"', '\\"')}"`),
    "debug: false",
    "logging-to-file: false",
  ].join("\n") + "\n";
}

function hopByHopHeaderNames(): Set<string> {
  // RFC 7230, 6.1
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
}

function stripHopByHopHeaders(headers: Headers): Headers {
  const out = new Headers();
  const hop = hopByHopHeaderNames();
  for (const [k, v] of headers) {
    if (!hop.has(k.toLowerCase())) out.set(k, v);
  }
  // Remove any headers listed in "Connection"
  const connection = headers.get("connection");
  if (connection) {
    for (const token of connection.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      out.delete(token);
    }
  }
  return out;
}

function defaultBinaryPath(): string {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  if (os === "linux" && arch === "x86_64") return "./deno/bin/cli-proxy-api-plus_linux_amd64";
  if (os === "linux" && arch === "aarch64") return "./deno/bin/cli-proxy-api-plus_linux_arm64";
  return "./deno/bin/cli-proxy-api-plus";
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, textEncoder.encode(contents));
  await Deno.rename(tmp, path);
}

async function startBackend(opts: {
  binaryPath: string;
  configPath: string;
  backendPort: number;
  extraEnv: Record<string, string>;
}): Promise<Deno.ChildProcess> {
  const cmd = new Deno.Command(opts.binaryPath, {
    args: ["-config", opts.configPath],
    env: {
      ...opts.extraEnv,
      DEPLOY: "cloud",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();

  // Basic readiness probe: we only need the listener up (any HTTP response is fine).
  const probeUrl = `http://127.0.0.1:${opts.backendPort}/`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) break;
    try {
      const res = await fetch(probeUrl, { method: "GET" });
      res.body?.cancel();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return child;
}

const backendPort = Number.parseInt(envGet("CLI_PROXY_BACKEND_PORT", "BACKEND_PORT") ?? "18080", 10);
const backendHost = "127.0.0.1";
const backendBase = `http://${backendHost}:${backendPort}`;

const configYAML = envGet("CLI_PROXY_CONFIG_YAML", "CONFIG_YAML");
const configURL = envGet("CLI_PROXY_CONFIG_URL", "CONFIG_URL");
const apiKeysFromEnv = splitList(envGet("CLI_PROXY_API_KEYS", "API_KEYS"));
const mgmtKey = envGet("CLI_PROXY_MGMT_KEY", "MGMT_KEY");
const binaryPath = envGet("CLI_PROXY_BINARY_PATH") ?? defaultBinaryPath();

const workDir = await Deno.makeTempDir({ prefix: "cliproxy-deno-deploy-" });
const authDir = `${workDir}/auths`;
const configPath = `${workDir}/config.yaml`;

let effectiveApiKeys = apiKeysFromEnv;
if (effectiveApiKeys.length === 0) {
  effectiveApiKeys = [envGet("CLI_PROXY_API_KEY", "API_KEY") ?? "deno-deploy-dev-key"];
}

if (configYAML) {
  await writeFileAtomic(configPath, configYAML);
} else if (configURL) {
  const res = await fetch(configURL);
  if (!res.ok) {
    throw new Error(`Failed to download config from CONFIG_URL: ${res.status} ${res.statusText}`);
  }
  await writeFileAtomic(configPath, await res.text());
} else {
  await writeFileAtomic(
    configPath,
    minimalConfigYAML({
      host: backendHost,
      port: backendPort,
      authDir,
      apiKeys: effectiveApiKeys,
      mgmtKey,
    }),
  );
  console.log("[deno-deploy] No config provided; generated a minimal config.");
}

console.log(`[deno-deploy] Backend port: ${backendPort}`);
console.log(`[deno-deploy] Using binary: ${binaryPath}`);
console.log(`[deno-deploy] Using config: ${configPath}`);
console.log(`[deno-deploy] API keys: ${effectiveApiKeys.join(", ")}`);

let backend = await startBackend({
  binaryPath,
  configPath,
  backendPort,
  extraEnv: {
    // Ensure any app code that respects this can store data in the temp dir.
    WRITABLE_PATH: workDir,
  },
});

async function proxyHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(backendBase);
  target.pathname = url.pathname;
  target.search = url.search;

  const headers = stripHopByHopHeaders(req.headers);
  headers.set("host", `${backendHost}:${backendPort}`);

  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  };

  const res = await fetch(target, init);
  const outHeaders = stripHopByHopHeaders(res.headers);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

async function proxyWebSocket(req: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(req);

  const url = new URL(req.url);
  const target = new URL(backendBase.replace("http://", "ws://"));
  target.pathname = url.pathname;
  target.search = url.search;

  const backendWs = new WebSocket(target);

  const closeBoth = (code?: number, reason?: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // ignore
    }
    try {
      backendWs.close(code, reason);
    } catch {
      // ignore
    }
  };

  backendWs.addEventListener("open", () => {
    socket.addEventListener("message", (e) => backendWs.send(e.data));
    socket.addEventListener("close", (e) => closeBoth(e.code, e.reason));
    socket.addEventListener("error", () => closeBoth(1011, "client error"));
  });
  backendWs.addEventListener("message", (e) => socket.send(e.data));
  backendWs.addEventListener("close", (e) => closeBoth(e.code, e.reason));
  backendWs.addEventListener("error", () => closeBoth(1011, "backend error"));

  return response;
}

function setupPage(): Response {
  const example = [
    "port: 18080",
    "host: \"127.0.0.1\"",
    "api-keys:",
    "  - \"your-api-key\"",
    "",
    "# ...add your provider credentials here...",
  ].join("\n");

  const body = [
    "CLIProxyAPI Plus on Deno Deploy",
    "",
    "This repo is a Go server. On Deno Deploy we run the Go binary as a subprocess and proxy traffic to it.",
    "",
    "Configure via environment variables in Deno Deploy:",
    "- CONFIG_YAML (recommended): full contents of config.yaml",
    "- or CONFIG_URL: URL that returns config.yaml",
    "- optional: API_KEYS / API_KEY, MGMT_KEY",
    "",
    "Minimal config example:",
    example,
    "",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Lightweight setup page (doesn't depend on backend).
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/__setup")) {
    return setupPage();
  }

  // Restart backend if it crashed.
  if (backend.status !== "running") {
    console.warn("[deno-deploy] backend exited; restarting");
    try {
      backend.kill("SIGTERM");
    } catch {
      // ignore
    }
    backend = await startBackend({
      binaryPath,
      configPath,
      backendPort,
      extraEnv: { WRITABLE_PATH: workDir, DEPLOY: "cloud" },
    });
  }

  // WebSocket proxy
  const upgrade = req.headers.get("upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    try {
      return await proxyWebSocket(req);
    } catch {
      return new Response("WebSocket proxy error", { status: 502 });
    }
  }

  try {
    return await proxyHttp(req);
  } catch {
    return new Response("Backend unavailable. Visit / for setup.", { status: 502 });
  }
});

