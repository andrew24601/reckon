# Reckon

Reckon is a library-first incremental build system for Node.js. This MVP turns a JavaScript or TypeScript build description into an executable task graph, persists build state under `.reckon/state.json`, skips clean work on repeat runs, and includes thin helpers for file operations and small C builds.

## MVP Scope

- Library-first API via `reckon(...)`
- Persistent incremental rebuilds using file stat signatures and task fingerprints
- Parallel execution of independent tasks
- Built-in `mkdir`, `writeFile`, `copy`, and `command` helpers
- `clang(...)`, `clangTree(...)`, and `executable(...)` helpers for small C projects
- `macOSApp(...)` for assembling unsigned `.app` bundles around built executables
- `pngIcon(...)` for generating `.icns` app icons from a source PNG

Deferred for later phases: watch mode, a standalone CLI, richer cache hashing, and Apple signing/notarization flows.

## Install

```bash
npm install
```

## Run Checks

```bash
npm run check
npm test
```

## Example

The sample C build lives in [examples/c-hello/Reckonfile.ts](examples/c-hello/Reckonfile.ts). An unsigned native macOS AppKit sample lives in [examples/osx-app/Reckonfile.ts](examples/osx-app/Reckonfile.ts).

```bash
npx tsx examples/c-hello/Reckonfile.ts
npx tsx examples/osx-app/Reckonfile.ts
```

Running the same file again with no source changes should skip all tasks. Changing `examples/c-hello/src/util.c` should rebuild only that object file and the final executable. Changing `examples/c-hello/src/util.h` should rebuild both object files and then rebuild the executable.

## API Sketch

```ts
import { clangTree, executable, macOSApp, pngIcon, reckon } from "reckon";

async function build(): Promise<void> {
  const objects = clangTree("src", {
    flags: ["-fobjc-arc"],
  });
  const binary = executable("build/hello", objects, {
    frameworks: ["Cocoa"],
  });
  const icon = pngIcon("resources/AppIcon.png");
  const app = macOSApp("build/Hello.app", binary, {
    bundleIdentifier: "dev.reckon.hello",
    icon,
  });

  await reckon(app, {
    concurrency: 2,
    verbose: true,
    clang: {
      includes: ["src"],
    },
  });
}
```

`clangTree(...)` recursively expands common C-family sources in a folder (`.c`, `.cc`, `.cpp`, `.cxx`, `.m`, `.mm`, and related variants), and `clang(...)` defaults object files to `build/obj`. When sources live under a `src/` directory, Reckon infers a sibling `build/obj` directory and preserves nested source subpaths to avoid object-name collisions. `executable(...)` links with `clang++` automatically when its upstream object tasks come from C++ or Objective-C++ sources, unless you override the compiler explicitly, and supports first-class `frameworks` alongside `libraries` and `libraryPaths` for macOS link steps. `macOSApp(...)` wraps an executable task and emits an unsigned `.app` bundle with `Contents/MacOS`, `Contents/Resources`, and an `Info.plist`. `pngIcon(...)` uses macOS `sips` and `iconutil` to generate a `.icns` file from a PNG and infer its output under a sibling `build/` directory. The macOS sample uses Objective-C++ (`.mm`) plus AppKit/Cocoa; UIKit is not a native macOS framework. `reckon(...)` can also provide task defaults such as `clang.includes`, still supports overriding the object output baseline for a whole build with `reckon(target, { outDir: "artifacts/obj" })`, and can print per-task progress with `verbose: true`.

## Notes

- The MVP stores state locally in `.reckon/state.json` within the consuming project.
- Dirty checking uses task fingerprints plus file `size` and `mtimeMs`.
- C header dependencies are discovered from compiler-emitted dependency files.
- The current implementation assumes a usable `clang` on `PATH` by default.
- `macOSApp(...)` builds an unsigned bundle only; signing and notarization are intentionally left for later.
- `pngIcon(...)` currently targets PNG input and relies on macOS-provided `sips` and `iconutil`.