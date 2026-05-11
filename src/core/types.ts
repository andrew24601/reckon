export interface CommandRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface TaskExecutionResult {
  discoveredDependencies?: string[];
}

export interface ClangTaskDefaults {
  readonly outDir?: string;
  readonly compiler?: string;
  readonly flags?: readonly string[];
  readonly includes?: readonly string[];
  readonly cwd?: string;
}

export interface ExecutableTaskDefaults {
  readonly compiler?: string;
  readonly flags?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly libraries?: readonly string[];
  readonly libraryPaths?: readonly string[];
  readonly extraInputs?: readonly string[];
  readonly cwd?: string;
}

export interface BuildOptions {
  readonly cwd?: string;
  readonly stateDirectory?: string;
  readonly concurrency?: number;
  readonly verbose?: boolean;
  readonly outDir?: string;
  readonly clang?: ClangTaskDefaults;
  readonly executable?: ExecutableTaskDefaults;
}

export interface TaskContext {
  readonly cwd: string;
  resolvePath(filePath: string): string;
  runCommand(command: string, args: readonly string[], options?: CommandRunOptions): Promise<void>;
}

export interface TaskResolutionContext {
  readonly options: BuildOptions;
  resolveTask(task: Task): Task;
}

export interface Task {
  readonly id: string;
  readonly label: string;
  readonly outputs: string[];
  readonly fileDependencies: string[];
  readonly taskDependencies: readonly Task[];
  readonly fingerprint: string;
  resolve?(context: TaskResolutionContext): Task;
  execute(context: TaskContext): Promise<TaskExecutionResult | void>;
}

export interface BuildSummary {
  readonly executed: string[];
  readonly skipped: string[];
  readonly failed: string[];
}

export type BuildTarget = Task | readonly Task[];

export interface FileSignature {
  readonly exists: boolean;
  readonly size: number | null;
  readonly mtimeMs: number | null;
}

export interface PersistedTaskState {
  readonly fingerprint: string;
  readonly outputs: Record<string, FileSignature>;
  readonly fileDependencies: Record<string, FileSignature>;
  readonly discoveredDependencies: Record<string, FileSignature>;
  readonly updatedAt: string;
}

export interface BuildState {
  readonly version: 1;
  readonly tasks: Record<string, PersistedTaskState>;
}

export interface BuildFailureDetail {
  readonly taskLabel: string;
  readonly kind: "task" | "dependency" | "cancelled";
  readonly error: Error;
}

export class CommandExecutionError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitStatus: string | number | null;
  readonly output?: string;

  constructor(command: string, args: readonly string[], exitStatus: string | number | null, output?: string) {
    const commandLine = [command, ...args].join(" ");
    super(`Command failed: ${commandLine} (${String(exitStatus)})`);
    this.name = "CommandExecutionError";
    this.command = command;
    this.args = [...args];
    this.exitStatus = exitStatus;
    this.output = output;
  }
}

function firstLine(message: string): string {
  const [line = ""] = message.split("\n", 1);
  return line;
}

function formatBuildFailureDetail(failure: BuildFailureDetail): string[] {
  const lines = [`${failure.taskLabel}: ${firstLine(failure.error.message)}`];

  if (failure.error instanceof CommandExecutionError && failure.error.output) {
    lines.push(failure.error.output);
  }

  return lines;
}

function formatBuildFailureMessage(summary: BuildSummary, failures: readonly BuildFailureDetail[]): string {
  const lines = [`Reckon build failed: ${summary.failed.join(", ")}`];
  const rootFailures = failures.filter((failure) => failure.kind === "task");
  const details = rootFailures.length > 0 ? rootFailures : failures.slice(0, 1);

  if (details.length > 0) {
    lines.push(...details.flatMap(formatBuildFailureDetail));
  }

  return lines.join("\n");
}

export class BuildFailureError extends Error {
  readonly summary: BuildSummary;
  readonly failures: readonly BuildFailureDetail[];

  constructor(summary: BuildSummary, failures: readonly BuildFailureDetail[] = []) {
    super(formatBuildFailureMessage(summary, failures));
    this.name = "BuildFailureError";
    this.summary = summary;
    this.failures = failures;
  }
}