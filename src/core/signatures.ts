import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { FileSignature } from "./types.js";

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
): Promise<Record<string, FileSignature>> {
  const uniquePaths = [...new Set(filePaths.map((filePath) => normalizeBuildPath(filePath)))].sort();
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