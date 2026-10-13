export type AgentJob = {
  runId: string; taskId: string; role: 'planner' | 'builder' | 'reviewer' | 'diagnostician';
  cwd: string; instructions: string; contextFiles: string[]; timeoutMs: number; readOnly: boolean;
};
export type AgentJobResult = {
  exitCode: number | null; output: string; structured?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; artifacts: string[];
};
export interface AgentRunner {
  execute(input: AgentJob, options: { signal: AbortSignal }): Promise<AgentJobResult>;
}
