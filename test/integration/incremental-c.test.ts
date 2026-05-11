import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import { clang, clangTree, executable, macOSApp, pngIcon, reckon } from "../../src";

const execFileAsync = promisify(execFile);

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "reckon-c-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeExampleFiles(cwd: string): Promise<void> {
  const srcDir = path.join(cwd, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "util.h"), "#ifndef UTIL_H\n#define UTIL_H\n\nint answer(void);\n\n#endif\n", "utf8");
  await writeFile(path.join(srcDir, "util.c"), "#include \"util.h\"\n\nint answer(void) {\n    return 42;\n}\n", "utf8");
  await writeFile(path.join(srcDir, "main.c"), "#include <stdio.h>\n\n#include \"util.h\"\n\nint main(void) {\n    printf(\"answer=%d\\n\", answer());\n    return 0;\n}\n", "utf8");
}

async function writeSplitIncludeFiles(cwd: string): Promise<void> {
  const includeDir = path.join(cwd, "include");
  const srcDir = path.join(cwd, "src");
  await mkdir(includeDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(includeDir, "util.h"), "#ifndef UTIL_H\n#define UTIL_H\n\nint answer(void);\n\n#endif\n", "utf8");
  await writeFile(path.join(srcDir, "util.c"), "#include \"util.h\"\n\nint answer(void) {\n    return 42;\n}\n", "utf8");
  await writeFile(path.join(srcDir, "main.c"), "#include <stdio.h>\n\n#include \"util.h\"\n\nint main(void) {\n    printf(\"answer=%d\\n\", answer());\n    return 0;\n}\n", "utf8");
}

async function writeNestedTreeFiles(cwd: string): Promise<void> {
  const srcDir = path.join(cwd, "src");
  const featureDir = path.join(srcDir, "feature");
  const libraryDir = path.join(srcDir, "lib");
  await mkdir(featureDir, { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  await writeFile(
    path.join(srcDir, "main.c"),
    "#include <stdio.h>\n\n#include \"feature/util.h\"\n#include \"lib/util.h\"\n\nint main(void) {\n    printf(\"total=%d\\n\", feature_answer() + library_answer());\n    return 0;\n}\n",
    "utf8",
  );
  await writeFile(path.join(featureDir, "util.h"), "#ifndef FEATURE_UTIL_H\n#define FEATURE_UTIL_H\n\nint feature_answer(void);\n\n#endif\n", "utf8");
  await writeFile(path.join(featureDir, "util.c"), "#include \"feature/util.h\"\n\nint feature_answer(void) {\n    return 40;\n}\n", "utf8");
  await writeFile(path.join(libraryDir, "util.h"), "#ifndef LIB_UTIL_H\n#define LIB_UTIL_H\n\nint library_answer(void);\n\n#endif\n", "utf8");
  await writeFile(path.join(libraryDir, "util.c"), "#include \"lib/util.h\"\n\nint library_answer(void) {\n    return 2;\n}\n", "utf8");
}

async function writeCppTreeFiles(cwd: string): Promise<void> {
  const srcDir = path.join(cwd, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "util.hpp"), "#pragma once\n\nint answer();\n", "utf8");
  await writeFile(path.join(srcDir, "util.cpp"), "#include \"util.hpp\"\n\nint answer() {\n    return 42;\n}\n", "utf8");
  await writeFile(
    path.join(srcDir, "main.cpp"),
    "#include <iostream>\n\n#include \"util.hpp\"\n\nint main() {\n    std::cout << \"answer=\" << answer() << std::endl;\n    return 0;\n}\n",
    "utf8",
  );
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.concat([typeBuffer, data]);
  let crc = 0xffffffff;

  for (const byte of chunk) {
    crc ^= byte;

    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);

  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  return Buffer.concat([lengthBuffer, chunk, crcBuffer]);
}

async function writeSolidPng(filePath: string, red: number, green: number, blue: number): Promise<void> {
  const width = 1024;
  const height = 1024;
  const rowLength = (width * 4) + 1;
  const raw = Buffer.alloc(rowLength * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;

    for (let x = 0; x < width; x += 1) {
      const pixelOffset = rowOffset + 1 + (x * 4);
      raw[pixelOffset] = red;
      raw[pixelOffset + 1] = green;
      raw[pixelOffset + 2] = blue;
      raw[pixelOffset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", deflateSync(raw)),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);

  await writeFile(filePath, png);
}

async function writeIconSource(cwd: string, red: number, green: number, blue: number): Promise<void> {
  const assetsDir = path.join(cwd, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeSolidPng(path.join(assetsDir, "AppIcon.png"), red, green, blue);
}

function createCTargets() {
  const mainObject = clang("src/main.c");
  const utilObject = clang("src/util.c");
  const executableTask = executable("build/hello", [mainObject, utilObject]);

  return { mainObject, utilObject, executable: executableTask };
}

function createTreeTargets(cwd: string) {
  const objects = clangTree("src", { cwd });
  const executableTask = executable("build/hello", objects);

  return { objects, executable: executableTask };
}

function createCppTreeTargets(cwd: string) {
  const objects = clangTree("src", { cwd });
  const executableTask = executable("build/hello", objects);

  return { objects, executable: executableTask };
}

function createAppBundleTargets() {
  const targets = createCTargets();
  const bundleTask = macOSApp("build/Hello.app", targets.executable, {
    bundleIdentifier: "dev.reckon.tests.hello",
  });

  return {
    ...targets,
    bundle: bundleTask,
  };
}

function createIconBundleTargets() {
  const targets = createCTargets();
  const iconTask = pngIcon("assets/AppIcon.png");
  const bundleTask = macOSApp("build/Hello.app", targets.executable, {
    bundleIdentifier: "dev.reckon.tests.hello",
    icon: iconTask,
  });

  return {
    ...targets,
    icon: iconTask,
    bundle: bundleTask,
  };
}

test("C tasks rebuild only the affected object files", async () => {
  await withTempDir(async (cwd) => {
    await writeExampleFiles(cwd);

    const firstTargets = createCTargets();
    const first = await reckon(firstTargets.executable, { cwd, concurrency: 2 });
    assert.equal(first.executed.length, 3);

    const binaryOutput = await execFileAsync(path.join(cwd, "build/hello"));
    assert.equal(binaryOutput.stdout, "answer=42\n");

    const secondTargets = createCTargets();
    const second = await reckon(secondTargets.executable, { cwd, concurrency: 2 });
    assert.equal(second.skipped.length, 3);

    await delay(20);
    await writeFile(
      path.join(cwd, "src/util.c"),
      "#include \"util.h\"\n\nint answer(void) {\n    return 64;\n}\n",
      "utf8",
    );

    const thirdTargets = createCTargets();
    const third = await reckon(thirdTargets.executable, { cwd, concurrency: 2 });
    assert.deepEqual(new Set(third.executed), new Set([thirdTargets.utilObject.label, thirdTargets.executable.label]));
    assert.deepEqual(third.skipped, [thirdTargets.mainObject.label]);
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "answer=64\n");

    await delay(20);
    await writeFile(
      path.join(cwd, "src/util.h"),
      "#ifndef UTIL_H\n#define UTIL_H\n\nint answer(void);\nint offset(void);\n\n#endif\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, "src/util.c"),
      "#include \"util.h\"\n\nint offset(void) {\n    return 1;\n}\n\nint answer(void) {\n    return 64 + offset();\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, "src/main.c"),
      "#include <stdio.h>\n\n#include \"util.h\"\n\nint main(void) {\n    printf(\"answer=%d\\n\", answer());\n    return 0;\n}\n",
      "utf8",
    );

    const fourthTargets = createCTargets();
    const fourth = await reckon(fourthTargets.executable, { cwd, concurrency: 2 });
    assert.deepEqual(
      new Set(fourth.executed),
      new Set([fourthTargets.mainObject.label, fourthTargets.utilObject.label, fourthTargets.executable.label]),
    );
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "answer=65\n");
    assert.match(await readFile(path.join(cwd, ".reckon/state.json"), "utf8"), /clang:build\/obj\/main\.o/);
  });
});

test("clang defaults from reckon apply to all clang tasks", async () => {
  await withTempDir(async (cwd) => {
    await writeSplitIncludeFiles(cwd);

    const targets = createCTargets();
    const summary = await reckon(targets.executable, {
      cwd,
      concurrency: 2,
      clang: {
        includes: ["include"],
      },
    });

    assert.equal(summary.executed.length, 3);
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "answer=42\n");

    const secondTargets = createCTargets();
    const second = await reckon(secondTargets.executable, {
      cwd,
      concurrency: 2,
      clang: {
        includes: ["include"],
      },
    });
    assert.equal(second.skipped.length, 3);
  });
});

test("clang tasks honor a build-level outDir baseline", async () => {
  await withTempDir(async (cwd) => {
    await writeExampleFiles(cwd);

    const targets = createCTargets();
    const summary = await reckon(targets.executable, {
      cwd,
      concurrency: 2,
      outDir: "artifacts/obj",
    });

    assert.equal(summary.executed.length, 3);
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "answer=42\n");
    assert.match(await readFile(path.join(cwd, ".reckon/state.json"), "utf8"), /clang:artifacts\/obj\/main\.o/);
  });
});

test("clangTree compiles nested source trees without object collisions", async () => {
  await withTempDir(async (cwd) => {
    await writeNestedTreeFiles(cwd);

    const firstTargets = createTreeTargets(cwd);
    const first = await reckon(firstTargets.executable, {
      cwd,
      concurrency: 2,
      clang: {
        includes: ["src"],
      },
    });

    assert.equal(first.executed.length, 4);
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "total=42\n");

    const stateContents = await readFile(path.join(cwd, ".reckon/state.json"), "utf8");
    assert.match(stateContents, /clang:build\/obj\/feature\/util\.o/);
    assert.match(stateContents, /clang:build\/obj\/lib\/util\.o/);

    const secondTargets = createTreeTargets(cwd);
    const second = await reckon(secondTargets.executable, {
      cwd,
      concurrency: 2,
      clang: {
        includes: ["src"],
      },
    });

    assert.equal(second.skipped.length, 4);
  });
});

test("clangTree discovers C++ sources and executable infers clang++", async () => {
  await withTempDir(async (cwd) => {
    await writeCppTreeFiles(cwd);

    const targets = createCppTreeTargets(cwd);
    const first = await reckon(targets.executable, { cwd, concurrency: 2 });
    assert.equal(first.executed.length, 3);
    assert.equal((await execFileAsync(path.join(cwd, "build/hello"))).stdout, "answer=42\n");

    const secondTargets = createCppTreeTargets(cwd);
    const second = await reckon(secondTargets.executable, { cwd, concurrency: 2 });
    assert.equal(second.skipped.length, 3);
  });
});

test("executable expands framework defaults and options into linker arguments", async () => {
  const objectTask = clang("src/main.m");
  const target = executable("build/app", [objectTask], {
    frameworks: ["Cocoa"],
    libraries: ["z"],
  });
  const resolved = target.resolve?.({
    options: {
      executable: {
        frameworks: ["Foundation"],
      },
    },
    resolveTask(task) {
      return task;
    },
  }) ?? target;
  const commands: Array<{ command: string; args: readonly string[] }> = [];

  await resolved.execute({
    cwd: "/tmp/reckon-frameworks-test",
    resolvePath(filePath) {
      return path.posix.join("/tmp/reckon-frameworks-test", filePath);
    },
    async runCommand(commandName, args) {
      commands.push({ command: commandName, args });
    },
  });

  assert.deepEqual(commands, [
    {
      command: "clang",
      args: [
        "/tmp/reckon-frameworks-test/build/obj/main.o",
        "-framework",
        "Foundation",
        "-framework",
        "Cocoa",
        "-lz",
        "-o",
        "/tmp/reckon-frameworks-test/build/app",
      ],
    },
  ]);
});

test("appBundle builds and incrementally refreshes a macOS app bundle", async () => {
  await withTempDir(async (cwd) => {
    await writeExampleFiles(cwd);

    const firstTargets = createAppBundleTargets();
    const first = await reckon(firstTargets.bundle, { cwd, concurrency: 2 });
    assert.equal(first.executed.length, 4);

    const bundleExecutable = path.join(cwd, "build/Hello.app/Contents/MacOS/Hello");
    assert.equal((await execFileAsync(bundleExecutable)).stdout, "answer=42\n");

    const infoPlist = await readFile(path.join(cwd, "build/Hello.app/Contents/Info.plist"), "utf8");
    assert.match(infoPlist, /<key>CFBundleDisplayName<\/key>\s*<string>Hello<\/string>/);
    assert.match(infoPlist, /<key>CFBundleExecutable<\/key>\s*<string>Hello<\/string>/);
    assert.match(infoPlist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.reckon\.tests\.hello<\/string>/);
    assert.match(infoPlist, /<key>CFBundleName<\/key>\s*<string>Hello<\/string>/);

    const secondTargets = createAppBundleTargets();
    const second = await reckon(secondTargets.bundle, { cwd, concurrency: 2 });
    assert.equal(second.skipped.length, 4);

    await delay(20);
    await writeFile(
      path.join(cwd, "src/util.c"),
      "#include \"util.h\"\n\nint answer(void) {\n    return 64;\n}\n",
      "utf8",
    );

    const thirdTargets = createAppBundleTargets();
    const third = await reckon(thirdTargets.bundle, { cwd, concurrency: 2 });
    assert.deepEqual(new Set(third.executed), new Set([thirdTargets.utilObject.label, thirdTargets.executable.label, thirdTargets.bundle.label]));
    assert.deepEqual(third.skipped, [thirdTargets.mainObject.label]);
    assert.equal((await execFileAsync(bundleExecutable)).stdout, "answer=64\n");
  });
});

test("pngIcon generates an app icon and triggers bundle rebuilds when the PNG changes", async () => {
  await withTempDir(async (cwd) => {
    await writeExampleFiles(cwd);
    await writeIconSource(cwd, 255, 94, 58);

    const firstTargets = createIconBundleTargets();
    const first = await reckon(firstTargets.bundle, { cwd, concurrency: 2 });
    assert.equal(first.executed.length, 5);

    await readFile(path.join(cwd, "build/AppIcon.icns"));
    await readFile(path.join(cwd, "build/Hello.app/Contents/Resources/AppIcon.icns"));

    const infoPlist = await readFile(path.join(cwd, "build/Hello.app/Contents/Info.plist"), "utf8");
    assert.match(infoPlist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon\.icns<\/string>/);

    const secondTargets = createIconBundleTargets();
    const second = await reckon(secondTargets.bundle, { cwd, concurrency: 2 });
    assert.equal(second.skipped.length, 5);

    await delay(20);
    await writeIconSource(cwd, 16, 132, 255);

    const thirdTargets = createIconBundleTargets();
    const third = await reckon(thirdTargets.bundle, { cwd, concurrency: 2 });
    assert.deepEqual(new Set(third.executed), new Set([thirdTargets.icon.label, thirdTargets.bundle.label]));
    assert.deepEqual(new Set(third.skipped), new Set([thirdTargets.mainObject.label, thirdTargets.utilObject.label, thirdTargets.executable.label]));
  });
});