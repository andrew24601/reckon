import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileSignature } from "./types.js";

interface CapturePathSignaturesOptions {
  readonly expandGlobs?: boolean;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  }

  return value;
}

export function createFingerprint(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(normalizeValue(value))).digest("hex");
}

export function normalizeBuildPath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/");
}

export function resolveBuildPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function hasGlobSyntax(filePath: string): boolean {
  return /[*?]/.test(filePath);
}

function hasGlobSyntaxInSegment(segment: string): boolean {
  return /[*?]/.test(segment);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globSegmentToRegExp(segment: string): RegExp {
  const source = [...segment].map((character) => {
    if (character === "*") {
      return "[^/]*";
    }

    if (character === "?") {
      return "[^/]";
    }

    return escapeRegExp(character);
  }).join("");

  return new RegExp(`^${source}$`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function expandGlobFrom(
  absoluteDirectory: string,
  relativePrefix: string,
  patternSegments: readonly string[],
): Promise<string[]> {
  const [segment, ...remainingSegments] = patternSegments;

  if (!segment) {
    return [relativePrefix || "."];
  }

  if (segment === "**") {
    if (remainingSegments.length === 0) {
      return collectFilesRecursively(absoluteDirectory, relativePrefix);
    }

    const matches = await expandGlobFrom(absoluteDirectory, relativePrefix, remainingSegments);

    if (!await pathExists(absoluteDirectory)) {
      return matches;
    }

    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const nestedMatches = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => expandGlobFrom(
          path.join(absoluteDirectory, entry.name),
          normalizeBuildPath(path.posix.join(relativePrefix, entry.name)),
          patternSegments,
        )),
    );

    return [...matches, ...nestedMatches.flat()];
  }

  if (!await pathExists(absoluteDirectory)) {
    return [];
  }

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const matchedEntries = hasGlobSyntaxInSegment(segment)
    ? entries.filter((entry) => globSegmentToRegExp(segment).test(entry.name))
    : entries.filter((entry) => entry.name === segment);
  const matches = await Promise.all(matchedEntries.flatMap(async (entry) => {
    const nextRelativePath = normalizeBuildPath(path.posix.join(relativePrefix, entry.name));
    const nextAbsolutePath = path.join(absoluteDirectory, entry.name);

    if (remainingSegments.length === 0) {
      return entry.isDirectory() ? [] : [nextRelativePath];
    }

    if (!entry.isDirectory()) {
      return [];
    }

    return expandGlobFrom(nextAbsolutePath, nextRelativePath, remainingSegments);
  }));

  return matches.flat();
}

async function collectFilesRecursively(absoluteDirectory: string, relativePrefix: string): Promise<string[]> {
  if (!await pathExists(absoluteDirectory)) {
    return [];
  }

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const matches = await Promise.all(entries.map(async (entry) => {
    const nextRelativePath = normalizeBuildPath(path.posix.join(relativePrefix, entry.name));
    const nextAbsolutePath = path.join(absoluteDirectory, entry.name);

    if (entry.isDirectory()) {
      return collectFilesRecursively(nextAbsolutePath, nextRelativePath);
    }

    return [nextRelativePath];
  }));

  return matches.flat();
}

async function expandGlobPath(cwd: string, filePath: string): Promise<string[]> {
  const normalizedPath = normalizeBuildPath(filePath);
  if (!hasGlobSyntax(normalizedPath)) {
    return [normalizedPath];
  }

  const parsedPath = path.posix.parse(normalizedPath);
  const segments = normalizedPath.slice(parsedPath.root.length).split("/").filter(Boolean);
  const firstGlobIndex = segments.findIndex(hasGlobSyntaxInSegment);
  if (firstGlobIndex === -1) {
    return [normalizedPath];
  }

  const baseSegments = segments.slice(0, firstGlobIndex);
  const patternSegments = segments.slice(firstGlobIndex);
  const relativeBase = normalizeBuildPath(path.posix.join(parsedPath.root, ...baseSegments));
  const absoluteBase = resolveBuildPath(cwd, relativeBase);
  const matches = await expandGlobFrom(absoluteBase, relativeBase, patternSegments);

  return matches.map((match) => normalizeBuildPath(match)).sort();
}

export async function createFileSignature(filePath: string): Promise<FileSignature> {
  try {
    const entry = await stat(filePath);
    return {
      exists: true,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        size: null,
        mtimeMs: null,
      };
    }

    throw error;
  }
}

export async function capturePathSignatures(
  cwd: string,
  filePaths: readonly string[],
  options: CapturePathSignaturesOptions = {},
): Promise<Record<string, FileSignature>> {
  const expandedPaths = options.expandGlobs
    ? (await Promise.all(filePaths.map((filePath) => expandGlobPath(cwd, filePath)))).flat()
    : filePaths.map((filePath) => normalizeBuildPath(filePath));
  const uniquePaths = [...new Set(expandedPaths)].sort();
  const entries = await Promise.all(
    uniquePaths.map(async (filePath) => [filePath, await createFileSignature(resolveBuildPath(cwd, filePath))] as const),
  );

  return Object.fromEntries(entries);
}

export function signatureMapsEqual(
  left: Record<string, FileSignature>,
  right: Record<string, FileSignature>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => {
    const leftSignature = left[key];
    const rightSignature = right[key];

    return (
      rightSignature !== undefined
      && leftSignature.exists === rightSignature.exists
      && leftSignature.size === rightSignature.size
      && leftSignature.mtimeMs === rightSignature.mtimeMs
    );
  });
}
