import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { buildGraph, type BuildNode } from "./graph.js";
import { capturePathSignatures, resolveBuildPath, signatureMapsEqual } from "./signatures.js";
import { getTaskState, loadBuildState, saveBuildState, setTaskState } from "./state.js";
import { BuildFailureError, CommandExecutionError, type BuildFailureDetail, type BuildOptions, type BuildState, type BuildSummary, type PersistedTaskState, type Task, type TaskContext, type TaskExecutionResult } from "./types.js";

interface TaskRunResult {
  readonly status: "executed" | "skipped" | "failed";
  readonly error?: Error;
  readonly failureKind?: BuildFailureDetail["kind"];
}

interface BuildLogger {
  info(message: string): void;
  error(message: string): void;
}

function withResolvedDependencies(task: Task, resolveTask: (task: Task) => Task): Task {
  const dependencies = task.taskDependencies.map(resolveTask);

  if (dependencies.every((dependency, index) => dependency === task.taskDependencies[index])) {
    return task;
  }

  return {
    ...task,
    taskDependencies: dependencies,
  };
}

function resolveConfiguredTargets(targets: readonly Task[], options: BuildOptions): readonly Task[] {
  const cache = new WeakMap<Task, Task>();
  const resolving = new WeakSet<Task>();

  const resolveTask = (task: Task): Task => {
    const cached = cache.get(task);
    if (cached) {
      return cached;
    }

    if (resolving.has(task)) {
      throw new Error(`Cycle detected while resolving task ${task.label}`);
    }

    resolving.add(task);

    try {
      const resolvedTask = task.resolve ? task.resolve({ options, resolveTask }) : task;
      const finalizedTask = withResolvedDependencies(resolvedTask, resolveTask);
      cache.set(task, finalizedTask);
      return finalizedTask;
    } finally {
      resolving.delete(task);
    }
  };

  return targets.map(resolveTask);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function summarizeErrorMessage(error: Error): string {
  const [line = ""] = error.message.split("\n", 1);
  return line;
}

function formatCommandOutput(stdout: string, stderr: string): string | undefined {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return trimmedStdout === trimmedStderr ? trimmedStderr : `${trimmedStdout}\n${trimmedStderr}`;
  }

  return trimmedStdout || trimmedStderr || undefined;
}

function createTaskContext(cwd: string): TaskContext {
  return {
    cwd,
    resolvePath(filePath: string) {
      return resolveBuildPath(cwd, filePath);
    },
    async runCommand(command: string, args: readonly string[], options = {}) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd ?? cwd,
          env: {
            ...process.env,
            ...options.env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new CommandExecutionError(command, args, signal ?? code, formatCommandOutput(stdout, stderr)));
        });
      });
    },
  };
}

async function shouldExecuteTask(
  node: BuildNode,
  state: BuildState,
  dependencyResults: readonly TaskRunResult[],
  cwd: string,
): Promise<boolean> {
  if (dependencyResults.some((result) => result.status === "executed")) {
    return true;
  }

  const previous = getTaskState(state, node.task.id);
  if (!previous) {
    return true;
  }

  if (previous.fingerprint !== node.task.fingerprint) {
    return true;
  }

  const outputSignatures = await capturePathSignatures(cwd, node.task.outputs);
  if (!signatureMapsEqual(previous.outputs, outputSignatures)) {
    return true;
  }

  const fileDependencySignatures = await capturePathSignatures(cwd, node.task.fileDependencies);
  if (!signatureMapsEqual(previous.fileDependencies, fileDependencySignatures)) {
    return true;
  }

  const discoveredDependencies = Object.keys(previous.discoveredDependencies);
  const discoveredSignatures = await capturePathSignatures(cwd, discoveredDependencies);
  return !signatureMapsEqual(previous.discoveredDependencies, discoveredSignatures);
}

async function createPersistedTaskState(
  task: Task,
  cwd: string,
  result: TaskExecutionResult | void,
): Promise<PersistedTaskState> {
  const outputSignatures = await capturePathSignatures(cwd, task.outputs);
  const fileDependencySignatures = await capturePathSignatures(cwd, task.fileDependencies);
  const discoveredDependencies = result?.discoveredDependencies ?? [];
  const discoveredSignatures = await capturePathSignatures(cwd, discoveredDependencies);

  for (const [output, signature] of Object.entries(outputSignatures)) {
    if (!signature.exists) {
      throw new Error(`Task ${task.label} did not produce expected output ${output}`);
    }
  }

  return {
    fingerprint: task.fingerprint,
    outputs: outputSignatures,
    fileDependencies: fileDependencySignatures,
    discoveredDependencies: discoveredSignatures,
    updatedAt: new Date().toISOString(),
  };
}

function summarizeResults(order: readonly BuildNode[], results: ReadonlyMap<string, TaskRunResult>): BuildSummary {
  const summary: BuildSummary = {
    executed: [],
    skipped: [],
    failed: [],
  };

  for (const node of order) {
    const result = results.get(node.task.id);
    if (!result) {
      continue;
    }

    summary[result.status].push(node.task.label);
  }

  return summary;
}

function collectFailureDetails(order: readonly BuildNode[], results: ReadonlyMap<string, TaskRunResult>): readonly BuildFailureDetail[] {
  const failures: BuildFailureDetail[] = [];

  for (const node of order) {
    const result = results.get(node.task.id);
    if (result?.status !== "failed" || !result.error) {
      continue;
    }

    failures.push({
      taskLabel: node.task.label,
      kind: result.failureKind ?? "task",
      error: result.error,
    });
  }

  return failures;
}

function createBuildLogger(verbose: boolean): BuildLogger {
  return {
    info(message: string) {
      if (verbose) {
        console.log(`[reckon] ${message}`);
      }
    },
    error(message: string) {
      if (verbose) {
        console.error(`[reckon] ${message}`);
      }
    },
  };
}

function normalizeTargets(targets: Task | readonly Task[]): readonly Task[] {
  return Array.isArray(targets) ? targets : [targets as Task];
}

export async function reckon(targets: Task | readonly Task[], options: BuildOptions = {}): Promise<BuildSummary> {
  const normalizedTargets = resolveConfiguredTargets(normalizeTargets(targets), options);
  if (normalizedTargets.length === 0) {
    return { executed: [], skipped: [], failed: [] };
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const concurrency = Math.max(1, options.concurrency ?? os.cpus().length);
  const stateDirectory = path.resolve(cwd, options.stateDirectory ?? ".reckon");
  const graph = buildGraph(normalizedTargets);
  const context = createTaskContext(cwd);
  const logger = createBuildLogger(options.verbose ?? false);
  let state = await loadBuildState(stateDirectory);

  const results = new Map<string, TaskRunResult>();
  const remainingDependencies = new Map(graph.order.map((node) => [node.task.id, node.dependencies.length] as const));
  const readyQueue = graph.order.filter((node) => node.dependencies.length === 0);
  let activeCount = 0;
  let failureDetected = false;
  let completedCount = 0;
  let finalized = false;

  logger.info(`start build: ${graph.order.length} task${graph.order.length === 1 ? "" : "s"}, concurrency ${concurrency}`);

  return await new Promise<BuildSummary>((resolve, reject) => {
    const markTaskCompleted = (status: TaskRunResult["status"], label: string, detail?: string) => {
      completedCount += 1;
      logger.info(`${completedCount}/${graph.order.length} ${status}: ${label}`);
      if (detail) {
        logger.error(`${label}: ${detail}`);
      }
    };

    const finalize = async () => {
      if (finalized) {
        return;
      }

      if (activeCount !== 0) {
        return;
      }

      if (!failureDetected && readyQueue.length !== 0) {
        return;
      }

      finalized = true;

      if (failureDetected) {
        for (const node of graph.order) {
          if (!results.has(node.task.id)) {
            results.set(node.task.id, {
              status: "failed",
              error: new Error(`Cancelled after a previous task failed before ${node.task.label} could start`),
              failureKind: "cancelled",
            });
            markTaskCompleted("failed", node.task.label, `cancelled after an earlier failure`);
          }
        }
      }

      try {
        await saveBuildState(stateDirectory, state);
        const summary = summarizeResults(graph.order, results);
        logger.info(`complete: ${summary.executed.length} executed, ${summary.skipped.length} skipped, ${summary.failed.length} failed`);
        if (summary.failed.length > 0) {
          reject(new BuildFailureError(summary, collectFailureDetails(graph.order, results)));
          return;
        }

        resolve(summary);
      } catch (error) {
        reject(error);
      }
    };

    const markDependentsReady = (node: BuildNode) => {
      for (const dependent of node.dependents) {
        const remaining = (remainingDependencies.get(dependent.task.id) ?? 0) - 1;
        remainingDependencies.set(dependent.task.id, remaining);

        if (remaining === 0 && !failureDetected) {
          readyQueue.push(dependent);
        }
      }
    };

    const runNode = async (node: BuildNode) => {
      const dependencyResults = node.dependencies.map((dependency) => results.get(dependency.task.id) ?? { status: "failed" as const, error: new Error(`Missing dependency result for ${dependency.task.label}`) });
      if (dependencyResults.some((result) => result.status === "failed")) {
        failureDetected = true;
        results.set(node.task.id, {
          status: "failed",
          error: new Error(`A dependency failed before ${node.task.label} could run`),
          failureKind: "dependency",
        });
        markTaskCompleted("failed", node.task.label, "blocked by a failed dependency");
        return;
      }

      try {
        const shouldExecute = await shouldExecuteTask(node, state, dependencyResults, cwd);

        if (!shouldExecute) {
          results.set(node.task.id, { status: "skipped" });
          markTaskCompleted("skipped", node.task.label);
          return;
        }

        logger.info(`run: ${node.task.label}`);
        const result = await node.task.execute(context);
        const taskState = await createPersistedTaskState(node.task, cwd, result);
        state = setTaskState(state, node.task.id, taskState);
        results.set(node.task.id, { status: "executed" });
        markTaskCompleted("executed", node.task.label);
      } catch (error) {
        failureDetected = true;
        const taskError = toError(error);
        results.set(node.task.id, { status: "failed", error: taskError, failureKind: "task" });
        markTaskCompleted("failed", node.task.label, summarizeErrorMessage(taskError));
      }
    };

    const schedule = () => {
      while (!failureDetected && activeCount < concurrency && readyQueue.length > 0) {
        const node = readyQueue.shift();

        if (!node || results.has(node.task.id)) {
          continue;
        }

        activeCount += 1;
        void runNode(node)
          .then(() => {
            markDependentsReady(node);
          })
          .finally(() => {
            activeCount -= 1;
            schedule();
            void finalize();
          });
      }

      void finalize();
    };

    schedule();
  });
}