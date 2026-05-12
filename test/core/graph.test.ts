import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../../src/core/graph.js";
import { createFingerprint } from "../../src/core/signatures.js";
import type { Task } from "../../src/core/types.js";

function createTask(options: {
  id: string;
  label: string;
  outputs: readonly string[];
  taskDependencies?: readonly Task[];
}): Task {
  return {
    id: options.id,
    label: options.label,
    outputs: [...options.outputs],
    fileDependencies: [],
    taskDependencies: options.taskDependencies ?? [],
    fingerprint: createFingerprint({ id: options.id, outputs: options.outputs }),
    async execute() {},
  };
}

test("buildGraph rejects duplicate outputs", () => {
  const first = createTask({
    id: "first",
    label: "first",
    outputs: ["build/out.txt"],
  });
  const second = createTask({
    id: "second",
    label: "second",
    outputs: ["build/out.txt"],
  });

  assert.throws(() => buildGraph([first, second]), /produced by both/);
});

test("buildGraph rejects cycles", () => {
  const aDependencies: Task[] = [];
  const bDependencies: Task[] = [];

  const taskA = createTask({
    id: "task-a",
    label: "task-a",
    outputs: ["build/a.txt"],
    taskDependencies: aDependencies,
  });
  const taskB = createTask({
    id: "task-b",
    label: "task-b",
    outputs: ["build/b.txt"],
    taskDependencies: bDependencies,
  });

  aDependencies.push(taskB);
  bDependencies.push(taskA);

  assert.throws(() => buildGraph([taskA]), /Cycle detected/);
});
