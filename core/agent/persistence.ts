import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  truncate,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";

import type {
  AgentModelInputItem,
  AgentModelMessageInput,
  AgentToolResult,
} from "./model";
import type { AgentRunEvent, JsonObject } from "./protocol";
import {
  createInitialAgentRunState,
  getLatestAgentResponse,
  reduceAgentRunEvent,
  type AgentRunState,
} from "./reducer";

export const AGENT_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export const AGENT_PERSISTED_RECORD_KINDS = [
  "model_input",
  "model_event",
  "tool_result",
  "lifecycle",
  "metadata",
] as const;

export type AgentPersistedRecordKind =
  (typeof AGENT_PERSISTED_RECORD_KINDS)[number];

export interface AgentPersistedRecord {
  readonly schemaVersion: typeof AGENT_PERSISTENCE_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: AgentPersistedRecordKind;
  readonly payload: unknown;
  readonly [key: string]: unknown;
}

interface AgentSessionIndexEntry {
  readonly sequence: number;
  readonly offset: number;
  readonly length: number;
}

interface AgentSessionIndex {
  readonly schemaVersion: typeof AGENT_PERSISTENCE_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly logSize: number;
  readonly entries: readonly AgentSessionIndexEntry[];
}

export interface AgentSessionSnapshot<T = unknown> {
  readonly schemaVersion: typeof AGENT_PERSISTENCE_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly logSequence: number;
  readonly createdAt: number;
  readonly state: T;
  readonly [key: string]: unknown;
}

export type AgentSessionSnapshotStatus =
  | "missing"
  | "fresh"
  | "stale"
  | "corrupt";

export interface AgentSessionSnapshotReadResult<T = unknown> {
  readonly status: AgentSessionSnapshotStatus;
  readonly snapshot?: AgentSessionSnapshot<T>;
  readonly error?: AgentPersistenceError;
}

export type AgentSessionIndexRecoveryStatus =
  | "valid"
  | "missing"
  | "stale"
  | "corrupt";

export interface AgentSessionRecoveryInfo {
  readonly indexStatus: AgentSessionIndexRecoveryStatus;
  readonly truncatedTailBytes: number;
}

export interface AgentSessionReplay {
  readonly records: readonly AgentPersistedRecord[];
  readonly runState: AgentRunState;
  readonly input: readonly AgentModelInputItem[];
  readonly lastSequence: number;
  readonly lifecycle?: JsonObject;
  readonly metadata: readonly JsonObject[];
}

export type AgentPersistenceErrorCode =
  | "invalid_session_id"
  | "session_writer_active"
  | "unsupported_schema"
  | "corrupt_log"
  | "corrupt_snapshot"
  | "invalid_json_value"
  | "store_closed";

export class AgentPersistenceError extends Error {
  constructor(
    readonly code: AgentPersistenceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentPersistenceError";
  }
}

export interface AgentSessionStoreOpenOptions {
  readonly rootDirectory: string;
  readonly sessionId: string;
}

export interface AgentSessionPaths {
  readonly directory: string;
  readonly log: string;
  readonly index: string;
  readonly snapshot: string;
}

interface ScannedLog {
  readonly records: readonly AgentPersistedRecord[];
  readonly entries: readonly AgentSessionIndexEntry[];
  readonly completeBytes: number;
  readonly truncatedTailBytes: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const activeWriters = new Set<string>();
let tempCounter = 0;

export class AgentSessionStore {
  readonly sessionId: string;
  readonly paths: AgentSessionPaths;
  readonly recovery: AgentSessionRecoveryInfo;

  private lastSequenceValue: number;
  private logSize: number;
  private indexEntries: AgentSessionIndexEntry[];
  private writeQueue: Promise<void> = Promise.resolve();
  private indexDirtyValue: boolean;
  private closing = false;
  private closed = false;

  private constructor(
    sessionId: string,
    paths: AgentSessionPaths,
    recovery: AgentSessionRecoveryInfo,
    lastSequence: number,
    logSize: number,
    indexEntries: readonly AgentSessionIndexEntry[],
    indexDirty: boolean,
  ) {
    this.sessionId = sessionId;
    this.paths = paths;
    this.recovery = recovery;
    this.lastSequenceValue = lastSequence;
    this.logSize = logSize;
    this.indexEntries = [...indexEntries];
    this.indexDirtyValue = indexDirty;
  }

  static async open(
    options: AgentSessionStoreOpenOptions,
  ): Promise<AgentSessionStore> {
    const sessionId = validateSessionId(options.sessionId);
    const paths = resolveSessionPaths(options.rootDirectory, sessionId);
    const writerKey = path.resolve(paths.directory);

    if (activeWriters.has(writerKey)) {
      throw new AgentPersistenceError(
        "session_writer_active",
        "Agent session " + sessionId + " already has an active writer in this process",
      );
    }
    activeWriters.add(writerKey);

    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
      await restrictPermissions(paths.directory, 0o700);
      await ensureDurableFile(paths.log);
      await syncDirectory(paths.directory);

      const scanned = await scanAndRecoverLog(paths.log, sessionId);
      const indexStatus = await readIndexStatus(
        paths.index,
        sessionId,
        scanned,
      );
      let indexDirty = false;
      if (indexStatus !== "valid") {
        try {
          await writeIndexAtomic(paths.index, sessionId, scanned);
        } catch {
          indexDirty = true;
        }
      }

      return new AgentSessionStore(
        sessionId,
        paths,
        {
          indexStatus,
          truncatedTailBytes: scanned.truncatedTailBytes,
        },
        scanned.records.at(-1)?.sequence ?? 0,
        scanned.completeBytes,
        scanned.entries,
        indexDirty,
      );
    } catch (error) {
      activeWriters.delete(writerKey);
      throw error;
    }
  }

  get lastSequence(): number {
    return this.lastSequenceValue;
  }

  get indexDirty(): boolean {
    return this.indexDirtyValue;
  }

  async appendModelInput(
    input: AgentModelMessageInput,
  ): Promise<AgentPersistedRecord> {
    return this.append("model_input", input);
  }

  async appendModelEvent(event: AgentRunEvent): Promise<AgentPersistedRecord> {
    return this.append("model_event", event);
  }

  async appendToolResult(
    result: AgentToolResult,
  ): Promise<AgentPersistedRecord> {
    return this.append("tool_result", result);
  }

  async appendLifecycle(payload: JsonObject): Promise<AgentPersistedRecord> {
    return this.append("lifecycle", payload);
  }

  async appendMetadata(payload: JsonObject): Promise<AgentPersistedRecord> {
    return this.append("metadata", payload);
  }

  async append(
    kind: AgentPersistedRecordKind,
    payload: unknown,
  ): Promise<AgentPersistedRecord> {
    return this.enqueueWrite(async () => {
      assertJsonValue(payload);
      const record: AgentPersistedRecord = {
        schemaVersion: AGENT_PERSISTENCE_SCHEMA_VERSION,
        sessionId: this.sessionId,
        sequence: this.lastSequenceValue + 1,
        kind,
        payload,
      };
      const encoded = encodeJsonLine(record);
      const entry: AgentSessionIndexEntry = {
        sequence: record.sequence,
        offset: this.logSize,
        length: Buffer.byteLength(encoded),
      };

      await appendDurably(this.paths.log, encoded);

      this.lastSequenceValue = record.sequence;
      this.logSize += entry.length;
      this.indexEntries.push(entry);

      try {
        await writeIndexAtomic(this.paths.index, this.sessionId, {
          entries: this.indexEntries,
          completeBytes: this.logSize,
        });
        this.indexDirtyValue = false;
      } catch {
        this.indexDirtyValue = true;
      }

      return record;
    });
  }

  async readAllRecords(): Promise<readonly AgentPersistedRecord[]> {
    await this.waitForWrites();
    this.assertOpen();
    const scanned = scanCompleteLogBuffer(
      await readFile(this.paths.log),
      this.sessionId,
    );
    if (scanned.truncatedTailBytes !== 0) {
      throw new AgentPersistenceError(
        "corrupt_log",
        "Agent session " +
          this.sessionId +
          " acquired an incomplete log tail while open",
      );
    }
    return scanned.records;
  }

  async readRecord(sequence: number): Promise<AgentPersistedRecord | undefined> {
    await this.waitForWrites();
    this.assertOpen();

    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      return undefined;
    }
    const entry = this.indexEntries[sequence - 1];
    if (!entry || entry.sequence !== sequence) {
      return undefined;
    }

    const handle = await open(this.paths.log, "r");
    try {
      const buffer = new Uint8Array(entry.length);
      const result = await handle.read(
        buffer,
        0,
        entry.length,
        entry.offset,
      );
      if (result.bytesRead !== entry.length || buffer.at(-1) !== 0x0a) {
        throw new AgentPersistenceError(
          "corrupt_log",
          "Index entry " +
            sequence +
            " does not point to a complete log record",
        );
      }
      return parsePersistedRecord(
        new TextDecoder().decode(buffer.subarray(0, -1)),
        this.sessionId,
        sequence,
      );
    } finally {
      await handle.close();
    }
  }

  async replay(): Promise<AgentSessionReplay> {
    return replayAgentSession(await this.readAllRecords(), this.sessionId);
  }

  async rebuildIndex(): Promise<void> {
    await this.enqueueWrite(async () => {
      const scanned = scanCompleteLogBuffer(
        await readFile(this.paths.log),
        this.sessionId,
      );
      if (scanned.truncatedTailBytes !== 0) {
        throw new AgentPersistenceError(
          "corrupt_log",
          "Cannot rebuild index while the authoritative log has an incomplete tail",
        );
      }
      await writeIndexAtomic(this.paths.index, this.sessionId, scanned);
      this.lastSequenceValue = scanned.records.at(-1)?.sequence ?? 0;
      this.logSize = scanned.completeBytes;
      this.indexEntries = [...scanned.entries];
      this.indexDirtyValue = false;
    });
  }

  async writeSnapshot<T>(
    state: T,
    options: { readonly createdAt?: number } = {},
  ): Promise<AgentSessionSnapshot<T>> {
    return this.enqueueWrite(async () => {
      assertJsonValue(state);
      const snapshot: AgentSessionSnapshot<T> = {
        schemaVersion: AGENT_PERSISTENCE_SCHEMA_VERSION,
        sessionId: this.sessionId,
        logSequence: this.lastSequenceValue,
        createdAt: options.createdAt ?? Date.now(),
        state,
      };
      await writeAtomicJson(this.paths.snapshot, snapshot);
      return snapshot;
    });
  }

  async readSnapshot<T = unknown>(): Promise<AgentSessionSnapshotReadResult<T>> {
    await this.waitForWrites();
    this.assertOpen();

    let text: string;
    try {
      text = await readFile(this.paths.snapshot, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { status: "missing" };
      }
      throw error;
    }

    try {
      const snapshot = validateSnapshot<T>(
        JSON.parse(text) as unknown,
        this.sessionId,
      );
      return {
        status:
          snapshot.logSequence === this.lastSequenceValue ? "fresh" : "stale",
        snapshot,
      };
    } catch (error) {
      const persistenceError =
        error instanceof AgentPersistenceError
          ? error
          : new AgentPersistenceError(
              "corrupt_snapshot",
              "Snapshot for session " + this.sessionId + " is not valid JSON",
              error,
            );
      return { status: "corrupt", error: persistenceError };
    }
  }

  async listTemporaryFiles(): Promise<readonly string[]> {
    await this.waitForWrites();
    this.assertOpen();
    return (await readdir(this.paths.directory)).filter((name) =>
      name.includes(".tmp-"),
    );
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) {
      await this.writeQueue;
      return;
    }
    this.closing = true;
    await this.writeQueue;
    this.closed = true;
    activeWriters.delete(path.resolve(this.paths.directory));
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async waitForWrites(): Promise<void> {
    await this.writeQueue;
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new AgentPersistenceError(
        "store_closed",
        "Agent session store " + this.sessionId + " is closed",
      );
    }
  }
}

export function replayAgentSession(
  records: readonly AgentPersistedRecord[],
  expectedSessionId?: string,
): AgentSessionReplay {
  let runState = createInitialAgentRunState();
  const input: AgentModelInputItem[] = [];
  const metadata: JsonObject[] = [];
  let lifecycle: JsonObject | undefined;
  let expectedSequence = 1;
  const sessionId = expectedSessionId ?? records[0]?.sessionId;

  for (const record of records) {
    validatePersistedRecord(record, sessionId, expectedSequence);
    expectedSequence += 1;

    switch (record.kind) {
      case "model_input":
        input.push(validateModelMessageInput(record.payload));
        break;
      case "model_event": {
        const event = validateModelEvent(record.payload);
        const nextState = reduceAgentRunEvent(runState, event);
        const wasApplied = nextState !== runState;
        runState = nextState;
        if (wasApplied && event.type === "response.completed") {
          appendCompletedModelOutput(input, runState);
        }
        break;
      }
      case "tool_result":
        input.push(validateToolResult(record.payload));
        break;
      case "lifecycle":
        lifecycle = validateJsonObject(record.payload, "lifecycle payload");
        break;
      case "metadata":
        metadata.push(
          validateJsonObject(record.payload, "metadata payload"),
        );
        break;
    }
  }

  return {
    records,
    runState,
    input,
    lastSequence: records.at(-1)?.sequence ?? 0,
    lifecycle,
    metadata,
  };
}

export function validateSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AgentPersistenceError(
      "invalid_session_id",
      "Agent session id must be 1-128 safe filename characters and start with an alphanumeric character",
    );
  }
  return sessionId;
}

function resolveSessionPaths(
  rootDirectory: string,
  sessionId: string,
): AgentSessionPaths {
  const root = path.resolve(rootDirectory);
  const directory = path.resolve(root, sessionId);
  if (path.dirname(directory) !== root) {
    throw new AgentPersistenceError(
      "invalid_session_id",
      "Agent session id escapes the configured persistence root",
    );
  }
  return {
    directory,
    log: path.join(directory, "session.jsonl"),
    index: path.join(directory, "session.idx"),
    snapshot: path.join(directory, "session.snapshot.json"),
  };
}

async function ensureDurableFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await restrictPermissions(filePath, 0o600);
}

async function restrictPermissions(
  filePath: string,
  mode: number,
): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(filePath, mode);
  }
}

async function scanAndRecoverLog(
  logPath: string,
  sessionId: string,
): Promise<ScannedLog> {
  const scanned = scanCompleteLogBuffer(await readFile(logPath), sessionId);
  if (scanned.truncatedTailBytes > 0) {
    await truncate(logPath, scanned.completeBytes);
    const handle = await open(logPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(path.dirname(logPath));
  }
  return scanned;
}

function scanCompleteLogBuffer(
  buffer: Buffer,
  sessionId: string,
): ScannedLog {
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const truncatedTailBytes = buffer.length - completeBytes;
  const records: AgentPersistedRecord[] = [];
  const entries: AgentSessionIndexEntry[] = [];
  let offset = 0;
  let expectedSequence = 1;

  while (offset < completeBytes) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0 || newline >= completeBytes) {
      break;
    }
    const lineBuffer = buffer.subarray(offset, newline);
    if (lineBuffer.length === 0) {
      throw new AgentPersistenceError(
        "corrupt_log",
        "Agent session " +
          sessionId +
          " contains an empty log record at sequence " +
          expectedSequence,
      );
    }
    const record = parsePersistedRecord(
      lineBuffer.toString("utf8"),
      sessionId,
      expectedSequence,
    );
    const length = newline - offset + 1;
    records.push(record);
    entries.push({ sequence: expectedSequence, offset, length });
    expectedSequence += 1;
    offset = newline + 1;
  }

  return {
    records,
    entries,
    completeBytes,
    truncatedTailBytes,
  };
}

function parsePersistedRecord(
  text: string,
  sessionId: string,
  expectedSequence: number,
): AgentPersistedRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session " +
        sessionId +
        " contains invalid JSON at sequence " +
        expectedSequence,
      error,
    );
  }
  validatePersistedRecord(value, sessionId, expectedSequence);
  return value;
}

function validatePersistedRecord(
  value: unknown,
  expectedSessionId: string | undefined,
  expectedSequence: number,
): asserts value is AgentPersistedRecord {
  if (!isUnknownRecord(value)) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session log record " + expectedSequence + " is not an object",
    );
  }
  if (value.schemaVersion !== AGENT_PERSISTENCE_SCHEMA_VERSION) {
    throw new AgentPersistenceError(
      "unsupported_schema",
      "Unsupported agent persistence schema version " +
        String(value.schemaVersion) +
        "; this build supports version " +
        String(AGENT_PERSISTENCE_SCHEMA_VERSION) +
        ". Upgrade/downgrade StamCont or migrate this durable session before resuming it.",
    );
  }
  if (
    typeof value.sessionId !== "string" ||
    (expectedSessionId !== undefined &&
      value.sessionId !== expectedSessionId)
  ) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session log record " +
        expectedSequence +
        " has the wrong session id",
    );
  }
  if (value.sequence !== expectedSequence) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session log expected sequence " +
        expectedSequence +
        ", received " +
        String(value.sequence),
    );
  }
  if (!isPersistedRecordKind(value.kind)) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session log record " +
        expectedSequence +
        " has unknown kind " +
        String(value.kind),
    );
  }
  if (!("payload" in value)) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Agent session log record " + expectedSequence + " is missing its payload",
    );
  }
}

function isPersistedRecordKind(
  value: unknown,
): value is AgentPersistedRecordKind {
  return (
    typeof value === "string" &&
    (AGENT_PERSISTED_RECORD_KINDS as readonly string[]).includes(value)
  );
}

async function readIndexStatus(
  indexPath: string,
  sessionId: string,
  scanned: ScannedLog,
): Promise<AgentSessionIndexRecoveryStatus> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
  } catch (error) {
    return isNodeError(error, "ENOENT") ? "missing" : "corrupt";
  }
  if (!isValidIndex(value, sessionId)) {
    return "corrupt";
  }
  return indexMatchesScan(value, scanned) ? "valid" : "stale";
}

function isValidIndex(
  value: unknown,
  sessionId: string,
): value is AgentSessionIndex {
  if (
    !isUnknownRecord(value) ||
    value.schemaVersion !== AGENT_PERSISTENCE_SCHEMA_VERSION ||
    value.sessionId !== sessionId ||
    typeof value.logSize !== "number" ||
    !Number.isSafeInteger(value.logSize) ||
    value.logSize < 0 ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  return value.entries.every((entry, index) => {
    return (
      isUnknownRecord(entry) &&
      entry.sequence === index + 1 &&
      typeof entry.offset === "number" &&
      Number.isSafeInteger(entry.offset) &&
      entry.offset >= 0 &&
      typeof entry.length === "number" &&
      Number.isSafeInteger(entry.length) &&
      entry.length > 0
    );
  });
}

function indexMatchesScan(
  index: AgentSessionIndex,
  scanned: ScannedLog,
): boolean {
  return (
    index.logSize === scanned.completeBytes &&
    index.entries.length === scanned.entries.length &&
    index.entries.every((entry, indexPosition) => {
      const actual = scanned.entries[indexPosition];
      return (
        entry.sequence === actual.sequence &&
        entry.offset === actual.offset &&
        entry.length === actual.length
      );
    })
  );
}

async function writeIndexAtomic(
  indexPath: string,
  sessionId: string,
  scanned: Pick<ScannedLog, "entries" | "completeBytes">,
): Promise<void> {
  const index: AgentSessionIndex = {
    schemaVersion: AGENT_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    logSize: scanned.completeBytes,
    entries: scanned.entries,
  };
  await writeAtomicJson(indexPath, index);
}

async function appendDurably(
  filePath: string,
  text: string,
): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  assertJsonValue(value);
  const tempPath =
    filePath + ".tmp-" + process.pid + "-" + tempCounter++;
  let created = false;

  try {
    const handle = await open(
      tempPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    created = false;
    await restrictPermissions(filePath, 0o600);
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (created) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL", "ENOTSUP", "EBADF", "EPERM")) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function validateSnapshot<T>(
  value: unknown,
  sessionId: string,
): AgentSessionSnapshot<T> {
  if (!isUnknownRecord(value)) {
    throw new AgentPersistenceError(
      "corrupt_snapshot",
      "Snapshot for session " + sessionId + " is not an object",
    );
  }
  if (value.schemaVersion !== AGENT_PERSISTENCE_SCHEMA_VERSION) {
    throw new AgentPersistenceError(
      "corrupt_snapshot",
      "Snapshot for session " +
        sessionId +
        " has unsupported schema version " +
        String(value.schemaVersion),
    );
  }
  if (
    value.sessionId !== sessionId ||
    typeof value.logSequence !== "number" ||
    !Number.isSafeInteger(value.logSequence) ||
    value.logSequence < 0 ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !("state" in value)
  ) {
    throw new AgentPersistenceError(
      "corrupt_snapshot",
      "Snapshot for session " + sessionId + " has an invalid envelope",
    );
  }
  return value as AgentSessionSnapshot<T>;
}

function validateModelMessageInput(value: unknown): AgentModelMessageInput {
  if (
    !isUnknownRecord(value) ||
    value.type !== "message" ||
    (value.role !== "system" && value.role !== "user") ||
    typeof value.content !== "string"
  ) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Persisted model_input record is invalid",
    );
  }
  return value as unknown as AgentModelMessageInput;
}

function validateModelEvent(value: unknown): AgentRunEvent {
  if (
    !isUnknownRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.responseId !== "string" ||
    typeof value.sequence !== "number"
  ) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Persisted model_event record is invalid",
    );
  }
  return value as unknown as AgentRunEvent;
}

function validateToolResult(value: unknown): AgentToolResult {
  if (
    !isUnknownRecord(value) ||
    value.type !== "tool_result" ||
    (value.status !== "success" && value.status !== "failure") ||
    typeof value.toolCallItemId !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Persisted tool_result record is invalid",
    );
  }
  return value as unknown as AgentToolResult;
}

function appendCompletedModelOutput(
  input: AgentModelInputItem[],
  state: AgentRunState,
): void {
  const response = getLatestAgentResponse(state);
  if (!response || response.status !== "completed") {
    return;
  }
  for (const item of response.outputItems) {
    if (item.status === "completed" && item.completedItem) {
      input.push({ type: "model_output", item: item.completedItem });
    }
  }
}

function validateJsonObject(value: unknown, label: string): JsonObject {
  assertJsonValue(value);
  if (!isUnknownRecord(value)) {
    throw new AgentPersistenceError(
      "corrupt_log",
      "Persisted " + label + " is not a JSON object",
    );
  }
  return value as JsonObject;
}

function encodeJsonLine(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(value) + "\n";
}

function assertJsonValue(value: unknown): void {
  const seen = new WeakSet<object>();
  assertJsonValueAtPath(value, "$", seen);
}

function assertJsonValueAtPath(
  value: unknown,
  currentPath: string,
  seen: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw invalidJsonValue(currentPath, "non-finite number");
  }
  if (typeof value !== "object") {
    throw invalidJsonValue(currentPath, typeof value);
  }
  if (seen.has(value)) {
    throw invalidJsonValue(currentPath, "cyclic object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    throw invalidJsonValue(currentPath, "non-JSON object");
  }

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValueAtPath(
        item,
        currentPath + "[" + index + "]",
        seen,
      );
    });
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw invalidJsonValue(currentPath, "symbol-keyed property");
      }
      assertJsonValueAtPath(
        (value as Record<string, unknown>)[key],
        currentPath + "." + key,
        seen,
      );
    }
  }
  seen.delete(value);
}

function invalidJsonValue(
  currentPath: string,
  description: string,
): AgentPersistenceError {
  return new AgentPersistenceError(
    "invalid_json_value",
    "Agent persistence value at " +
      currentPath +
      " is not losslessly JSON-serializable: " +
      description,
  );
}

function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isNodeError(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    codes.includes((error as Error & { code: string }).code)
  );
}
