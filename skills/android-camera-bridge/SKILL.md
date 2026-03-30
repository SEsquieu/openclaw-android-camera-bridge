---
name: android-camera-bridge
description: Use the Android Camera Bridge for Android camera capture and staging.
---

Use `android_camera_bridge` for Android phone camera capture tasks.

Rules:
- Prefer `android_camera_bridge` over raw `nodes` camera actions for normal Android photo capture.
- Do not use raw `invoke` with `camera.snap` for this workflow.
- Do not manually construct raw node/action JSON unless explicitly debugging the bridge.
- The bridge handles:
  - Android camera capture
  - temp file pickup
  - staging into the workspace images folder
  - optional image analysis
- Supported parameters:
  - `facing`: `back` or `front`
  - `analyze`: `true` or `false`
  - `analysisMode`: `ollama`, `openclaw`, or `none`
- Defaults:
  - `facing=back`
  - `analysisMode=ollama`

Prerequisites:
- A paired Android node must already exist and be reachable.
- The Android app must be in the foreground for camera capture.
- Camera permission must already be granted on the Android device.
- The plugin host must be able to run the OpenClaw CLI helper through `openclaw` on `PATH` or a configured `openclawBin`.

If the user asks to take a picture, prefer the bridge.
