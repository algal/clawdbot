# Opus Fast Patch

Patch commit: `6dd816c08f2b`

This patch adds **opt-in** Anthropic fast mode for direct `anthropic/claude-opus-4-6`.
It does nothing unless `speed: "fast"` is configured.

## Update This Checkout

Sparky's DGX runbook installs OpenClaw from source and runs the Gateway as a
user service from this checkout. For that path:

```bash
cd ~/gits/openclaw
git fetch --all --tags
git checkout 6dd816c08f2b
pnpm install
pnpm build
pnpm openclaw gateway restart
pnpm openclaw gateway status
```

Notes:

- For the Sparky source install, **yes, rebuild** with `pnpm build`.
- For a running Gateway service, **yes, restart** it so the new code is loaded.
- If you run OpenClaw manually from source with `pnpm openclaw ...`, the runner
  can rebuild stale `dist/` on next start, but the running Gateway process still
  must be restarted or started again.

## Switch Fast Mode On

Recommended: set it on the `sparky` agent only.

In `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    list: [
      {
        id: "sparky",
        model: "anthropic/claude-opus-4-6",
        params: { speed: "fast" },
      },
    ],
  },
}
```

Then restart the Gateway:

```bash
pnpm openclaw gateway restart
```

## Switch Fast Mode Off

Remove `speed` from that agent's `params` block:

```json5
"params": {}
```

or remove the `params` block entirely.

Then restart the Gateway:

```bash
pnpm openclaw gateway restart
```

## Global Switch

If you want the knob at the model-default level instead of the `sparky` agent:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { speed: "fast" },
        },
      },
    },
  },
}
```

Remove `speed` to go back to non-fast.

## Scope

- Only affects direct `anthropic/claude-opus-4-6`
- No effect for OpenRouter, `claude-cli`, Copilot, or other providers/models
