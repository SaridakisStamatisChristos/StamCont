import path from "path";
import workerpool from "workerpool";

export interface AsyncEncoder {
  encode(text: string): Promise<number[]>;
  decode(tokens: number[]): Promise<string>;
  close(): Promise<void>;
}

export class LlamaAsyncEncoder implements AsyncEncoder {
  private workerPool?: workerpool.Pool;

  private getWorkerPool(): workerpool.Pool {
    this.workerPool ??= workerpool.pool(
      workerCodeFilePath("llamaTokenizerWorkerPool.mjs"),
    );
    return this.workerPool;
  }

  async encode(text: string): Promise<number[]> {
    return this.getWorkerPool().exec("encode", [text]);
  }

  async decode(tokens: number[]): Promise<string> {
    return this.getWorkerPool().exec("decode", [tokens]);
  }

  // TODO: this should be called somewhere before exit or potentially with a shutdown hook
  public async close(): Promise<void> {
    if (!this.workerPool) {
      return;
    }
    await this.workerPool.terminate();
    this.workerPool = undefined;
  }
}

// this class does not yet do anything asynchronous
export class GPTAsyncEncoder implements AsyncEncoder {
  private workerPool?: workerpool.Pool;

  private getWorkerPool(): workerpool.Pool {
    this.workerPool ??= workerpool.pool(
      workerCodeFilePath("tiktokenWorkerPool.mjs"),
    );
    return this.workerPool;
  }

  async encode(text: string): Promise<number[]> {
    return this.getWorkerPool().exec("encode", [text]);
  }

  async decode(tokens: number[]): Promise<string> {
    return this.getWorkerPool().exec("decode", [tokens]);
  }

  // TODO: this should be called somewhere before exit or potentially with a shutdown hook
  public async close(): Promise<void> {
    if (!this.workerPool) {
      return;
    }
    await this.workerPool.terminate();
    this.workerPool = undefined;
  }
}

function workerCodeFilePath(workerFileName: string): string {
  if (process.env.NODE_ENV === "test") {
    // `cross-env` makes __dirname the project root in this test path.
    return path.join(__dirname, "llm", workerFileName);
  }
  return path.join(__dirname, workerFileName);
}
