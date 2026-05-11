import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BuildState, PersistedTaskState } from "./types.js";

const EMPTY_STATE: BuildState = {
  version: 1,
  tasks: {},
};

function getStateFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, "state.json");
}

export async function loadBuildState(stateDirectory: string): Promise<BuildState> {
  const stateFilePath = getStateFilePath(stateDirectory);

  try {
    const serialized = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(serialized) as BuildState;

    if (parsed.version !== 1 || typeof parsed.tasks !== "object" || parsed.tasks === null) {
      return EMPTY_STATE;
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STATE;
    }

    throw error;
  }
}

export async function saveBuildState(stateDirectory: string, state: BuildState): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(getStateFilePath(stateDirectory), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getTaskState(state: BuildState, taskId: string): PersistedTaskState | undefined {
  return state.tasks[taskId];
}

export function setTaskState(state: BuildState, taskId: string, taskState: PersistedTaskState): BuildState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [taskId]: taskState,
    },
  };
}