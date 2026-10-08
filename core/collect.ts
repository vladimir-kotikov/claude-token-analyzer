import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, relative } from "node:path";

import { costOf, type CostBreakdown, type TokenCounts } from "./pricing.ts";

export interface MessageRecord {
  id: string;
  sessionId: string;
  project: string;
  file: string;
  timestamp: string;
  date: string;
  model: string;
  effort: string;
  sessionKind: string;
  isSidechain: boolean;
  tokens: TokenCounts;
  cost: CostBreakdown;
  toolNames: string[];
}

export interface ToolUsageRecord {
  toolUseId: string;
  toolName: string;
  sessionId: string;
  project: string;
  timestamp: string;
  date: string;
  bytes: number;
}

export interface CollectResult {
  messages: MessageRecord[];
  tools: ToolUsageRecord[];
  scannedFiles: number;
  generatedAt: string;
  /** Clusters of sessionIds that share verbatim transcript lines (resume/fork copies one
   *  session's history into a new file under a new id) — detected by transcript-line uuid
   *  collision, since Claude Code writes no explicit cross-session parent-link field for
   *  this case (only subagent sidechains carry a usable parentSessionId). Singleton sessions
   *  are omitted; only groups of 2+ are included. */
  linkGroups: string[][];
}

interface PendingMessage {
  costCounted: boolean;
  sessionId: string;
  project: string;
  file: string;
  timestamp: string;
  model: string;
  effort: string;
  sessionKind: string;
  isSidechain: boolean;
  tokens: TokenCounts;
  toolNames: Set<string>;
}

function listJsonlFiles(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.endsWith(".jsonl")) out.push(join(root, entry));
  }
  return out;
}

function contentByteLength(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  return Buffer.byteLength(JSON.stringify(content ?? ""), "utf8");
}

export async function collectUsage(profileDir: string): Promise<CollectResult> {
  const projectsDir = join(profileDir, "projects");
  const files = listJsonlFiles(projectsDir);

  const messagesById = new Map<string, PendingMessage>();
  const toolIdToName = new Map<string, string>();
  const seenToolResultIds = new Set<string>();
  const tools: ToolUsageRecord[] = [];
  // transcript-line uuid -> sessionId first seen with it; a second, different sessionId
  // seen on the same uuid means that session's file contains a verbatim copy of this line.
  const uuidFirstSession = new Map<string, string>();
  const linkParent = new Map<string, string>(); // union-find over sessionIds

  function findRoot(sid: string): string {
    let root = sid;
    while (linkParent.has(root) && linkParent.get(root) !== root) root = linkParent.get(root)!;
    linkParent.set(sid, root);
    return root;
  }

  function linkSessions(a: string, b: string): void {
    const ra = findRoot(a);
    const rb = findRoot(b);
    if (ra !== rb) linkParent.set(ra, rb);
  }

  function noteUuid(uuid: unknown, sessionId: string): void {
    if (typeof uuid !== "string") return;
    const prior = uuidFirstSession.get(uuid);
    if (prior === undefined) {
      uuidFirstSession.set(uuid, sessionId);
    } else if (prior !== sessionId) {
      linkSessions(prior, sessionId);
    }
  }

  for (const file of files) {
    const projectDirName = relative(projectsDir, file).split("/")[0] ?? "unknown";
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (row.type === "assistant") {
        const message = row.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const id = message.id as string | undefined;
        if (!id) continue;

        const sessionId =
          (row.sessionId as string | undefined) ??
          (row.session_id as string | undefined) ??
          `subagent:${relative(projectsDir, file)}`;
        noteUuid(row.uuid, sessionId);

        let entry = messagesById.get(id);
        if (!entry) {
          entry = {
            costCounted: false,
            sessionId,
            project: (row.cwd as string | undefined) ?? projectDirName,
            file,
            timestamp: row.timestamp as string,
            model: (message.model as string) ?? "claude-sonnet-5",
            effort: (row.effort as string) ?? "high",
            sessionKind: (row.sessionKind as string) ?? "fg",
            isSidechain: Boolean(row.isSidechain),
            tokens: {
              inputTokens: 0,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              outputTokens: 0,
            },
            toolNames: new Set(),
          };
          messagesById.set(id, entry);
        }

        if (!entry.costCounted) {
          const usage = message.usage as Record<string, unknown> | undefined;
          if (usage) {
            const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
            const totalCacheCreation = (usage.cache_creation_input_tokens as number) ?? 0;
            entry.tokens = {
              inputTokens: (usage.input_tokens as number) ?? 0,
              cacheRead: (usage.cache_read_input_tokens as number) ?? 0,
              cacheWrite5m: (cacheCreation?.ephemeral_5m_input_tokens as number) ?? 0,
              cacheWrite1h:
                (cacheCreation?.ephemeral_1h_input_tokens as number) ??
                (cacheCreation ? 0 : totalCacheCreation),
              outputTokens: (usage.output_tokens as number) ?? 0,
            };
            entry.costCounted = true;
          }
        }

        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type === "tool_use" && typeof block.name === "string") {
              entry.toolNames.add(block.name);
              if (typeof block.id === "string") toolIdToName.set(block.id, block.name);
            }
          }
        }
      } else if (row.type === "user") {
        const sessionId =
          (row.sessionId as string | undefined) ??
          (row.session_id as string | undefined) ??
          `subagent:${relative(projectsDir, file)}`;
        noteUuid(row.uuid, sessionId);

        const message = row.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Record<string, unknown>[]) {
          if (block.type !== "tool_result") continue;
          const toolUseId = block.tool_use_id as string | undefined;
          if (!toolUseId || seenToolResultIds.has(toolUseId)) continue;
          seenToolResultIds.add(toolUseId);
          tools.push({
            toolUseId,
            toolName: toolIdToName.get(toolUseId) ?? "unknown",
            sessionId,
            project: (row.cwd as string | undefined) ?? projectDirName,
            timestamp: row.timestamp as string,
            date: String(row.timestamp).slice(0, 10),
            bytes: contentByteLength(block.content),
          });
        }
      }
    }
  }

  const messages: MessageRecord[] = [];
  for (const [id, entry] of messagesById) {
    if (!entry.costCounted) continue;
    messages.push({
      id,
      sessionId: entry.sessionId,
      project: entry.project,
      file: entry.file,
      timestamp: entry.timestamp,
      date: entry.timestamp.slice(0, 10),
      model: entry.model,
      effort: entry.effort,
      sessionKind: entry.sessionKind,
      isSidechain: entry.isSidechain,
      tokens: entry.tokens,
      cost: costOf(entry.model, entry.tokens),
      toolNames: [...entry.toolNames],
    });
  }
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  tools.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const groupsByRoot = new Map<string, Set<string>>();
  for (const sid of linkParent.keys()) {
    const root = findRoot(sid);
    (groupsByRoot.get(root) ?? groupsByRoot.set(root, new Set()).get(root)!).add(sid);
  }
  const linkGroups = [...groupsByRoot.values()].filter((g) => g.size > 1).map((g) => [...g]);

  return {
    messages,
    tools,
    scannedFiles: files.length,
    generatedAt: new Date().toISOString(),
    linkGroups,
  };
}
