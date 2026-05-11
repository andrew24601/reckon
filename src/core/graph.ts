import { normalizeBuildPath } from "./signatures.js";
import type { Task } from "./types.js";

export interface BuildNode {
  readonly task: Task;
  readonly dependencies: BuildNode[];
  readonly dependents: BuildNode[];
}

export interface BuildGraph {
  readonly targets: BuildNode[];
  readonly order: BuildNode[];
  readonly nodes: Map<string, BuildNode>;
}

export function buildGraph(targets: readonly Task[]): BuildGraph {
  const nodes = new Map<string, BuildNode>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const outputOwners = new Map<string, string>();
  const order: BuildNode[] = [];

  const visit = (task: Task): BuildNode => {
    const existing = nodes.get(task.id);

    if (existing) {
      if (existing.task !== task) {
        throw new Error(`Duplicate task id detected: ${task.id}`);
      }

      return existing;
    }

    if (visiting.has(task.id)) {
      throw new Error(`Cycle detected while visiting task ${task.label}`);
    }

    visiting.add(task.id);
    const dependencies = task.taskDependencies.map(visit);

    for (const output of task.outputs) {
      const normalizedOutput = normalizeBuildPath(output);
      const owner = outputOwners.get(normalizedOutput);

      if (owner && owner !== task.id) {
        throw new Error(`Output ${normalizedOutput} is produced by both ${owner} and ${task.id}`);
      }

      outputOwners.set(normalizedOutput, task.id);
    }

    const node: BuildNode = {
      task,
      dependencies,
      dependents: [],
    };

    nodes.set(task.id, node);
    visiting.delete(task.id);

    if (!visited.has(task.id)) {
      visited.add(task.id);
      order.push(node);
    }

    return node;
  };

  const targetNodes = targets.map(visit);

  for (const node of order) {
    for (const dependency of node.dependencies) {
      dependency.dependents.push(node);
    }
  }

  return {
    targets: targetNodes,
    order,
    nodes,
  };
}