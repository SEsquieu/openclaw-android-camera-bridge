import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

type Facing = "front" | "back";

type PluginConfig = {
  defaultNode?: string;
  tempSubdir?: string;
  workspaceImagesDir?: string;
  openclawBin?: string;
  defaultAnalyze?: boolean;
  defaultMaxWidth?: number;
  defaultQuality?: number;
  defaultDelayMs?: number;
  latestFileName?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaPrompt?: string;
};

type ToolParams = {
  node?: string;
  facing?: Facing;
  analyze?: boolean;
  maxWidth?: number;
  quality?: number;
  delayMs?: number;
  analysisMode?: "openclaw" | "ollama" | "none";
  prompt?: string;
};

type MediaDescription = { text?: string } | undefined;

type MediaLine = {
  rawPath: string;
  normalizedPath: string;
  mtimeMs: number;
};

type ToolDetails = {
  ok: boolean;
  agentId: string;
  node: string;
  facing: Facing;
  sourceTempPath: string;
  workspaceImagePath: string;
  workspaceLatestPath: string;
  analyzed: boolean;
  analysisMode: "openclaw" | "ollama" | "none";
  analysisState: string;
  analysisText: string;
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export default definePluginEntry({
  id: "android-camera-bridge",
  name: "Android Camera Bridge",
  description:
    "Android-only OpenClaw camera bridge that wraps the camera helper, stages fresh captures into the default agent workspace, and optionally returns a vision summary.",
  register(api) {
    api.registerTool(
      {
        name: "android_camera_bridge",
        label: "Android Camera Bridge",
        description:
          "Android-only camera bridge for OpenClaw. Captures a fresh image from a paired Android node, copies it into the default agent workspace images folder, and optionally returns a vision summary so the model never has to construct raw node JSON.",
        parameters: Type.Object({
          node: Type.Optional(
            Type.String({
              description:
                "Optional Android node name or id. Defaults to the plugin's configured default node.",
            }),
          ),
          facing: Type.Optional(
            Type.Union([Type.Literal("front"), Type.Literal("back")], {
              description: "Camera facing to capture. Defaults to back.",
              default: "back",
            }),
          ),
          analyze: Type.Optional(
            Type.Boolean({
              description:
                "When true, run image analysis after staging the image. Defaults to the plugin config.",
              default: true,
            }),
          ),
          analysisMode: Type.Optional(
            Type.Union(
              [
                Type.Literal("openclaw"),
                Type.Literal("ollama"),
                Type.Literal("none"),
              ],
              {
                description:
                  "Choose analysis backend. openclaw uses mediaUnderstanding.describeImageFile, ollama calls the local Ollama API directly, none skips analysis.",
                default: "ollama",
              },
            ),
          ),
          prompt: Type.Optional(
            Type.String({
              description:
                "Optional analysis prompt used when analysisMode is ollama.",
            }),
          ),
          maxWidth: Type.Optional(
            Type.Number({
              description:
                "Optional max width in pixels forwarded to `openclaw nodes camera snap --max-width`.",
            }),
          ),
          quality: Type.Optional(
            Type.Number({
              description:
                "Optional JPEG quality in the 0-1 range forwarded to the camera helper.",
              minimum: 0,
              maximum: 1,
            }),
          ),
          delayMs: Type.Optional(
            Type.Number({
              description:
                "Optional delay in milliseconds forwarded to `openclaw nodes camera snap --delay-ms`.",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, rawParams, _signal, _onUpdate) {
          const cfg = api.config;
          const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;
          const params = (rawParams ?? {}) as ToolParams;

          const agentId = resolveDefaultAgentId(cfg);
          const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
          const agentDir = api.runtime.agent.resolveAgentDir(cfg, agentId);

          await api.runtime.agent.ensureAgentWorkspace({
            dir: workspaceDir,
            ensureBootstrapFiles: true,
          });

          const node = params.node ?? pluginCfg.defaultNode ?? "paired-android-node";
          const facing: Facing = params.facing ?? "back";
          const analyze = params.analyze ?? pluginCfg.defaultAnalyze ?? true;
          const requestedMode = params.analysisMode ?? "ollama";
          const analysisMode: "openclaw" | "ollama" | "none" = analyze ? requestedMode : "none";

          const helperOptions = {
            maxWidth: params.maxWidth ?? pluginCfg.defaultMaxWidth,
            quality: params.quality ?? pluginCfg.defaultQuality,
            delayMs: params.delayMs ?? pluginCfg.defaultDelayMs,
          };

          const tempDir = path.join(os.tmpdir(), pluginCfg.tempSubdir ?? "openclaw");
          const imagesDir = path.join(workspaceDir, pluginCfg.workspaceImagesDir ?? "images");
          await fs.mkdir(imagesDir, { recursive: true });

          const startedAt = Date.now();
          const helperResult = await runOpenClawCameraHelper({
            runtime: api.runtime,
            openclawBin: pluginCfg.openclawBin,
            node,
            facing,
            options: helperOptions,
          });

          const helperMedia = await parseMediaPathsFromStdout(helperResult.stdout);
          const selectedSource = await resolveFreshSourceImage({
            helperMedia,
            tempDir,
            startedAt,
          });

          const staged = await stageImageIntoWorkspace({
            sourcePath: selectedSource.normalizedPath,
            imagesDir,
            facing,
            latestFileNameBase: pluginCfg.latestFileName ?? "latest",
          });

          let analysis: MediaDescription;
          let analysisState = analysisMode === "none" ? "skipped" : "not-run";

          if (analysisMode === "openclaw") {
            try {
              analysis = await api.runtime.mediaUnderstanding.describeImageFile({
                filePath: staged.archivePath,
                cfg,
                agentDir,
              });
              analysisState = analysis?.text?.trim() ? "ok" : "empty";
            } catch (error) {
              analysisState = `error:${formatError(error)}`;
              analysis = {
                text: `Image captured and staged, but media analysis failed: ${formatError(error)}`,
              };
            }
          } else if (analysisMode === "ollama") {
            try {
              analysis = await describeImageWithOllama({
                imagePath: staged.archivePath,
                baseUrl: pluginCfg.ollamaBaseUrl ?? "http://127.0.0.1:11434",
                model: pluginCfg.ollamaModel ?? "qwen3.5:4b",
                prompt:
                  params.prompt ??
                  pluginCfg.ollamaPrompt ??
                  "Describe what is visible in this image in plain language. Be direct and concrete.",
              });
              analysisState = analysis?.text?.trim() ? "ok" : "empty";
            } catch (error) {
              analysisState = `error:${formatError(error)}`;
              analysis = {
                text: `Image captured and staged, but Ollama analysis failed: ${formatError(error)}`,
              };
            }
          }

          const analysisText = analysis?.text?.trim() || "";
          const summary = [
            `android_camera_bridge capture succeeded.`,
            `Node: ${node}`,
            `Facing: ${facing}`,
            `Source temp path: ${selectedSource.normalizedPath}`,
            `Workspace image: ${staged.archivePath}`,
            `Workspace latest: ${staged.latestPath}`,
            `Analysis mode: ${analysisMode}`,
            `Analysis state: ${analysisState}`,
            analysisMode === "none"
              ? `Vision summary: skipped (analyze=false or analysisMode=none)`
              : `Vision summary: ${analysisText || "(no description returned)"}`,
          ].join("\n");

          const details: ToolDetails = {
            ok: true,
            agentId,
            node,
            facing,
            sourceTempPath: selectedSource.normalizedPath,
            workspaceImagePath: staged.archivePath,
            workspaceLatestPath: staged.latestPath,
            analyzed: analysisMode !== "none",
            analysisMode,
            analysisState,
            analysisText,
          };

          return {
            details,
            content: [{ type: "text", text: summary }],
          };
        },
      },
      { optional: true },
    );
  },
});

function resolveDefaultAgentId(cfg: any): string {
  const agents = Array.isArray(cfg?.agents?.list)
    ? cfg.agents.list.filter((entry: any) => entry && typeof entry === "object")
    : [];

  if (agents.length === 0) return "main";

  const explicitDefault = agents.find((entry: any) => entry?.default && typeof entry.id === "string");
  const chosen = explicitDefault ?? agents.find((entry: any) => typeof entry.id === "string");
  return typeof chosen?.id === "string" && chosen.id.trim() ? chosen.id.trim() : "main";
}

async function runOpenClawCameraHelper(input: {
  runtime: any;
  openclawBin?: string;
  node: string;
  facing: Facing;
  options: {
    maxWidth?: number;
    quality?: number;
    delayMs?: number;
  };
}): Promise<{ stdout: string; stderr: string }> {
  const args = ["nodes", "camera", "snap", "--node", input.node, "--facing", input.facing];

  if (typeof input.options.maxWidth === "number") {
    args.push("--max-width", String(input.options.maxWidth));
  }
  if (typeof input.options.quality === "number") {
    args.push("--quality", String(input.options.quality));
  }
  if (typeof input.options.delayMs === "number") {
    args.push("--delay-ms", String(input.options.delayMs));
  }

  const bins = input.openclawBin ? [input.openclawBin] : defaultOpenClawBins();
  let lastFailure: unknown;

  for (const bin of bins) {
    try {
      const result = await input.runtime.system.runCommandWithTimeout([bin, ...args], {
        timeoutMs: 30000,
      });

      const stdout = normalizeOutput(result?.stdout);
      const stderr = normalizeOutput(result?.stderr);
      const exitCode = typeof result?.code === "number" ? result.code : 0;

      if (exitCode !== 0) {
        throw new Error(
          [
            `openclaw camera helper failed with exit code ${exitCode}.`,
            stdout ? `stdout:\n${stdout}` : "",
            stderr ? `stderr:\n${stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }

      return { stdout, stderr };
    } catch (error) {
      lastFailure = error;
    }
  }

  throw new Error(
    [
      "Unable to run the OpenClaw CLI camera helper.",
      input.openclawBin
        ? `Configured openclawBin failed: ${input.openclawBin}`
        : "Tried OpenClaw CLI names on PATH but none succeeded.",
      "Prerequisites: install the OpenClaw CLI on PATH for the Gateway process or set plugins.entries.android-camera-bridge.config.openclawBin to the exact executable path.",
      lastFailure ? `Last error: ${formatError(lastFailure)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function defaultOpenClawBins(): string[] {
  return process.platform === "win32" ? ["openclaw.cmd", "openclaw"] : ["openclaw"];
}

function normalizeOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

async function parseMediaPathsFromStdout(stdout: string): Promise<MediaLine[]> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith("MEDIA:"));

  const results: MediaLine[] = [];
  for (const line of lines) {
    const rawPath = line.slice("MEDIA:".length).trim();
    const normalizedPath = stripWrappingQuotes(rawPath);
    if (!normalizedPath) continue;

    try {
      const stat = await fs.stat(normalizedPath);
      if (!stat.isFile()) continue;
      results.push({ rawPath, normalizedPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore stale lines and fall back to temp directory scan.
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function resolveFreshSourceImage(input: {
  helperMedia: MediaLine[];
  tempDir: string;
  startedAt: number;
}): Promise<MediaLine> {
  const freshHelperHit = input.helperMedia.find((entry) => entry.mtimeMs >= input.startedAt - 5000);
  if (freshHelperHit) return freshHelperHit;

  const tempEntries = await listCandidateImages(input.tempDir);
  const freshTempHit = tempEntries.find((entry) => entry.mtimeMs >= input.startedAt - 5000);
  if (freshTempHit) return freshTempHit;

  if (input.helperMedia[0]) return input.helperMedia[0];
  if (tempEntries[0]) return tempEntries[0];

  throw new Error(
    `No fresh image was found after capture. Checked MEDIA lines and temp directory: ${input.tempDir}`,
  );
}

async function listCandidateImages(dir: string): Promise<MediaLine[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const images: MediaLine[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const stat = await fs.stat(fullPath);
    images.push({ rawPath: fullPath, normalizedPath: fullPath, mtimeMs: stat.mtimeMs });
  }

  return images.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function stageImageIntoWorkspace(input: {
  sourcePath: string;
  imagesDir: string;
  facing: Facing;
  latestFileNameBase: string;
}): Promise<{ archivePath: string; latestPath: string }> {
  const ext = path.extname(input.sourcePath) || ".jpg";
  const stamp = timestampForFileName(new Date());
  const archivePath = path.join(
    input.imagesDir,
    `${input.facing}-capture-${stamp}-${randomUUID()}${ext}`,
  );
  const latestPath = path.join(input.imagesDir, `${input.latestFileNameBase}-${input.facing}${ext}`);

  await fs.copyFile(input.sourcePath, archivePath);
  await fs.copyFile(input.sourcePath, latestPath);

  return { archivePath, latestPath };
}

function timestampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, "");
}

async function describeImageWithOllama(input: {
  imagePath: string;
  baseUrl: string;
  model: string;
  prompt: string;
}): Promise<MediaDescription> {
  const imageBuffer = await fs.readFile(input.imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const url = new URL("/api/generate", input.baseUrl).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      images: [imageBase64],
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama request failed (${response.status}): ${body || response.statusText}`);
  }

  const json = (await response.json()) as { response?: string; error?: string };
  if (json.error) {
    throw new Error(json.error);
  }

  return { text: (json.response ?? "").trim() };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
