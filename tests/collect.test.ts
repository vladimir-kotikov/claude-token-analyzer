import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it, describe } from "node:test";

import { collectUsage } from "../core/collect.ts";

describe("collectUsage", () => {
  let profileDir: string;

  before(() => {
    profileDir = mkdtempSync(join(tmpdir(), "claude-usage-test-"));
    const projectDir = join(profileDir, "projects", "-Users-test-repo");
    mkdirSync(projectDir, { recursive: true });

    const assistantLine = (overrides = {}) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        cwd: "/Users/test/repo",
        effort: "high",
        sessionKind: "fg",
        isSidechain: false,
        timestamp: "2026-09-05T10:00:00.000Z",
        message: {
          id: "msg-1",
          model: "claude-sonnet-5",
          content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: {} }],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 1000,
            output_tokens: 50,
            cache_creation_input_tokens: 2000,
            cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
          },
        },
        ...overrides,
      });

    const toolResultLine = JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      cwd: "/Users/test/repo",
      timestamp: "2026-09-05T10:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "x".repeat(500) }],
      },
    });

    // Main session file: one assistant turn (usage) + its tool result.
    writeFileSync(
      join(projectDir, "sess-1.jsonl"),
      [assistantLine(), toolResultLine].join("\n") + "\n",
    );

    // Simulated forked/resumed copy of the same session: same message id and
    // tool_use id must NOT be double-counted.
    writeFileSync(
      join(projectDir, "sess-1-forked.jsonl"),
      [assistantLine(), toolResultLine].join("\n") + "\n",
    );
  });

  after(() => rmSync(profileDir, { recursive: true, force: true }));

  it("dedupes messages and tool results by id across duplicate/forked transcript files", async () => {
    const result = await collectUsage(profileDir);
    assert.equal(result.messages.length, 1, "same message.id in two files must count once");
    assert.equal(result.tools.length, 1, "same tool_use_id in two files must count once");
  });

  it("computes cost from usage tokens at the sonnet-5 rate table", async () => {
    const result = await collectUsage(profileDir);
    const [msg] = result.messages;
    // input 100 * $2/M + cache_read 1000 * $0.2/M + cache_write_1h 2000 * $4/M + output 50 * $10/M
    const expected = (100 * 2 + 1000 * 0.2 + 2000 * 4 + 50 * 10) / 1e6;
    assert.ok(
      Math.abs(msg.cost.total - expected) < 1e-9,
      `expected ${expected}, got ${msg.cost.total}`,
    );
    assert.deepEqual(msg.toolNames, ["Bash"]);
  });

  it("attributes tool_result byte size to the tool that produced it", async () => {
    const result = await collectUsage(profileDir);
    assert.equal(result.tools[0].toolName, "Bash");
    assert.equal(result.tools[0].bytes, 500);
  });
});

describe("collectUsage linkGroups", () => {
  let profileDir: string;

  before(() => {
    profileDir = mkdtempSync(join(tmpdir(), "claude-usage-link-test-"));
    const projectDir = join(profileDir, "projects", "-Users-test-repo");
    mkdirSync(projectDir, { recursive: true });

    // A real resume/fork copies a prefix of one session's transcript lines verbatim
    // (same uuid, same content) into a new file under a NEW sessionId, then diverges.
    // sess-a and sess-b share one line's uuid ("shared-uuid-1"); each also has its own
    // uuid-less divergent turn. sess-c is unrelated and must not be linked to either.
    const line = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        type: "assistant",
        cwd: "/Users/test/repo",
        effort: "high",
        sessionKind: "fg",
        isSidechain: false,
        timestamp: "2026-09-05T10:00:00.000Z",
        message: { id: overrides.id, model: "claude-sonnet-5", content: [], usage: { input_tokens: 1 } },
        ...overrides,
      });

    writeFileSync(
      join(projectDir, "sess-a.jsonl"),
      [
        line({ sessionId: "sess-a", uuid: "shared-uuid-1", id: "msg-a1" }),
        line({ sessionId: "sess-a", uuid: "own-uuid-a2", id: "msg-a2" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(projectDir, "sess-b.jsonl"),
      [
        line({ sessionId: "sess-b", uuid: "shared-uuid-1", id: "msg-a1" }),
        line({ sessionId: "sess-b", uuid: "own-uuid-b2", id: "msg-b2" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(projectDir, "sess-c.jsonl"),
      [line({ sessionId: "sess-c", uuid: "own-uuid-c1", id: "msg-c1" })].join("\n") + "\n",
    );
  });

  after(() => rmSync(profileDir, { recursive: true, force: true }));

  it("groups sessions that share a transcript-line uuid, and excludes unrelated sessions", async () => {
    const result = await collectUsage(profileDir);
    assert.equal(result.linkGroups.length, 1);
    assert.deepEqual(new Set(result.linkGroups[0]), new Set(["sess-a", "sess-b"]));
  });
});
