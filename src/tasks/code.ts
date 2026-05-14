import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFingerprint, normalizeBuildPath } from "../core/signatures.js";
import type { Task, TaskContext, TaskExecutionResult } from "../core/types.js";

type FileContents = string | Uint8Array;

export interface TaskOptions {
  readonly outputs: readonly string[];
  readonly fileDependencies?: readonly string[];
  readonly taskDependencies?: readonly Task[];
  readonly label?: string;
  readonly fingerprint?: unknown;
  execute(context: TaskContext): Promise<TaskExecutionResult | void> | TaskExecutionResult | void;
}

export interface JsonToFileOptions<T = any> {
  readonly input: string;
  readonly output: string;
  readonly taskDependencies?: readonly Task[];
  readonly label?: string;
  readonly fingerprint?: unknown;
  transform(input: T, context: TaskContext): Promise<FileContents> | FileContents;
}

function createCodeTaskId(kind: string, primaryOutput: string): string {
  return `${kind}:${normalizeBuildPath(primaryOutput)}`;
}

async function createOutputDirectories(context: TaskContext, outputs: readonly string[]): Promise<void> {
  await Promise.all(outputs.map(async (output) => mkdir(path.dirname(context.resolvePath(output)), { recursive: true })));
}

export function task(name: string, options: TaskOptions): Task {
  const outputs = options.outputs.map((output) => normalizeBuildPath(output));
  const fileDependencies = (options.fileDependencies ?? []).map((filePath) => normalizeBuildPath(filePath));
  const taskDependencies = [...(options.taskDependencies ?? [])];
  const primaryOutput = outputs[0] ?? `${name}-${createFingerprint({ execute: options.execute.toString(), fingerprint: options.fingerprint })}`;

  return {
    id: createCodeTaskId("task", primaryOutput),
    label: options.label ?? name,
    outputs,
    fileDependencies,
    taskDependencies,
    fingerprint: createFingerprint({
      kind: "task",
      name,
      outputs,
      fileDependencies,
      taskDependencies: taskDependencies.map((dependency) => dependency.id),
      execute: options.execute.toString(),
      fingerprint: options.fingerprint,
    }),
    async execute(context) {
      await createOutputDirectories(context, outputs);
      return await options.execute(context);
    },
  };
}

export function jsonToFile<T = any>(options: JsonToFileOptions<T>): Task {
  const input = normalizeBuildPath(options.input);
  const output = normalizeBuildPath(options.output);
  const taskDependencies = [...(options.taskDependencies ?? [])];

  return {
    id: createCodeTaskId("jsonToFile", output),
    label: options.label ?? `json ${input} -> ${output}`,
    outputs: [output],
    fileDependencies: [input],
    taskDependencies,
    fingerprint: createFingerprint({
      kind: "jsonToFile",
      input,
      output,
      taskDependencies: taskDependencies.map((dependency) => dependency.id),
      transform: options.transform.toString(),
      fingerprint: options.fingerprint,
    }),
    async execute(context) {
      const parsed = JSON.parse(await readFile(context.resolvePath(input), "utf8")) as T;
      const contents = await options.transform(parsed, context);
      const resolvedOutput = context.resolvePath(output);

      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      await writeFile(resolvedOutput, contents);
    },
  };
}
