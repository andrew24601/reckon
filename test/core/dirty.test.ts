import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { BuildFailureError, command as createCommandTask, copy, jsonToFile, reckon, task as createCodeTask, writeFile as createWriteFileTask } from "../../src/index.js";
import { createFingerprint } from "../../src/core/signatures.js";
import type { Task } from "../../src/core/types.js";

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "reckon-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function createWebCommandFixture(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, "web/src"), { recursive: true });
  await writeFile(path.join(cwd, "web/build.mjs"), "export default {};\n", "utf8");
  await writeFile(path.join(cwd, "web/package.json"), "{\"type\":\"module\"}\n", "utf8");
}

function createWebBundleTask(fileDependencies: readonly string[]): Task {
  return createCommandTask(
    process.execPath,
    ["-e", "await import('node:fs/promises').then(async ({ mkdir, writeFile }) => { await mkdir('dist', { recursive: true }); await writeFile('dist/app.bundle.js', `${Date.now()}\\n`, 'utf8'); });"],
    {
      cwd: "web",
      outputs: ["web/dist/app.bundle.js"],
      fileDependencies,
    },
  );
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

test("code task executes and skips when unchanged", async () => {
  await withTempDir(async (cwd) => {
    const target = createCodeTask("generate output", {
      outputs: ["dist/output.txt"],
      async execute(context) {
        await writeFile(context.resolvePath("dist/output.txt"), "hello\n", "utf8");
      },
    });

    const first = await reckon(target, { cwd });
    const second = await reckon(target, { cwd });

    assert.deepEqual(first.executed, [target.label]);
    assert.deepEqual(second.skipped, [target.label]);
    assert.equal(await readFile(path.join(cwd, "dist/output.txt"), "utf8"), "hello\n");
  });
});

test("code task reruns when a declared file dependency changes", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "first\n", "utf8");

    const target = createCodeTask("uppercase source", {
      outputs: ["dist/output.txt"],
      fileDependencies: ["source.txt"],
      async execute(context) {
        const source = await readFile(context.resolvePath("source.txt"), "utf8");
        await writeFile(context.resolvePath("dist/output.txt"), source.toUpperCase(), "utf8");
      },
    });

    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.deepEqual((await reckon(target, { cwd })).skipped, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "source.txt"), "second\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.equal(await readFile(path.join(cwd, "dist/output.txt"), "utf8"), "SECOND\n");
  });
});

test("code task reruns when callback body or explicit fingerprint changes", async () => {
  await withTempDir(async (cwd) => {
    const first = createCodeTask("generate version", {
      outputs: ["dist/version.txt"],
      async execute(context) {
        await writeFile(context.resolvePath("dist/version.txt"), "alpha\n", "utf8");
      },
    });
    const second = createCodeTask("generate version", {
      outputs: ["dist/version.txt"],
      async execute(context) {
        await writeFile(context.resolvePath("dist/version.txt"), "beta\n", "utf8");
      },
    });

    assert.deepEqual((await reckon(first, { cwd })).executed, [first.label]);
    assert.deepEqual((await reckon(second, { cwd })).executed, [second.label]);
    assert.equal(await readFile(path.join(cwd, "dist/version.txt"), "utf8"), "beta\n");

    const createConfiguredTask = (version: string): Task => createCodeTask("generate configured version", {
      outputs: ["dist/configured-version.txt"],
      fingerprint: { version },
      async execute(context) {
        await writeFile(context.resolvePath("dist/configured-version.txt"), `${version}\n`, "utf8");
      },
    });

    assert.deepEqual((await reckon(createConfiguredTask("1.0.0"), { cwd })).executed, ["generate configured version"]);
    assert.deepEqual((await reckon(createConfiguredTask("1.0.0"), { cwd })).skipped, ["generate configured version"]);
    assert.deepEqual((await reckon(createConfiguredTask("1.0.1"), { cwd })).executed, ["generate configured version"]);
    assert.equal(await readFile(path.join(cwd, "dist/configured-version.txt"), "utf8"), "1.0.1\n");
  });
});

test("jsonToFile writes generated content from parsed JSON and tracks input changes", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "package.json"), "{\"version\":\"1.0.0\"}\n", "utf8");

    const target = jsonToFile({
      input: "package.json",
      output: "build/gensrc/version.h",
      async transform(pkg: { version: string }) {
        return `#define VERSION "${pkg.version}"\n`;
      },
    });

    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.deepEqual((await reckon(target, { cwd })).skipped, [target.label]);
    assert.equal(await readFile(path.join(cwd, "build/gensrc/version.h"), "utf8"), "#define VERSION \"1.0.0\"\n");

    await delay(20);
    await writeFile(path.join(cwd, "package.json"), "{\"version\":\"1.0.1\"}\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.equal(await readFile(path.join(cwd, "build/gensrc/version.h"), "utf8"), "#define VERSION \"1.0.1\"\n");
  });
});

test("jsonToFile transform failures surface through BuildFailureError", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, "package.json"), "{\"version\":\"1.0.0\"}\n", "utf8");

    const target = jsonToFile({
      input: "package.json",
      output: "build/gensrc/version.h",
      transform() {
        throw new Error("missing version");
      },
    });

    await assert.rejects(
      () => reckon(target, { cwd }),
      (error: unknown) => {
        assert(error instanceof BuildFailureError);
        assert.deepEqual(error.summary.failed, [target.label]);
        assert.match(error.message, /json package\.json -> build\/gensrc\/version\.h: missing version/);
        return true;
      },
    );
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

test("command file dependency globs rerun when matched files change, appear, or disappear", async () => {
  await withTempDir(async (cwd) => {
    await createWebCommandFixture(cwd);
    await writeFile(path.join(cwd, "web/src/app.js"), "console.log('app v1');\n", "utf8");

    const target = createWebBundleTask(["web/build.mjs", "web/package.json", "web/src/*.js"]);

    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.deepEqual((await reckon(target, { cwd })).skipped, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "web/src/app.js"), "console.log('app v2');\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "web/src/widget.js"), "console.log('widget');\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);

    await delay(20);
    await unlink(path.join(cwd, "web/src/widget.js"));
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
  });
});

test("command file dependency globstar matches top-level and nested files", async () => {
  await withTempDir(async (cwd) => {
    await createWebCommandFixture(cwd);
    await writeFile(path.join(cwd, "web/src/app.js"), "console.log('app');\n", "utf8");

    const target = createWebBundleTask(["web/src/**/*.js"]);

    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.deepEqual((await reckon(target, { cwd })).skipped, [target.label]);

    await delay(20);
    await mkdir(path.join(cwd, "web/src/components"), { recursive: true });
    await writeFile(path.join(cwd, "web/src/components/button.js"), "console.log('button v1');\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "web/src/components/button.js"), "console.log('button v2');\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
  });
});

test("command file dependency globs rebuild when an initially unmatched pattern gains a file", async () => {
  await withTempDir(async (cwd) => {
    await createWebCommandFixture(cwd);

    const target = createWebBundleTask(["web/src/*.js"]);

    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
    assert.deepEqual((await reckon(target, { cwd })).skipped, [target.label]);

    await delay(20);
    await writeFile(path.join(cwd, "web/src/app.js"), "console.log('app');\n", "utf8");
    assert.deepEqual((await reckon(target, { cwd })).executed, [target.label]);
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
    assert(messages.some((message) => new RegExp(`^\\[reckon\\] ✅ ${escapeRegExp(target.label)} \\([^)]+\\)$`).test(message)));
    assert(messages.some((message) => /^\[reckon\] complete: 1 executed, 0 skipped in [^)]+$/.test(message)));
    assert(!messages.some((message) => message.includes(`[reckon] run: ${target.label}`)));

    messages.length = 0;

    const skippedSummary = await reckon(target, { cwd, verbose: true });

    assert.deepEqual(skippedSummary.skipped, [target.label]);
    assert(messages.some((message) => /^\[reckon\] complete: 0 executed, 1 skipped in [^)]+$/.test(message)));
    assert(!messages.some((message) => message.includes("skipped:")));
    assert(!messages.some((message) => message.includes(`✅ ${target.label}`)));
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
