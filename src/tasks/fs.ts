import { copyFile, mkdir as mkdirDirectory, writeFile as writeFileContents } from "node:fs/promises";
import path from "node:path";

import { createFingerprint, normalizeBuildPath } from "../core/signatures.js";
import type { Task } from "../core/types.js";

export interface CommandTaskOptions {
  readonly outputs: readonly string[];
  readonly fileDependencies?: readonly string[];
  readonly taskDependencies?: readonly Task[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function createTaskId(kind: string, output: string): string {
  return `${kind}:${normalizeBuildPath(output)}`;
}

export function mkdir(output: string): Task {
  return {
    id: createTaskId("mkdir", output),
    label: `mkdir ${normalizeBuildPath(output)}`,
    outputs: [normalizeBuildPath(output)],
    fileDependencies: [],
    taskDependencies: [],
    fingerprint: createFingerprint({ kind: "mkdir", output: normalizeBuildPath(output) }),
    async execute(context) {
      await mkdirDirectory(context.resolvePath(output), { recursive: true });
    },
  };
}

export function writeFile(output: string, contents: string): Task {
  const normalizedOutput = normalizeBuildPath(output);

  return {
    id: createTaskId("writeFile", normalizedOutput),
    label: `write ${normalizedOutput}`,
    outputs: [normalizedOutput],
    fileDependencies: [],
    taskDependencies: [],
    fingerprint: createFingerprint({ kind: "writeFile", output: normalizedOutput, contents }),
    async execute(context) {
      const resolvedOutput = context.resolvePath(normalizedOutput);
      await mkdirDirectory(path.dirname(resolvedOutput), { recursive: true });
      await writeFileContents(resolvedOutput, contents, "utf8");
    },
  };
}

export function copy(source: string, destination: string): Task {
  const normalizedSource = normalizeBuildPath(source);
  const normalizedDestination = normalizeBuildPath(destination);

  return {
    id: createTaskId("copy", normalizedDestination),
    label: `copy ${normalizedSource} -> ${normalizedDestination}`,
    outputs: [normalizedDestination],
    fileDependencies: [normalizedSource],
    taskDependencies: [],
    fingerprint: createFingerprint({ kind: "copy", source: normalizedSource, destination: normalizedDestination }),
    async execute(context) {
      const resolvedDestination = context.resolvePath(normalizedDestination);
      await mkdirDirectory(path.dirname(resolvedDestination), { recursive: true });
      await copyFile(context.resolvePath(normalizedSource), resolvedDestination);
    },
  };
}

export function command(commandName: string, args: readonly string[], options: CommandTaskOptions): Task {
  const outputs = options.outputs.map((output) => normalizeBuildPath(output));
  const fileDependencies = (options.fileDependencies ?? []).map((filePath) => normalizeBuildPath(filePath));
  const taskDependencies = [...(options.taskDependencies ?? [])];
  const primaryOutput = outputs[0] ?? `${commandName}-${createFingerprint({ args, outputs })}`;

  return {
    id: createTaskId("command", primaryOutput),
    label: `${commandName} ${args.join(" ")}`.trim(),
    outputs,
    fileDependencies,
    taskDependencies,
    fingerprint: createFingerprint({
      kind: "command",
      commandName,
      args,
      outputs,
      fileDependencies,
      cwd: options.cwd,
      env: options.env,
    }),
    async execute(context) {
      await Promise.all(outputs.map(async (output) => mkdirDirectory(path.dirname(context.resolvePath(output)), { recursive: true })));
      await context.runCommand(commandName, args, {
        cwd: options.cwd ? context.resolvePath(options.cwd) : undefined,
        env: options.env,
      });
    },
  };
}