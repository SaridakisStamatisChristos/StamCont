import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSessionStore } from "./persistence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-pr14-persistence-"),
  );
  roots.push(value);
  return value;
}

async function twoRecordLog(
  base: string,
  sessionId: string,
): Promise<string> {
  const store = await AgentSessionStore.open({
    rootDirectory: base,
    sessionId,
  });
  await store.appendMetadata({ value: 1 });
  await store.appendMetadata({ value: 2 });
  const log = store.paths.log;
  await store.close();
  return log;
}

describe("PR14 persistence corruption hardening", () => {
  it("rejects a duplicate/rollback durable sequence", async () => {
    const base = await root();
    const sessionId = "duplicate-sequence";
    const log = await twoRecordLog(base, sessionId);
    const lines = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[1].sequence = 1;
    await writeFile(
      log,
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf8",
    );

    await expect(
      AgentSessionStore.open({
        rootDirectory: base,
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "corrupt_log" });
  });

  it("rejects a record belonging to another session", async () => {
    const base = await root();
    const sessionId = "wrong-session";
    const log = await twoRecordLog(base, sessionId);
    const lines = (await readFile(log, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[0].sessionId = "other-session";
    await writeFile(
      log,
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf8",
    );

    await expect(
      AgentSessionStore.open({
        rootDirectory: base,
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "corrupt_log" });
  });

  it("treats a valid-looking index with a bad offset as derived stale state and rebuilds it", async () => {
    const base = await root();
    const sessionId = "bad-index-offset";
    const store = await AgentSessionStore.open({
      rootDirectory: base,
      sessionId,
    });
    await store.appendMetadata({ durable: true });
    const indexPath = store.paths.index;
    await store.close();

    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.entries[0].offset += 1;
    await writeFile(indexPath, JSON.stringify(index) + "\n", "utf8");

    const reopened = await AgentSessionStore.open({
      rootDirectory: base,
      sessionId,
    });
    expect(reopened.recovery.indexStatus).toBe("stale");
    expect((await reopened.readRecord(1))?.payload).toEqual({
      durable: true,
    });
    await reopened.close();
  });

  it("keeps the authoritative log committed when derived index replacement fails", async () => {
    const base = await root();
    const sessionId = "index-write-failure";
    const store = await AgentSessionStore.open({
      rootDirectory: base,
      sessionId,
    });
    await store.appendMetadata({ value: "before" });

    await unlink(store.paths.index);
    await mkdir(store.paths.index);
    const appended = await store.appendMetadata({
      value: "after-index-failure",
    });

    expect(appended.sequence).toBe(2);
    expect(store.indexDirty).toBe(true);
    expect(
      (await store.readAllRecords()).map((record) => record.payload),
    ).toEqual([
      { value: "before" },
      { value: "after-index-failure" },
    ]);

    const indexPath = store.paths.index;
    await store.close();
    await rm(indexPath, { recursive: true, force: true });

    const reopened = await AgentSessionStore.open({
      rootDirectory: base,
      sessionId,
    });
    expect(reopened.recovery.indexStatus).toBe("missing");
    expect((await reopened.readRecord(2))?.payload).toEqual({
      value: "after-index-failure",
    });
    await reopened.close();
  });
});
