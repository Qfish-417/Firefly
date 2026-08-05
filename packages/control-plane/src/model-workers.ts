import type { AgentWorker } from "@firefly/agent-kernel";
import { ExperienceEngineerStub } from "@firefly/experience-engineer";
import { LearningDirectorAgent } from "@firefly/learning-director";
import { LearningScientistAgent } from "@firefly/learning-scientist";
import type { TextGenerationPort } from "@firefly/model-gateway";

export function createModelAssistedWorkers(gateway: TextGenerationPort): readonly AgentWorker[] {
  return [
    new LearningDirectorAgent(gateway),
    new LearningScientistAgent(gateway),
    // Engineer remains deterministic until its model proposal and M3 worktree share one lifecycle.
    new ExperienceEngineerStub(),
  ];
}
