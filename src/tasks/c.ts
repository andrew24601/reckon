import path from "node:path";
import { readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";

import { createFingerprint, normalizeBuildPath } from "../core/signatures.js";
import type { BuildOptions, ClangTaskDefaults, ExecutableTaskDefaults, Task } from "../core/types.js";

export interface ClangOptions {
  readonly output?: string;
  readonly outDir?: string;
  readonly compiler?: string;
  readonly flags?: readonly string[];
  readonly includes?: readonly string[];
  readonly dependencies?: readonly Task[];
  readonly cwd?: string;
}

export interface ClangTreeOptions extends Omit<ClangOptions, "output"> {
  readonly extensions?: readonly string[];
}

export interface ExecutableOptions {
  readonly compiler?: string;
  readonly flags?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly libraries?: readonly string[];
  readonly libraryPaths?: readonly string[];
  readonly extraInputs?: readonly string[];
  readonly cwd?: string;
}

const DEFAULT_CLANG_TREE_EXTENSIONS = [".c", ".cc", ".cp", ".cpp", ".cxx", ".c++", ".m", ".mm"] as const;
const CXX_LIKE_SOURCE_EXTENSIONS = new Set([".cc", ".cp", ".cpp", ".cxx", ".c++", ".C", ".mm"]);

function inferSourceRoot(source: string): string | undefined {
  const segments = normalizeBuildPath(path.dirname(source)).split("/").filter((segment) => segment !== "." && segment !== "");
  const srcIndex = segments.lastIndexOf("src");

  if (srcIndex === -1) {
    return undefined;
  }

  return normalizeBuildPath(path.join(...segments.slice(0, srcIndex + 1)));
}

function defaultObjectPath(source: string, outDir = "build/obj", sourceRoot?: string): string {
  const parsed = path.parse(source);
  const relativeDir = sourceRoot ? path.relative(sourceRoot, parsed.dir) : "";
  const normalizedRelativeDir = relativeDir === "." ? "" : relativeDir;
  return normalizeBuildPath(path.join(outDir, normalizedRelativeDir, `${parsed.name}.o`));
}

function inferObjectOutDir(source: string): string {
  const segments = normalizeBuildPath(path.dirname(source)).split("/").filter((segment) => segment !== "." && segment !== "");
  const srcIndex = segments.lastIndexOf("src");

  if (srcIndex === -1) {
    return "build/obj";
  }

  return normalizeBuildPath(path.join(...segments.slice(0, srcIndex), "build/obj"));
}

function mergeClangOptions(options: ClangOptions, defaults?: ClangTaskDefaults): ClangOptions {
  return {
    ...options,
    outDir: options.outDir ?? defaults?.outDir,
    compiler: options.compiler ?? defaults?.compiler,
    flags: [...(defaults?.flags ?? []), ...(options.flags ?? [])],
    includes: [...(defaults?.includes ?? []), ...(options.includes ?? [])],
    cwd: options.cwd ?? defaults?.cwd,
  };
}

function mergeExecutableOptions(options: ExecutableOptions, defaults?: ExecutableTaskDefaults): ExecutableOptions {
  return {
    ...options,
    compiler: options.compiler ?? defaults?.compiler,
    flags: [...(defaults?.flags ?? []), ...(options.flags ?? [])],
    frameworks: [...(defaults?.frameworks ?? []), ...(options.frameworks ?? [])],
    libraries: [...(defaults?.libraries ?? []), ...(options.libraries ?? [])],
    libraryPaths: [...(defaults?.libraryPaths ?? []), ...(options.libraryPaths ?? [])],
    extraInputs: [...(defaults?.extraInputs ?? []), ...(options.extraInputs ?? [])],
    cwd: options.cwd ?? defaults?.cwd,
  };
}

function resolveObjectOutput(source: string, options: ClangOptions, buildOptions?: BuildOptions, sourceRoot?: string): string {
  if (options.output) {
    return normalizeBuildPath(options.output);
  }

  const outDir = options.outDir ?? buildOptions?.outDir ?? inferObjectOutDir(source);
  return normalizeBuildPath(defaultObjectPath(source, outDir, sourceRoot ?? inferSourceRoot(source)));
}

function collectSourceFiles(rootPath: string, extensions: ReadonlySet<string>): string[] {
  const entries = readdirSync(rootPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath, extensions));
      continue;
    }

    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files;
}

function isCxxLikeSource(filePath: string): boolean {
  const extension = path.extname(filePath);
  return CXX_LIKE_SOURCE_EXTENSIONS.has(extension) || CXX_LIKE_SOURCE_EXTENSIONS.has(extension.toLowerCase());
}

function inferExecutableCompiler(objects: readonly Task[]): string | undefined {
  const pending = [...objects];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const task = pending.pop();

    if (!task || visited.has(task.id)) {
      continue;
    }

    visited.add(task.id);

    if (task.fileDependencies.some(isCxxLikeSource)) {
      return "clang++";
    }

    pending.push(...task.taskDependencies);
  }

  return undefined;
}

async function parseDependencyFile(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  const flattened = contents.replace(/\\\n/g, " ");
  const [, dependencyList = ""] = flattened.split(/:(.+)/s);
  const matches = dependencyList.match(/(?:\\ |[^\s])+/g) ?? [];

  return matches.map((entry) => normalizeBuildPath(entry.replace(/\\ /g, " ")));
}

function createClangTask(source: string, options: ClangOptions = {}, buildOptions?: BuildOptions, sourceRoot?: string): Task {
  const normalizedSource = normalizeBuildPath(source);
  const mergedOptions = mergeClangOptions(options, buildOptions?.clang);
  const output = resolveObjectOutput(normalizedSource, mergedOptions, buildOptions, sourceRoot);
  const compiler = mergedOptions.compiler ?? "clang";
  const flags = [...(mergedOptions.flags ?? [])];
  const includes = [...(mergedOptions.includes ?? [])].map((includePath) => normalizeBuildPath(includePath));
  const taskDependencies = [...(mergedOptions.dependencies ?? [])];

  return {
    id: `clang:${output}`,
    label: `clang ${normalizedSource}`,
    outputs: [output],
    fileDependencies: [normalizedSource],
    taskDependencies,
    fingerprint: createFingerprint({
      kind: "clang",
      source: normalizedSource,
      output,
      compiler,
      flags,
      includes,
      cwd: mergedOptions.cwd,
    }),
    async execute(context) {
      const resolvedOutput = context.resolvePath(output);
      const dependencyFile = `${resolvedOutput}.d`;
      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      const includeArgs = includes.flatMap((includePath) => ["-I", context.resolvePath(includePath)]);

      await context.runCommand(
        compiler,
        [
          ...flags,
          ...includeArgs,
          "-MMD",
          "-MF",
          dependencyFile,
          "-c",
          context.resolvePath(normalizedSource),
          "-o",
          resolvedOutput,
        ],
        {
          cwd: mergedOptions.cwd ? context.resolvePath(mergedOptions.cwd) : undefined,
        },
      );

      const discoveredDependencies = await parseDependencyFile(dependencyFile);
      return {
        discoveredDependencies: discoveredDependencies.filter((entry) => entry !== normalizedSource),
      };
    },
  };
}

function createConfiguredClangTask(source: string, options: ClangOptions = {}, sourceRoot?: string): Task {
  const normalizedSource = normalizeBuildPath(source);
  const task = createClangTask(normalizedSource, options, undefined, sourceRoot);

  return {
    ...task,
    resolve(context) {
      return createClangTask(normalizedSource, options, context.options, sourceRoot);
    },
  };
}

function createExecutableTask(output: string, objects: readonly Task[], options: ExecutableOptions = {}, buildOptions?: BuildOptions): Task {
  const normalizedOutput = normalizeBuildPath(output);
  const mergedOptions = mergeExecutableOptions(options, buildOptions?.executable);
  const compiler = mergedOptions.compiler ?? inferExecutableCompiler(objects) ?? "clang";
  const flags = [...(mergedOptions.flags ?? [])];
  const frameworks = [...(mergedOptions.frameworks ?? [])];
  const libraries = [...(mergedOptions.libraries ?? [])];
  const libraryPaths = [...(mergedOptions.libraryPaths ?? [])];
  const extraInputs = [...(mergedOptions.extraInputs ?? [])].map((input) => normalizeBuildPath(input));

  return {
    id: `executable:${normalizedOutput}`,
    label: `executable ${normalizedOutput}`,
    outputs: [normalizedOutput],
    fileDependencies: extraInputs,
    taskDependencies: [...objects],
    fingerprint: createFingerprint({
      kind: "executable",
      output: normalizedOutput,
      compiler,
      flags,
      frameworks,
      libraries,
      libraryPaths,
      extraInputs,
      objects: objects.map((task) => task.outputs),
      cwd: mergedOptions.cwd,
    }),
    async execute(context) {
      const resolvedOutput = context.resolvePath(normalizedOutput);
      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      const frameworkArgs = frameworks.flatMap((framework) => ["-framework", framework]);
      const libraryArgs = libraryPaths.flatMap((libraryPath) => ["-L", context.resolvePath(libraryPath)]);
      const objectOutputs = objects.flatMap((task) => task.outputs.map((entry) => context.resolvePath(entry)));

      await context.runCommand(
        compiler,
        [
          ...flags,
          ...objectOutputs,
          ...extraInputs.map((input) => context.resolvePath(input)),
          ...frameworkArgs,
          ...libraryArgs,
          ...libraries.map((library) => `-l${library}`),
          "-o",
          resolvedOutput,
        ],
        {
          cwd: mergedOptions.cwd ? context.resolvePath(mergedOptions.cwd) : undefined,
        },
      );
    },
  };
}

export function clang(source: string, options: ClangOptions = {}): Task {
  return createConfiguredClangTask(source, options);
}

export function clangTree(root: string, options: ClangTreeOptions = {}): readonly Task[] {
  const normalizedRoot = normalizeBuildPath(root);
  const discoveryCwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedRoot = path.resolve(discoveryCwd, normalizedRoot);
  const normalizedSourceRoot = normalizeBuildPath(path.relative(discoveryCwd, resolvedRoot) || ".");
  const extensions = new Set((options.extensions ?? DEFAULT_CLANG_TREE_EXTENSIONS).map((extension) => extension.toLowerCase()));
  const sourceOptions: ClangOptions = {
    outDir: options.outDir,
    compiler: options.compiler,
    flags: options.flags,
    includes: options.includes,
    dependencies: options.dependencies,
    cwd: options.cwd,
  };

  return collectSourceFiles(resolvedRoot, extensions)
    .map((filePath) => normalizeBuildPath(path.relative(discoveryCwd, filePath)))
    .sort((left, right) => left.localeCompare(right))
    .map((source) => createConfiguredClangTask(source, sourceOptions, normalizedSourceRoot));
}

export function executable(output: string, objects: readonly Task[], options: ExecutableOptions = {}): Task {
  const normalizedOutput = normalizeBuildPath(output);
  const task = createExecutableTask(normalizedOutput, objects, options);

  return {
    ...task,
    resolve(context) {
      return createExecutableTask(normalizedOutput, objects.map(context.resolveTask), options, context.options);
    },
  };
}