export type AgentEventType =
  | "session.created"
  | "session.cancelled"
  | "session.closed"
  | "tool.requested"
  | "tool.denied"
  | "tool.started"
  | "tool.completed"
  | "tool.failed";

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  timestamp: number;
  parentSessionId?: string;
  toolName?: string;
  details?: Readonly<Record<string, unknown>>;
}

export type AgentEventSink = (
  event: Readonly<AgentEvent>,
) => void | Promise<void>;

export interface AgentEventBusOptions {
  onObserverError?: (
    error: unknown,
    event: Readonly<AgentEvent>,
  ) => void | Promise<void>;
}

export class AgentEventBus {
  private readonly sinks = new Set<AgentEventSink>();

  constructor(private readonly options: AgentEventBusOptions = {}) {}

  subscribe(sink: AgentEventSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  async emit(event: Readonly<AgentEvent>): Promise<void> {
    for (const sink of [...this.sinks]) {
      try {
        await sink(event);
      } catch (error) {
        await this.options.onObserverError?.(error, event);
      }
    }
  }
}
