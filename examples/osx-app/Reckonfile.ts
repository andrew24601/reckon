import { clangTree, executable, macOSApp, pngIcon, reckon } from "../../src";

async function main(): Promise<void> {
  const objects = clangTree("examples/osx-app/src", {
    flags: ["-fobjc-arc"],
  });
  const binary = executable("examples/osx-app/build/Hello", objects, {
    frameworks: ["Cocoa"],
  });
  const icon = pngIcon("examples/osx-app/resources/AppIcon.png");
  const app = macOSApp("examples/osx-app/build/Hello.app", binary, {
    bundleIdentifier: "dev.reckon.examples.hello",
    icon,
    resources: [
      {
        source: "examples/osx-app/resources/README.txt",
      },
    ],
  });

  await reckon(app);
}

void main();