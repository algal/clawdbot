import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

type GatewayInstance = {
  name: string;
  port: number;
  hookToken: string;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
};

type NodeListPayload = {
  nodes?: Array<{ nodeId?: string; displayName?: string; connected?: boolean; paired?: boolean }>;
};

const GATEWAY_START_TIMEOUT_MS = 45_000;
const E2E_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = async () => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

const waitForPortOpen = async (
  proc: ChildProcessWithoutNullStreams,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      throw new Error(
        `process exited before listening (code=${String(proc.exitCode)} signal=${String(proc.signalCode)})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      // keep polling
    }

    await sleep(25);
  }
  const stdout = chunksOut.join("");
  const stderr = chunksErr.join("");
  throw new Error(
    `timeout waiting for port ${port}\n` + `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
};

const spawnGatewayInstance = async (name: string): Promise<GatewayInstance> => {
  const port = await getFreePort();
  const hookToken = `token-${name}-${randomUUID()}`;
  const gatewayToken = `gateway-${name}-${randomUUID()}`;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-e2e-${name}-`));
  const configDir = path.join(homeDir, ".openclaw");
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  const stateDir = path.join(configDir, "state");
  const config = {
    gateway: {
      port,
      auth: { mode: "token", token: gatewayToken },
      nodes: { allowCommands: ["file.get"] },
    },
    hooks: { enabled: true, token: hookToken, path: "/hooks" },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const stdout: string[] = [];
  const stderr: string[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      "node",
      [
        "dist/index.js",
        "gateway",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_TOKEN: "",
          OPENCLAW_GATEWAY_PASSWORD: "",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => stdout.push(String(d)));
    child.stderr?.on("data", (d) => stderr.push(String(d)));

    await waitForPortOpen(child, stdout, stderr, port, GATEWAY_START_TIMEOUT_MS);

    return {
      name,
      port,
      hookToken,
      gatewayToken,
      homeDir,
      stateDir,
      configPath,
      child,
      stdout,
      stderr,
    };
  } catch (err) {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    await fs.rm(homeDir, { recursive: true, force: true });
    throw err;
  }
};

const stopGatewayInstance = async (inst: GatewayInstance) => {
  if (inst.child.exitCode === null && !inst.child.killed) {
    try {
      inst.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (inst.child.exitCode !== null) return resolve(true);
      inst.child.once("exit", () => resolve(true));
    }),
    sleep(5_000).then(() => false),
  ]);
  if (!exited && inst.child.exitCode === null && !inst.child.killed) {
    try {
      inst.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  await fs.rm(inst.homeDir, { recursive: true, force: true });
};

const runCli = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn("node", ["dist/index.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => stdout.push(String(d)));
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { ...result, stdout: stdout.join("").trim(), stderr: stderr.join("").trim() };
};

const runCliJson = async (args: string[], env: NodeJS.ProcessEnv): Promise<unknown> => {
  const result = await runCli(args, env);
  if (result.code !== 0) {
    throw new Error(
      `cli failed (code=${String(result.code)} signal=${String(result.signal)})\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  try {
    return result.stdout ? (JSON.parse(result.stdout) as unknown) : null;
  } catch (err) {
    throw new Error(
      `cli returned non-json output: ${String(err)}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
};

const runToolsInvoke = async <T>(
  inst: GatewayInstance,
  body: { tool: string; action?: string; args?: unknown; sessionKey?: string },
): Promise<{ status: number; json: T; raw: string }> => {
  const res = await fetch(`http://127.0.0.1:${inst.port}/tools/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${inst.gatewayToken}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const json = JSON.parse(raw) as T;
  return { status: res.status, json, raw };
};

const waitForNodeStatus = async (inst: GatewayInstance, nodeId: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await runCliJson(
      ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${inst.port}`],
      {
        OPENCLAW_GATEWAY_TOKEN: inst.gatewayToken,
        OPENCLAW_GATEWAY_PASSWORD: "",
      },
    )) as NodeListPayload;
    const match = list.nodes?.find((n) => n.nodeId === nodeId);
    if (match?.connected) return;
    await sleep(50);
  }
  let lastStatus: unknown = null;
  try {
    lastStatus = await runCliJson(
      ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${inst.port}`],
      {
        OPENCLAW_GATEWAY_TOKEN: inst.gatewayToken,
        OPENCLAW_GATEWAY_PASSWORD: "",
      },
    );
  } catch {
    // ignore
  }
  throw new Error(
    `timeout waiting for node to connect (nodeId=${nodeId})\n${JSON.stringify(lastStatus)}`,
  );
};

const waitForNodeByDisplayName = async (params: {
  inst: GatewayInstance;
  displayName: string;
  proc?: ChildProcessWithoutNullStreams;
  procStdout?: string[];
  procStderr?: string[];
  timeoutMs?: number;
}): Promise<string> => {
  const deadline = Date.now() + (params.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (params.proc && params.proc.exitCode !== null) {
      throw new Error(
        `node-host exited early (code=${String(params.proc.exitCode)} signal=${String(params.proc.signalCode)})\n` +
          `--- stdout ---\n${(params.procStdout ?? []).join("")}\n--- stderr ---\n${(params.procStderr ?? []).join("")}`,
      );
    }
    const list = (await runCliJson(
      ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${params.inst.port}`],
      {
        OPENCLAW_GATEWAY_TOKEN: params.inst.gatewayToken,
        OPENCLAW_GATEWAY_PASSWORD: "",
      },
    )) as NodeListPayload;
    const match = list.nodes?.find((n) => n.displayName === params.displayName);
    if (match?.nodeId && match.connected) {
      return match.nodeId;
    }
    await sleep(50);
  }
  let lastStatus: unknown = null;
  try {
    lastStatus = await runCliJson(
      ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${params.inst.port}`],
      {
        OPENCLAW_GATEWAY_TOKEN: params.inst.gatewayToken,
        OPENCLAW_GATEWAY_PASSWORD: "",
      },
    );
  } catch {
    // ignore
  }
  const procOut =
    params.procStdout && params.procStdout.length
      ? `\n--- node-host stdout ---\n${params.procStdout.join("")}`
      : "";
  const procErr =
    params.procStderr && params.procStderr.length
      ? `\n--- node-host stderr ---\n${params.procStderr.join("")}`
      : "";
  throw new Error(
    `timeout waiting for node-host displayName=${params.displayName}\n${JSON.stringify(lastStatus)}${procOut}${procErr}`,
  );
};

const stopProcess = async (proc: ChildProcessWithoutNullStreams, timeoutMs = 5_000) => {
  if (proc.exitCode === null && !proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null) return resolve(true);
      proc.once("exit", () => resolve(true));
    }),
    sleep(timeoutMs).then(() => false),
  ]);
  if (!exited && proc.exitCode === null && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
};

describe("file-get e2e", () => {
  let gw: GatewayInstance | null = null;
  let nodeHomeDir: string | null = null;
  let nodeHost: ChildProcessWithoutNullStreams | null = null;
  let nodeId: string | null = null;

  afterAll(async () => {
    if (nodeHost) await stopProcess(nodeHost);
    if (nodeHomeDir) await fs.rm(nodeHomeDir, { recursive: true, force: true });
    if (gw) await stopGatewayInstance(gw);
  });

  it(
    "invokes file.get via gateway and validates payload + errors",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      gw = await spawnGatewayInstance("file-get");

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-e2e-file-get-"));
      const filePath = path.join(tmpDir, "hello.txt");
      const content = `hello from e2e ${randomUUID()}\n`;
      await fs.writeFile(filePath, content, "utf8");

      nodeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-e2e-node-host-"));
      const nodeConfigDir = path.join(nodeHomeDir, ".openclaw");
      await fs.mkdir(nodeConfigDir, { recursive: true });
      const nodeConfigPath = path.join(nodeConfigDir, "openclaw.json");
      const nodeConfig = {
        nodeHost: {
          fileGet: {
            allowPaths: [`${tmpDir}/**`],
          },
        },
      };
      await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");

      const nodeStdout: string[] = [];
      const nodeStderr: string[] = [];
      const displayName = `e2e-node-host-${randomUUID().slice(0, 8)}`;
      nodeHost = spawn(
        "node",
        [
          "openclaw.mjs",
          "node",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(gw.port),
          "--display-name",
          displayName,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: nodeHomeDir,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_STATE_DIR: nodeConfigDir,
            OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
            OPENCLAW_GATEWAY_PASSWORD: "",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      nodeHost.stdout?.setEncoding("utf8");
      nodeHost.stderr?.setEncoding("utf8");
      nodeHost.stdout?.on("data", (d) => nodeStdout.push(String(d)));
      nodeHost.stderr?.on("data", (d) => nodeStderr.push(String(d)));

      nodeId = await waitForNodeByDisplayName({
        inst: gw,
        displayName,
        proc: nodeHost,
        procStdout: nodeStdout,
        procStderr: nodeStderr,
      });
      await waitForNodeStatus(gw, nodeId, 20_000);

      const result = (await runCliJson(
        [
          "nodes",
          "invoke",
          "--json",
          "--url",
          `ws://127.0.0.1:${gw.port}`,
          "--node",
          nodeId,
          "--command",
          "file.get",
          "--params",
          JSON.stringify({ path: filePath }),
        ],
        {
          OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
          OPENCLAW_GATEWAY_PASSWORD: "",
        },
      )) as {
        ok?: boolean;
        payload?: { base64?: string; mimeType?: string; size?: number };
      };

      expect(result.ok).toBe(true);
      expect(typeof result.payload?.base64).toBe("string");
      expect(typeof result.payload?.mimeType).toBe("string");
      expect(typeof result.payload?.size).toBe("number");

      const decoded = Buffer.from(result.payload?.base64 ?? "", "base64").toString("utf8");
      expect(decoded).toBe(content);
      expect(result.payload?.size).toBe(Buffer.byteLength(content, "utf8"));

      const denied = await runCli(
        [
          "nodes",
          "invoke",
          "--json",
          "--url",
          `ws://127.0.0.1:${gw.port}`,
          "--node",
          nodeId,
          "--command",
          "file.get",
          "--params",
          JSON.stringify({ path: process.execPath }),
        ],
        {
          OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
          OPENCLAW_GATEWAY_PASSWORD: "",
        },
      );
      expect(denied.code).not.toBe(0);
      expect(`${denied.stdout}\n${denied.stderr}`).toMatch(/FILE_GET_DENIED/);

      const traversal = await runCli(
        [
          "nodes",
          "invoke",
          "--json",
          "--url",
          `ws://127.0.0.1:${gw.port}`,
          "--node",
          nodeId,
          "--command",
          "file.get",
          "--params",
          JSON.stringify({ path: `${filePath}/../secret.txt` }),
        ],
        {
          OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
          OPENCLAW_GATEWAY_PASSWORD: "",
        },
      );
      expect(traversal.code).not.toBe(0);
      expect(`${traversal.stdout}\n${traversal.stderr}`).toMatch(/path must not contain '\.\.'/i);

      const toolRes = await runToolsInvoke<{
        ok?: boolean;
        result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
        error?: { type?: string; message?: string };
      }>(gw, {
        tool: "nodes",
        action: "file_get",
        args: {
          node: nodeId,
          path: filePath,
        },
      });
      expect(toolRes.status).toBe(200);
      expect(toolRes.json.ok).toBe(true);
      const toolText = toolRes.json.result?.content?.find((c) => c.type === "text")?.text ?? "";
      expect(toolText.startsWith("FILE:")).toBe(true);
      const fetchedPath = toolText.slice("FILE:".length).trim();
      const fetchedContent = await fs.readFile(fetchedPath, "utf8");
      expect(fetchedContent).toBe(content);

      const missing = path.join(tmpDir, `missing-${randomUUID()}.txt`);
      const missingRes = await runCli(
        [
          "nodes",
          "invoke",
          "--json",
          "--url",
          `ws://127.0.0.1:${gw.port}`,
          "--node",
          nodeId,
          "--command",
          "file.get",
          "--params",
          JSON.stringify({ path: missing }),
        ],
        {
          OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
          OPENCLAW_GATEWAY_PASSWORD: "",
        },
      );
      expect(missingRes.code).not.toBe(0);
      expect(`${missingRes.stdout}\n${missingRes.stderr}`.toLowerCase()).toContain(
        "file not found",
      );

      const missingToolRes = await runToolsInvoke<{
        ok?: boolean;
        error?: { type?: string; message?: string };
      }>(gw, {
        tool: "nodes",
        action: "file_get",
        args: {
          node: nodeId,
          path: missing,
        },
      });
      expect(missingToolRes.status).toBe(400);
      expect(missingToolRes.json.ok).toBe(false);
      expect((missingToolRes.json.error?.message ?? "").toLowerCase()).toContain("file not found");

      const relativeRes = await runCli(
        [
          "nodes",
          "invoke",
          "--json",
          "--url",
          `ws://127.0.0.1:${gw.port}`,
          "--node",
          nodeId,
          "--command",
          "file.get",
          "--params",
          JSON.stringify({ path: "relative.txt" }),
        ],
        {
          OPENCLAW_GATEWAY_TOKEN: gw.gatewayToken,
          OPENCLAW_GATEWAY_PASSWORD: "",
        },
      );
      expect(relativeRes.code).not.toBe(0);
      expect(`${relativeRes.stdout}\n${relativeRes.stderr}`.toLowerCase()).toContain(
        "path must be absolute",
      );

      const relativeToolRes = await runToolsInvoke<{
        ok?: boolean;
        error?: { type?: string; message?: string };
      }>(gw, {
        tool: "nodes",
        action: "file_get",
        args: {
          node: nodeId,
          path: "relative.txt",
        },
      });
      expect(relativeToolRes.status).toBe(400);
      expect(relativeToolRes.json.ok).toBe(false);
      expect((relativeToolRes.json.error?.message ?? "").toLowerCase()).toContain(
        "path must be absolute",
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  );
});
