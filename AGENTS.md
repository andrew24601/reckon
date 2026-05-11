# Reckon

Reckon is a library-first incremental build system for Node.js. You define a build as a graph of tasks in JavaScript or TypeScript, then run that graph with `reckon(...)`. Reckon persists task state under `.reckon/state.json`, skips work when inputs and outputs are unchanged, and executes independent tasks in parallel.

The current implementation is intentionally small and focused. It provides a core scheduler plus a few built-in task helpers for filesystem work, C-family compilation, executable linking, and unsigned macOS app bundling.

## Implemented Scope

- Library API, not a standalone CLI
- Persistent incremental rebuilds using task fingerprints plus file stat signatures
- Parallel scheduling of independent tasks
- Built-in filesystem helpers: `mkdir`, `writeFile`, `copy`, and `command`
- C-family helpers: `clang`, `clangTree`, and `executable`
- macOS packaging helpers: `macOSApp` and `appBundle` for unsigned `.app` bundles
- `pngIcon` for generating `.icns` files from PNG input on macOS

Not implemented in the current codebase:

- iOS app packaging
- code signing, notarization, or provisioning profile support
- DMG creation
- SVG icon conversion
- watch mode or a dedicated command-line interface

## Example

```ts
import { clangTree, executable, reckon } from "reckon";

async function build(): Promise<void> {
    const objects = clangTree("src");
    const app = executable("build/hello", objects);

    await reckon(app, {
        verbose: true,
        clang: {
            includes: ["src"],
        },
    });
}

void build();
```

This reflects the implemented API: compile sources with `clang(...)` or `clangTree(...)`, link them with `executable(...)`, and execute the graph with `reckon(...)`.

## Behavior

Reckon records each task's fingerprint, declared inputs, declared outputs, and any discovered dependencies. On later runs, it rebuilds only when a task definition changes, an output is missing or changed, a declared file dependency changes, or a discovered dependency changes.

For C-family compilation, `clang(...)` emits dependency files and uses them to track header dependencies automatically. `clangTree(...)` recursively discovers common C-family source extensions such as `.c`, `.cc`, `.cpp`, `.cxx`, `.m`, and `.mm`. Object outputs default to `build/obj`, and sources under `src/` infer a sibling `build/obj` directory while preserving nested subpaths.

`executable(...)` links object tasks into a binary and automatically switches to `clang++` when upstream objects come from C++ or Objective-C++ sources, unless the compiler is overridden explicitly.

## macOS Support

The implemented macOS support is limited to building unsigned application bundles:

- `macOSApp(...)` assembles a `.app` bundle around an executable task
- it creates `Contents/MacOS`, `Contents/Resources`, and `Contents/Info.plist`
- resources can be copied into the bundle
- icons must already be `.icns`, or can be produced by `pngIcon(...)`

`pngIcon(...)` currently accepts PNG input only and relies on the macOS `sips` and `iconutil` tools to generate the final `.icns` file.
