# Android Camera Bridge for OpenClaw

Turn “take a picture” into a one-shot, deterministic action for OpenClaw agents.

Android-only OpenClaw plugin that replaces fragile phone-camera orchestration with a single stable capability.

---

## Install

### 1. Install the plugin locally

```powershell
npm install
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

### 2. Allow the tool

You can do this either in config or from the local web dashboard.

Config example:

```json5
agents: {
  list: [
    {
      id: "main",
      tools: {
        alsoAllow: ["android_camera_bridge"]
      },
      skills: ["android-camera-bridge"]
    }
  ]
}
```

Local web dashboard path:

1. Open the local OpenClaw dashboard.
2. Go to `AI & Agents`.
3. Open the `Tools` tab.
4. Under `Tool Allowlist Additions`, click `Add`.
5. Add `android_camera_bridge` in the `access > tools` entry.
6. Click `Save`, then `Update`.

This updates the backend config from the dashboard UI.

---

## Example

User:
"take a picture"

Agent:
→ captures from Android device
→ stages image in workspace
→ returns result

No retries. No drift. No JSON wrangling.

---

## Why this exists

Small local models were getting crushed by raw tool choreography:

* wrong node/action formatting
* retry drift
* blocked media payloads from the gateway path
* no clean handoff from temp capture → workspace image

This plugin fixes that by removing the complexity entirely.

Instead of forcing the model to orchestrate multiple steps, it exposes a single stable capability.

---

## What it does

`android_camera_bridge`:

1. calls the working OpenClaw Android camera helper
2. finds the fresh image in the OpenClaw temp folder
3. copies it into the agent workspace `images/` folder
4. maintains:

   * archived captures
   * rolling `latest-<facing>` file
5. optionally runs image analysis

---

## Architecture

camera → temp → workspace → (optional) analysis

All low-level orchestration is handled inside the plugin.
The agent only sees a single tool.

---

## Tool

* Plugin id: `android-camera-bridge`
* Tool name: `android_camera_bridge`

---

## Parameters

* `node` — optional Android node name or id
* `facing` — `front` or `back`
* `analyze` — run image analysis
* `analysisMode` — `ollama`, `openclaw`, or `none`
* `prompt` — override prompt for local analysis
* `maxWidth` — optional helper max width
* `quality` — optional JPEG quality
* `delayMs` — optional capture delay

---

## Recommended mode

For a fully local setup:
```text
analysisMode: "ollama"
```
This keeps the entire pipeline local and avoids provider-backed image analysis.

Behind the scenes, the plugin reads the staged image from disk, base64-encodes it, and sends it to your local Ollama API with an HTTP `POST` to `/api/generate`.

The request shape looks like this:

```json
{
  "model": "qwen3.5:4b",
  "prompt": "Describe what is visible in this image in plain language. Be direct and concrete.",
  "images": ["<base64-image>"],
  "stream": false
}
```

So `ollamaModel: "qwen3.5:4b"` in the example config is simply the model name the plugin passes to Ollama. It is not hardcoded behavior. You can replace it with any local Ollama model on your machine that supports vision/image input.

---

## Requirements

This plugin assumes OpenClaw camera prerequisites are already satisfied:

* OpenClaw installed + Gateway running
* OpenClaw CLI available on PATH (or `openclawBin` set)
* Android node paired and reachable
* Android app has camera permission
* Android app is in foreground during capture
* Workspace is configured and writable

If those are true, this should work without machine-specific hacks.

---

## Example config

```json5
plugins: {
  allow: ["android-camera-bridge"],
  entries: {
    "android-camera-bridge": {
      enabled: true,
      config: {
        defaultNode: "paired-android-node",
        tempSubdir: "openclaw",
        workspaceImagesDir: "images",
        defaultAnalyze: true,
        latestFileName: "latest",
        // Optional if OpenClaw is already on PATH for the Gateway process
        openclawBin: "C:\\path\\to\\openclaw.cmd",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        // Any local Ollama model that supports image input
        ollamaModel: "qwen3.5:4b"
      }
    }
  }
}

agents: {
  list: [
    {
      id: "main",
      tools: {
        alsoAllow: ["android_camera_bridge"]
      },
      skills: ["android-camera-bridge"]
    }
  ]
}
```

---

## Usage

Natural language:
```text
Take a picture with the android bridge.
```
Direct:
```text
Use android_camera_bridge to take a photo and describe it.
```
Capture only:
```text
Use android_camera_bridge with analyze false to take a photo.
```
---

## Limitations

* Android-only
* Requires foreground Android app for capture
* Image analysis depends on local model / provider setup

---

## Notes

* Designed to narrow the model-facing tool surface
* Great fit for smaller local / edge models
* Can use OpenClaw media understanding (`analysisMode: "openclaw"`) or fully local Ollama
* Wraps the documented `openclaw nodes camera snap` CLI helper
* Uses the `MEDIA:<path>` temp-file output from OpenClaw

---

## Takeaway

If your model is struggling, it’s probably doing work it shouldn’t be doing.

Give it better primitives — it suddenly looks a lot smarter.
