import { chmod, copyFile, mkdir as mkdirDirectory, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFingerprint, normalizeBuildPath } from "../core/signatures.js";
import type { Task } from "../core/types.js";

export interface MacOSAppResource {
  readonly source: string | Task;
  readonly destination?: string;
}

export interface MacOSAppOptions {
  readonly bundleIdentifier: string;
  readonly bundleName?: string;
  readonly displayName?: string;
  readonly executableName?: string;
  readonly version?: string;
  readonly shortVersion?: string;
  readonly minimumSystemVersion?: string;
  readonly icon?: string | Task;
  readonly iconFile?: string;
  readonly resources?: readonly MacOSAppResource[];
  readonly infoPlistEntries?: Readonly<Record<string, string | number | boolean>>;
}

export type AppBundleResource = MacOSAppResource;
export type AppBundleOptions = MacOSAppOptions;

interface IconVariant {
  readonly fileName: string;
  readonly size: number;
}

interface NormalizedMacOSAppResource {
  readonly source: string;
  readonly destination: string;
  readonly taskDependency?: Task;
}

interface ResolvedMacOSAppIcon {
  readonly source: string;
  readonly fileName: string;
  readonly taskDependency?: Task;
}

const pngIconVariants: readonly IconVariant[] = [
  { fileName: "icon_16x16.png", size: 16 },
  { fileName: "icon_16x16@2x.png", size: 32 },
  { fileName: "icon_32x32.png", size: 32 },
  { fileName: "icon_32x32@2x.png", size: 64 },
  { fileName: "icon_128x128.png", size: 128 },
  { fileName: "icon_128x128@2x.png", size: 256 },
  { fileName: "icon_256x256.png", size: 256 },
  { fileName: "icon_256x256@2x.png", size: 512 },
  { fileName: "icon_512x512.png", size: 512 },
  { fileName: "icon_512x512@2x.png", size: 1024 },
];

const pngIconSourceDirectories = new Set(["assets", "resources", "icons", "src"]);

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serializePlistValue(value: string | number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "<true/>" : "<false/>";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }

  return `<string>${escapeXml(value)}</string>`;
}

function normalizeResourceDestination(destination: string): string {
  const normalizedDestination = normalizeBuildPath(destination);

  if (
    normalizedDestination === ""
    || normalizedDestination === "."
    || path.isAbsolute(destination)
    || normalizedDestination === ".."
    || normalizedDestination.startsWith("../")
  ) {
    throw new Error(`App bundle resource destination must stay within Contents/Resources: ${destination}`);
  }

  return normalizedDestination;
}

function resolveMacOSAppResourceSource(source: string | Task): Pick<NormalizedMacOSAppResource, "source" | "taskDependency"> {
  if (typeof source === "string") {
    return {
      source: normalizeBuildPath(source),
    };
  }

  const output = source.outputs[0];

  if (!output) {
    throw new Error(`Task ${source.label} does not declare a resource output to bundle`);
  }

  return {
    source: normalizeBuildPath(output),
    taskDependency: source,
  };
}

function normalizeResource(resource: MacOSAppResource): NormalizedMacOSAppResource {
  const resolvedResource = resolveMacOSAppResourceSource(resource.source);

  return {
    ...resolvedResource,
    destination: normalizeResourceDestination(resource.destination ?? path.basename(resolvedResource.source)),
  };
}

function inferPngIconOutput(source: string): string {
  const normalizedSource = normalizeBuildPath(source);
  const parsedSource = path.parse(normalizedSource);
  const segments = normalizeBuildPath(parsedSource.dir).split("/").filter((segment) => segment !== "" && segment !== ".");
  let sourceDirectoryIndex = -1;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (pngIconSourceDirectories.has(segments[index])) {
      sourceDirectoryIndex = index;
      break;
    }
  }

  const baseDirectory = sourceDirectoryIndex === -1
    ? parsedSource.dir
    : normalizeBuildPath(path.join(...segments.slice(0, sourceDirectoryIndex)));

  return normalizeBuildPath(path.join(baseDirectory || ".", "build", `${parsedSource.name}.icns`));
}

function resolveMacOSAppIcon(icon: string | Task | undefined, iconFile: string | undefined): ResolvedMacOSAppIcon | undefined {
  if (icon && iconFile) {
    throw new Error("macOSApp accepts either icon or iconFile, but not both");
  }

  if (!icon && !iconFile) {
    return undefined;
  }

  if (typeof icon === "string") {
    const source = normalizeBuildPath(icon);

    if (path.extname(source).toLowerCase() !== ".icns") {
      throw new Error(`macOS app icons must be .icns files: ${source}`);
    }

    return {
      source,
      fileName: path.basename(source),
    };
  }

  if (typeof iconFile === "string") {
    const source = normalizeBuildPath(iconFile);

    if (path.extname(source).toLowerCase() !== ".icns") {
      throw new Error(`macOS app icons must be .icns files: ${source}`);
    }

    return {
      source,
      fileName: path.basename(source),
    };
  }

  if (!icon) {
    return undefined;
  }

  const source = icon.outputs[0];

  if (!source) {
    throw new Error(`Task ${icon.label} does not declare an icon output to bundle`);
  }

  const normalizedSource = normalizeBuildPath(source);

  if (path.extname(normalizedSource).toLowerCase() !== ".icns") {
    throw new Error(`Task ${icon.label} must produce a .icns output to use as a macOS app icon`);
  }

  return {
    source: normalizedSource,
    fileName: path.basename(normalizedSource),
    taskDependency: icon,
  };
}

function createInfoPlist(bundleName: string, displayName: string, executableName: string, options: MacOSAppOptions, iconFileName?: string): string {
  const plistEntries: Record<string, string | number | boolean> = {
    CFBundleDevelopmentRegion: "English",
    CFBundleDisplayName: displayName,
    CFBundleExecutable: executableName,
    CFBundleIdentifier: options.bundleIdentifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: bundleName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: options.shortVersion ?? options.version ?? "1.0",
    CFBundleVersion: options.version ?? "1",
    ...(options.minimumSystemVersion ? { LSMinimumSystemVersion: options.minimumSystemVersion } : {}),
    ...(iconFileName ? { CFBundleIconFile: iconFileName } : {}),
    ...(options.infoPlistEntries ?? {}),
  };

  const entries = Object.entries(plistEntries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `  <key>${escapeXml(key)}</key>\n  ${serializePlistValue(value)}`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    entries,
    '</dict>',
    '</plist>',
    '',
  ].join("\n");
}

function createMacOSAppTask(bundlePath: string, executable: Task, options: MacOSAppOptions): Task {
  const normalizedBundlePath = normalizeBuildPath(bundlePath);
  const bundleStem = path.basename(normalizedBundlePath, ".app");
  const bundleName = options.bundleName ?? bundleStem;
  const displayName = options.displayName ?? bundleName;
  const executableName = options.executableName ?? bundleStem;
  const sourceExecutable = executable.outputs[0];
  const resolvedIcon = resolveMacOSAppIcon(options.icon, options.iconFile);

  if (!sourceExecutable) {
    throw new Error(`Task ${executable.label} does not declare an executable output to bundle`);
  }

  const normalizedResources = [
    ...(resolvedIcon ? [normalizeResource({ source: resolvedIcon.source })] : []),
    ...(options.resources ?? []).map((resource) => normalizeResource(resource)),
  ];
  const contentsPath = normalizeBuildPath(path.join(normalizedBundlePath, "Contents"));
  const macOSPath = normalizeBuildPath(path.join(contentsPath, "MacOS"));
  const resourcesPath = normalizeBuildPath(path.join(contentsPath, "Resources"));
  const infoPlistPath = normalizeBuildPath(path.join(contentsPath, "Info.plist"));
  const bundledExecutablePath = normalizeBuildPath(path.join(macOSPath, executableName));
  const resourceOutputs = normalizedResources.map((resource) => normalizeBuildPath(path.join(resourcesPath, resource.destination)));

  return {
    id: `macOSApp:${normalizedBundlePath}`,
    label: `macOS app ${normalizedBundlePath}`,
    outputs: [normalizedBundlePath, contentsPath, macOSPath, resourcesPath, infoPlistPath, bundledExecutablePath, ...resourceOutputs],
    fileDependencies: normalizedResources
      .filter((resource) => resource.taskDependency === undefined)
      .map((resource) => resource.source),
    taskDependencies: [
      executable,
      ...(resolvedIcon?.taskDependency ? [resolvedIcon.taskDependency] : []),
      ...normalizedResources.flatMap((resource) => resource.taskDependency ? [resource.taskDependency] : []),
    ],
    fingerprint: createFingerprint({
      kind: "macOSApp",
      bundlePath: normalizedBundlePath,
      sourceExecutable,
      executableName,
      icon: resolvedIcon?.source,
      options,
      resources: normalizedResources,
    }),
    async execute(context) {
      const resolvedBundlePath = context.resolvePath(normalizedBundlePath);
      const resolvedContentsPath = path.join(resolvedBundlePath, "Contents");
      const resolvedMacOSPath = path.join(resolvedContentsPath, "MacOS");
      const resolvedResourcesPath = path.join(resolvedContentsPath, "Resources");
      const resolvedBundledExecutablePath = path.join(resolvedMacOSPath, executableName);
      const resolvedSourceExecutablePath = context.resolvePath(sourceExecutable);

      await rm(resolvedBundlePath, { recursive: true, force: true });
      await Promise.all([
        mkdirDirectory(resolvedMacOSPath, { recursive: true }),
        mkdirDirectory(resolvedResourcesPath, { recursive: true }),
      ]);

      await copyFile(resolvedSourceExecutablePath, resolvedBundledExecutablePath);
      const sourceExecutableStats = await stat(resolvedSourceExecutablePath);
      await chmod(resolvedBundledExecutablePath, sourceExecutableStats.mode);
      await writeFile(path.join(resolvedContentsPath, "Info.plist"), createInfoPlist(bundleName, displayName, executableName, options, resolvedIcon?.fileName), "utf8");

      await Promise.all(
        normalizedResources.map(async (resource) => {
          const resolvedDestinationPath = path.join(resolvedResourcesPath, resource.destination);
          await mkdirDirectory(path.dirname(resolvedDestinationPath), { recursive: true });
          await copyFile(context.resolvePath(resource.source), resolvedDestinationPath);
        }),
      );
    },
  };
}

function createPngIconTask(source: string): Task {
  const normalizedSource = normalizeBuildPath(source);
  const normalizedOutput = inferPngIconOutput(normalizedSource);

  if (path.extname(normalizedSource).toLowerCase() !== ".png") {
    throw new Error(`pngIcon sources must use the .png extension: ${normalizedSource}`);
  }

  return {
    id: `pngIcon:${normalizedOutput}`,
    label: `png icon ${normalizedSource}`,
    outputs: [normalizedOutput],
    fileDependencies: [normalizedSource],
    taskDependencies: [],
    fingerprint: createFingerprint({
      kind: "pngIcon",
      output: normalizedOutput,
      source: normalizedSource,
      variants: pngIconVariants,
    }),
    async execute(context) {
      const resolvedOutput = context.resolvePath(normalizedOutput);
      const resolvedSource = context.resolvePath(normalizedSource);
      const outputDirectory = path.dirname(resolvedOutput);
      await mkdirDirectory(outputDirectory, { recursive: true });
      const tempRoot = await mkdtemp(path.join(outputDirectory, `.${path.basename(normalizedOutput, ".icns")}-`));
      const iconsetPath = path.join(tempRoot, `${path.basename(normalizedOutput, ".icns")}.iconset`);

      try {
        await mkdirDirectory(iconsetPath, { recursive: true });

        for (const variant of pngIconVariants) {
          const destination = path.join(iconsetPath, variant.fileName);
          await context.runCommand("sips", ["-z", String(variant.size), String(variant.size), resolvedSource, "--out", destination]);
        }

        await context.runCommand("iconutil", ["-c", "icns", iconsetPath, "-o", resolvedOutput]);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}

export function macOSApp(bundlePath: string, executable: Task, options: MacOSAppOptions): Task {
  const normalizedBundlePath = normalizeBuildPath(bundlePath);
  const task = createMacOSAppTask(normalizedBundlePath, executable, options);

  return {
    ...task,
    resolve(context) {
      return createMacOSAppTask(normalizedBundlePath, context.resolveTask(executable), options);
    },
  };
}

export function appBundle(bundlePath: string, executable: Task, options: AppBundleOptions): Task {
  return macOSApp(bundlePath, executable, options);
}

export function pngIcon(source: string): Task {
  return createPngIconTask(source);
}