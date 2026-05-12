import { clangTree, executable, reckon } from "../../src/index.js";

async function main(): Promise<void> {
  const objects = clangTree("examples/c-hello/src");
  const app = executable("examples/c-hello/build/hello", objects);

  await reckon(app, {
    verbose: true,
    clang: {
      includes: ["examples/c-hello/src"],
    },
  });
}

void main();
