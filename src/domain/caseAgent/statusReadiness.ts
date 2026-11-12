import { scheduledOperationIsHealthy, type ScheduledOperationHealth } from "../scheduledOperations";

export function caseAgentOperationallyReady(input: {
  programConfigured: boolean;
  modelConfigured: boolean;
  serviceAccountCount: number;
  emailConfigured: boolean;
  workerHealth: ScheduledOperationHealth;
}): boolean {
  return input.programConfigured
    && input.modelConfigured
    && input.serviceAccountCount === 1
    && input.emailConfigured
    && scheduledOperationIsHealthy(input.workerHealth);
}
