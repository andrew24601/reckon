# Reckon

Reckon is a library-first incremental build system for Node.js. You describe a build as a graph of tasks in JavaScript or TypeScript, then run that graph with `reckon(...)`. Reckon persists task state under `.reckon/state.json`, skips work when inputs and outputs are unchanged, and executes independent tasks in parallel.

The package is published as ESM. For most projects, use a plain `build.mjs` file and run it with Node. TypeScript build files work well too, but they require a runner such as `tsx`.

## Install

```bash
npm install --save-dev reckon
```

## Quick Start

Create `build.mjs`:

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

Then run:

```bash
node build.mjs
```

`build.mjs` is the recommended default name because Reckon is a library, not a CLI with a special config-file convention. If you prefer TypeScript, `build.ts` is also sensible:

```bash
npm install --save-dev tsx
npx tsx build.ts
```

## What It Does

- Runs task graphs through the `reckon(...)` library API
- Stores incremental state in `.reckon/state.json`
- Skips tasks when fingerprints, declared inputs, discovered dependencies, and outputs are unchanged
- Schedules independent tasks in parallel
- Provides filesystem helpers: `mkdir`, `writeFile`, `copy`, and `command`
- Provides C-family helpers: `clang`, `clangTree`, and `executable`
- Provides unsigned macOS app bundle helpers: `macOSApp`, `appBundle`, and `pngIcon`

## Command Tasks

Use `command(...)` for external tools that are not covered by a built-in helper. Declare outputs explicitly, and list any source files or config files in `fileDependencies`:

```js
import { command, reckon } from "reckon";

const webBundle = command("npm", ["run", "build"], {
  cwd: "web",
  outputs: ["web/dist/app.bundle.js"],
  fileDependencies: ["web/build.mjs", "web/package.json", "web/src/*.js"],
});

await reckon(webBundle);
```

`fileDependencies` supports `*`, `?`, and `**` wildcards. Reckon expands those patterns to concrete files when checking whether the task is dirty, so matching file additions, removals, and edits trigger a rebuild. Outputs remain explicit paths.

## C Builds

```js
import { clangTree, executable, reckon } from "reckon";

const objects = clangTree("src", {
  flags: ["-Wall"],
});

const binary = executable("build/tool", objects);

await reckon(binary, {
  concurrency: 4,
  verbose: true,
  clang: {
    includes: ["src"],
  },
});
```

`clangTree(...)` recursively discovers common C-family source extensions including `.c`, `.cc`, `.cpp`, `.cxx`, `.m`, and `.mm`. `clang(...)` emits compiler dependency files so header changes invalidate the right objects. Object outputs default to `build/obj`; sources under `src/` infer a sibling `build/obj` directory while preserving nested subpaths.

`executable(...)` links object tasks into a binary and automatically switches to `clang++` when upstream objects come from C++ or Objective-C++ sources, unless you override the compiler explicitly.

## macOS App Bundles

```js
import { clangTree, executable, macOSApp, pngIcon, reckon } from "reckon";

const objects = clangTree("src", {
  flags: ["-fobjc-arc"],
});

const binary = executable("build/Hello", objects, {
  frameworks: ["Cocoa"],
});

const icon = pngIcon("resources/AppIcon.png");

const app = macOSApp("build/Hello.app", binary, {
  bundleIdentifier: "dev.example.hello",
  icon,
  resources: [
    { source: "resources/README.txt" },
  ],
});

await reckon(app);
```

`macOSApp(...)` assembles an unsigned `.app` bundle with `Contents/MacOS`, `Contents/Resources`, and `Contents/Info.plist`. It does not sign, notarize, provision, or create a DMG. `pngIcon(...)` accepts PNG input only and relies on the macOS `sips` and `iconutil` tools to produce `.icns` files.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Before publishing:

```bash
npm run release:check
npm publish --provenance
```

`npm run pack:dry-run` shows the files that would be included in the published tarball. The package exports only the ESM entry point at `dist/index.js` plus generated TypeScript declarations.

## Current Scope

Reckon is intentionally small. It currently does not include a standalone CLI, watch mode, iOS packaging, code signing, notarization, provisioning profile support, DMG creation, or SVG icon conversion.
