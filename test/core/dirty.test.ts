import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { BuildFailureError, command as createCommandTask, copy, reckon, writeFile as createWriteFileTask } from "../../src";
import { createFingerprint } from "../../src/core/signatures";
import type { Task } from "../../src/core/types";

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "reckon-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createProducer(version: string): Task {
  return {
    id: "producer",
    label: `producer ${version}`,
    outputs: ["generated/input.txt"],
    fileDependencies: ["source.txt"],
    taskDependencies: [],
    fingerprint: createFingerprint({ kind: "producer", version }),
    async execute(context) {
      const resolvedOutput = context.resolvePath("generated/input.txt");
      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      const source = await readFile(context.resolvePath("source.txt"), "utf8");
      await writeFile(resolvedOutput, `${source.trim()}:${version}\n`, "utf8");
    },
  };
}

function createConsumer(producer: Task): Task {
  return {
    id: "consumer",
    label: "consumer",
    outputs: ["dist/result.txt"],
    fileDependencies: ["generated/input.txt"],
    taskDependencies: [producer],
    fingerprint: createFingerprint({ kind: "consumer" }),
    async execute(context) {
      const resolvedOutput = context.resolvePath("dist/result.txt");
      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      const generated = await readFile(context.resolvePath("generated/input.txt"), "utf8");
      await writeFile(resolvedOutput, generated.toUpperCase(), "utf8");
    },
  };
}

function createFailingTask(): Task {
  return {
    id: "failing",
    label: "failing task",
    outputs: ["dist/failure.txt"],
    fileDependencies: [],
    taskDependencies: [],
    fingerprint: createFingerprint({ kind: "failing-task" }),
    async execute() {
      throw new Error("boom");
    },
  };
}

function createDependentOutputTask(dependency: Task): Task {
  return {
    id: "dependent-output",
    label: "dependent output",
    outputs: ["dist/dependent.txt"],
    fileDependencies: [],
    taskDependencies: [dependency],
    fingerprint: createFingerprint({ kind: "dependent-output" }),
    async execute(context) {
      const resolvedOutput = context.resolvePath("dist/dependent.txt");
      await mkdir(path.dirname(resolvedOutput), { recursive: true });
      await writeFile(resolvedOutput, "done\n", "utf8");
    },
  };
}

test("copy task reruns when its input changes or output is deleted", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "first\n", "utf8");

    const target = copy("source.txt", "dist/copied.txt");
    const first = await reckon(target, { cwd });
    const second = await reckon(target, { cwd });

    assert.deepEqual(first.executed, [target.label]);
    assert.deepEqual(second.skipped, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "source.txt"), "second\n", "utf8");
    const third = await reckon(target, { cwd });
    assert.deepEqual(third.executed, [target.label]);

    await unlink(path.join(cwd, "dist/copied.txt"));
    const fourth = await reckon(target, { cwd });
    assert.deepEqual(fourth.executed, [target.label]);
  });
});

test("task fingerprint changes invalidate prior task state", async () => {
  await withTempDir(async (cwd) => {
    const first = await reckon(createWriteFileTask("dist/output.txt", "alpha\n"), { cwd });
    const second = await reckon(createWriteFileTask("dist/output.txt", "beta\n"), { cwd });

    assert.deepEqual(first.executed, ["write dist/output.txt"]);
    assert.deepEqual(second.executed, ["write dist/output.txt"]);
    assert.equal(await readFile(path.join(cwd, "dist/output.txt"), "utf8"), "beta\n");
  });
});

test("downstream tasks rerun when an upstream task fingerprint changes", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "hello\n", "utf8");

    const producerV1 = createProducer("v1");
    const consumerV1 = createConsumer(producerV1);
    const first = await reckon(consumerV1, { cwd });
    const second = await reckon(createConsumer(createProducer("v1")), { cwd });

    assert.deepEqual(first.executed, [producerV1.label, consumerV1.label]);
    assert.deepEqual(second.skipped, ["producer v1", "consumer"]);

    await delay(20);
    const producerV2 = createProducer("v2");
    const consumerV2 = createConsumer(producerV2);
    const third = await reckon(consumerV2, { cwd });

    assert.deepEqual(third.executed, [producerV2.label, consumerV2.label]);
    assert.equal(await readFile(path.join(cwd, "dist/result.txt"), "utf8"), "HELLO:V2\n");
  });
});

test("BuildFailureError preserves root task failures separately from downstream failures", async () => {
  await withTempDir(async (cwd) => {
    const failingTask = createFailingTask();
    const dependentTask = createDependentOutputTask(failingTask);

    await assert.rejects(
      () => reckon(dependentTask, { cwd }),
      (error: unknown) => {
        assert(error instanceof BuildFailureError);
        assert.deepEqual(error.summary.failed, [failingTask.label, dependentTask.label]);
        assert.deepEqual(
          error.failures.map((failure) => ({ taskLabel: failure.taskLabel, kind: failure.kind, message: failure.error.message })),
          [
            { taskLabel: failingTask.label, kind: "task", message: "boom" },
            { taskLabel: dependentTask.label, kind: "cancelled", message: `Cancelled after a previous task failed before ${dependentTask.label} could start` },
          ],
        );
        assert.match(error.message, /failing task: boom/);
        return true;
      },
    );
  });
});

test("reckon verbose mode logs build progress", async (t) => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "first\n", "utf8");
    const target = copy("source.txt", "dist/copied.txt");
    const messages: string[] = [];
    const errors: string[] = [];

    t.mock.method(console, "log", (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    });
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const summary = await reckon(target, { cwd, verbose: true });

    assert.deepEqual(summary.executed, [target.label]);
    assert.equal(errors.length, 0);
    assert(messages.some((message) => message.includes(`[reckon] start build: 1 task, concurrency ${Math.max(1, cpus().length)}`)));
    assert(messages.some((message) => message.includes(`[reckon] run: ${target.label}`)));
    assert(messages.some((message) => message.includes(`[reckon] 1/1 executed: ${target.label}`)));
    assert(messages.some((message) => message.includes("[reckon] complete: 1 executed, 0 skipped, 0 failed")));
  });
});

test("command failures keep duplicate output out of verbose logs and out of the final error", async (t) => {
  await withTempDir(async (cwd) => {
    const failingScript = path.join(cwd, "fail.mjs");
    await writeFile(failingScript, "console.log('duplicate output');\nconsole.error('duplicate output');\nprocess.exit(1);\n", "utf8");

    const target = createCommandTask(
      process.execPath,
      [failingScript],
      { outputs: ["dist/never-created.txt"] },
    );
    const messages: string[] = [];
    const errors: string[] = [];

    t.mock.method(console, "log", (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    });
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await assert.rejects(
      () => reckon(target, { cwd, verbose: true }),
      (error: unknown) => {
        assert(error instanceof BuildFailureError);
        assert.match(error.message, /Command failed:/);
        assert.equal(error.message.split("duplicate output").length - 1, 1);
        assert.equal(messages.filter((message) => message.includes("[reckon] complete: 0 executed, 0 skipped, 1 failed")).length, 1);
        assert(errors.some((message) => message.includes("Command failed:")));
        assert(errors.every((message) => !message.includes("duplicate output")));
        return true;
      },
    );
  });
});