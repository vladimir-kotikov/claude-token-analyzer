#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectUsage, type CollectResult } from "../core/collect.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

function flag(name: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

const profileDir = flag("profile", join(homedir(), ".claude"));
const port = Number(flag("port", "4790"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let cache: CollectResult | undefined;

async function loadUsage(): Promise<CollectResult> {
  console.error(`Scanning ${profileDir}/projects ...`);
  const start = Date.now();
  const result = await collectUsage(profileDir);
  console.error(
    `Scanned ${result.scannedFiles} files, ${result.messages.length} messages, ${result.tools.length} tool calls in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return result;
}

cache = await loadUsage();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/data") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    res.end(JSON.stringify(cache));
    return;
  }

  if (url.pathname === "/api/refresh" && req.method === "POST") {
    cache = await loadUsage();
    res.writeHead(200, { "content-type": MIME[".json"] });
    res.end(JSON.stringify({ ok: true, generatedAt: cache.generatedAt }));
    return;
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(publicDir, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(port, () => {
  console.error(`claude-usage dashboard: http://localhost:${port}  (profile: ${profileDir})`);
});
