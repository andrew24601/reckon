# Reckon

Reckon is a library-first incremental build system for Node.js. Users define a build as a graph of tasks in JavaScript or TypeScript, then execute that graph with `reckon(...)`. Reckon persists task state under `.reckon/state.json`, skips work when inputs and outputs are unchanged, and executes independent tasks in parallel.

## Package Shape

- npm package name: `reckon`
- ESM-only package: `"type": "module"` with `exports["."].import` pointing at `dist/index.js`
- Type declarations are emitted to `dist/index.d.ts`
- Source files are TypeScript under `src/`
- Published files are restricted by `package.json#files`
- There is no standalone CLI; consumers run their own build file with Node or a TypeScript runner

For docs and examples, prefer `build.mjs` as the default consumer build-file name:

```js
import { clangTree, executable, reckon } from "reckon";

const objects = clangTree("src");
const app = executable("build/hello", objects);

await reckon(app, {
  verbose: true,
  clang: {
    includes: ["src"],
  },
});
```

`Reckonfile.*` is acceptable inside this repository's examples, but do not imply that Reckon has a special config-file convention. For TypeScript consumer examples, prefer `build.ts` plus `tsx`.

## Implemented Scope

- Library API, not a standalone CLI
- Persistent incremental rebuilds using task fingerprints plus file stat signatures
- Parallel scheduling of independent tasks
- Built-in filesystem helpers: `mkdir`, `writeFile`, `copy`, and `command`
- Code-based task helpers: `task` for arbitrary JavaScript/TypeScript build steps and `jsonToFile` for JSON-driven generated files
- C-family helpers: `clang`, `clangTree`, and `executable`
- macOS packaging helpers: `macOSApp` and `appBundle` for unsigned `.app` bundles
- `pngIcon` for generating `.icns` files from PNG input on macOS

Not implemented in the current codebase:

- iOS app packaging
- code signing, notarization, or provisioning profile support
- DMG creation
- SVG icon conversion
- watch mode or a dedicated command-line interface

## Behavior

Reckon records each task's fingerprint, declared inputs, declared outputs, and any discovered dependencies. On later runs, it rebuilds only when a task definition changes, an output is missing or changed, a declared file dependency changes, or a discovered dependency changes.

Prefer code-based tasks over `command(...)` when the work can be expressed clearly in JavaScript or TypeScript without invoking an external tool. Use `task(...)` for low-level in-process build steps and `jsonToFile(...)` for generated files derived from JSON inputs. If a task callback closes over configuration values, include those values in the task's explicit fingerprint so incremental rebuilds stay correct.

For C-family compilation, `clang(...)` emits dependency files and uses them to track header dependencies automatically. `clangTree(...)` recursively discovers common C-family source extensions such as `.c`, `.cc`, `.cpp`, `.cxx`, `.m`, and `.mm`. Object outputs default to `build/obj`, and sources under `src/` infer a sibling `build/obj` directory while preserving nested subpaths.

`executable(...)` links object tasks into a binary and automatically switches to `clang++` when upstream objects come from C++ or Objective-C++ sources, unless the compiler is overridden explicitly.

## macOS Support

The implemented macOS support is limited to building unsigned application bundles:

- `macOSApp(...)` assembles a `.app` bundle around an executable task
- it creates `Contents/MacOS`, `Contents/Resources`, and `Contents/Info.plist`
- resources can be copied into the bundle
- icons must already be `.icns`, or can be produced by `pngIcon(...)`

`pngIcon(...)` currently accepts PNG input only and relies on the macOS `sips` and `iconutil` tools to generate the final `.icns` file.

## Documentation Maintenance

When adding, removing, or materially changing public features, helper APIs, task behavior, package shape, architecture, or implemented scope, update both `README.md` and `AGENTS.md` in the same change. Keep examples aligned with the library-first API and avoid documenting capabilities that are not implemented.

## Verification

Use these before publishing:

```bash
npm run release:check
npm publish --provenance
```

`release:check` runs type-checking, tests, build output generation, and an npm dry-run pack.
