import type { AgentId, AgentWorker } from "@firefly/agent-kernel";

export class AgentRegistry {
  private readonly workers: ReadonlyMap<AgentId, AgentWorker>;

  constructor(workers: readonly AgentWorker[]) {
    const registered = new Map<AgentId, AgentWorker>();
    for (const worker of workers) {
      if (registered.has(worker.id)) {
        throw new Error(`Duplicate Agent registration: ${worker.id}`);
      }
      registered.set(worker.id, worker);
    }
    this.workers = registered;
  }

  get(agentId: AgentId): AgentWorker {
    const worker = this.workers.get(agentId);
    if (!worker) {
      throw new Error(`Agent is not registered: ${agentId}`);
    }
    return worker;
  }
}
