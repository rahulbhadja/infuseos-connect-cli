#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CommandName = "connect" | "start" | "disconnect";

type ParsedArgs = {
  command: CommandName | "help";
  options: Record<string, string | boolean>;
};

type ConnectorConfig = {
  serverUrl: string;
  token: string;
  allowHighRisk: boolean;
};

type MachineInfo = {
  displayName: string;
  platform: string;
  arch: string;
  osVersion: string;
  shell: string;
  connectorVersion: string;
  metadata: Record<string, unknown>;
};

type PullCommandPayload = {
  id: string;
  command: string;
  timeoutMs?: number;
  risk?: "LOW" | "MEDIUM" | "HIGH";
};

type PullResponse = {
  command: PullCommandPayload | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  serverTime?: string;
};

type CommandExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

type ConnectorRuntimeState =
  | "connecting"
  | "authenticated"
  | "retrying_network"
  | "disconnected_auth"
  | "disconnected_manual";

class ConnectorHttpError extends Error {
  status: number;
  responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown) {
    super(message);
    this.name = "ConnectorHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

class ConnectorExitError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ConnectorExitError";
    this.exitCode = exitCode;
  }
}

const CONFIG_DIR = path.join(os.homedir(), ".infuse-connect");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DEFAULT_SERVER_URL = "https://infuseos.com";
const SERVER_URL_ENV_VAR = "INFUSE_CONNECT_SERVER_URL";
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const INITIAL_TRANSIENT_RETRY_MS = 1000;
const MAX_TRANSIENT_RETRY_MS = 30000;
const RETRY_JITTER_RATIO = 0.2;
const REPEATED_ERROR_SUMMARY_MS = 30000;
const MAX_OUTPUT_CHARS = 120000;

const HIGH_RISK_PATTERNS = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bdd\s+if=.*\s+of=\/dev\//i,
  /\bcurl\b[\s\S]*\|\s*(bash|sh)\b/i,
  /\bwget\b[\s\S]*\|\s*(bash|sh)\b/i,
];

function printUsage(): void {
  console.log(`infuse-connect\n\nUsage:\n  infuse-connect connect --code <token> [--server <url>] [options]\n  infuse-connect start [--server <url> --code <token>] [options]\n  infuse-connect disconnect [--server <url> --code <token>]\n\nOptions:\n  --code <token>              Connector token (alias of --token)\n  --token <token>             Connector token\n  --server <url>              Infuse base URL (optional, default: ${DEFAULT_SERVER_URL})\n  --name <displayName>        Machine display name\n  --allow-high-risk           Allow high-risk commands\n  --once                      Run one poll cycle and exit\n  --help                      Show help\n\nEnvironment:\n  ${SERVER_URL_ENV_VAR}       Default server URL when --server is omitted\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let command: ParsedArgs["command"] = "start";

  if (args[0] && !args[0].startsWith("-")) {
    const candidate = args.shift();
    if (
      candidate === "connect" ||
      candidate === "start" ||
      candidate === "disconnect" ||
      candidate === "help"
    ) {
      command = candidate;
    } else {
      throw new Error(`Unknown command: ${candidate}`);
    }
  }

  const options: Record<string, string | boolean> = {};

  while (args.length > 0) {
    const key = args.shift();
    if (!key) {
      break;
    }

    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }

    if (key === "--allow-high-risk" || key === "--once" || key === "--help") {
      options[key.slice(2)] = true;
      continue;
    }

    const value = args.shift();
    if (!value) {
      throw new Error(`Missing value for ${key}`);
    }

    options[key.slice(2)] = value;
  }

  return { command, options };
}

function optionString(
  options: Record<string, string | boolean>,
  key: string
): string | null {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionFlag(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}

function normalizeServerUrl(input: string): string {
  const url = new URL(input);
  return url.toString().replace(/\/$/, "");
}

function getTokenFromOptions(options: Record<string, string | boolean>): string | null {
  return optionString(options, "code") ?? optionString(options, "token");
}

function resolveConnectServerUrl(options: Record<string, string | boolean>): string {
  const explicitServer = optionString(options, "server");
  const envServer = process.env[SERVER_URL_ENV_VAR]?.trim();
  const candidateServer =
    explicitServer ||
    (envServer && envServer.length > 0 ? envServer : DEFAULT_SERVER_URL);

  try {
    return normalizeServerUrl(candidateServer);
  } catch {
    throw new Error(
      `Invalid server URL. Provide --server <url> or set ${SERVER_URL_ENV_VAR}.`
    );
  }
}

function buildMachineInfo(options: Record<string, string | boolean>): MachineInfo {
  return {
    displayName: optionString(options, "name") ?? os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    shell:
      process.env.SHELL ??
      (process.platform === "win32" ? "powershell.exe" : "/bin/bash"),
    connectorVersion: "0.1.0",
    metadata: {
      pid: process.pid,
      node: process.version,
      hostname: os.hostname(),
    },
  };
}

async function readConfig(): Promise<ConnectorConfig> {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<ConnectorConfig>;

  if (!parsed.serverUrl || !parsed.token) {
    throw new Error("Saved config is invalid. Re-run connect command.");
  }

  return {
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    token: parsed.token,
    allowHighRisk: parsed.allowHighRisk === true,
  };
}

async function writeConfig(config: ConnectorConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function clearConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_PATH);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }

    throw error;
  }
}

function extractErrorMessage(payload: unknown, status: number): string {
  let message = `HTTP ${status}`;

  if (typeof payload === "object" && payload !== null) {
    const maybeError = (payload as Record<string, unknown>).error;
    const maybeMessage = (payload as Record<string, unknown>).message;

    if (typeof maybeError === "string") {
      message = maybeError;
    } else if (
      typeof maybeError === "object" &&
      maybeError !== null &&
      typeof (maybeError as { message?: unknown }).message === "string"
    ) {
      message = (maybeError as { message: string }).message;
    } else if (typeof maybeMessage === "string") {
      message = maybeMessage;
    }
  }

  return message;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function shouldTreatAsAuthFailure(error: unknown): boolean {
  if (error instanceof ConnectorHttpError && error.isAuthError) {
    return true;
  }

  const message = describeError(error).toLowerCase();
  return message.includes("unauthorized") || message.includes("forbidden");
}

function nextRetryDelayMs(currentMs: number): number {
  return Math.min(MAX_TRANSIENT_RETRY_MS, currentMs * 2);
}

function jitteredDelayMs(baseMs: number): number {
  const jitterWindow = Math.floor(baseMs * RETRY_JITTER_RATIO);
  if (jitterWindow <= 0) {
    return baseMs;
  }

  const jitter = Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow;
  return Math.max(250, baseMs + jitter);
}

async function fetchJson<TPayload>(
  url: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    token?: string;
    body?: unknown;
  } = {}
): Promise<TPayload> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : null,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ConnectorHttpError(
      response.status,
      extractErrorMessage(payload, response.status),
      payload
    );
  }

  return payload as TPayload;
}

function appendWithCap(
  current: string,
  chunk: string,
  cap: number
): { value: string; truncated: boolean } {
  const next = current + chunk;
  if (next.length <= cap) {
    return { value: next, truncated: false };
  }

  return {
    value: next.slice(0, cap),
    truncated: true,
  };
}

function isHighRiskCommand(command: string, risk: string | undefined): boolean {
  if (risk === "HIGH") {
    return true;
  }

  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeCommand(
  command: string,
  timeoutMs: number
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    const shell =
      process.env.SHELL ??
      (process.platform === "win32" ? "powershell.exe" : "/bin/bash");

    const shellArgs =
      process.platform === "win32"
        ? ["-NoProfile", "-Command", command]
        : ["-lc", command];

    const child = spawn(shell, shellArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const update = appendWithCap(stdout, String(chunk), MAX_OUTPUT_CHARS);
      stdout = update.value;
      outputTruncated = outputTruncated || update.truncated;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const update = appendWithCap(stderr, String(chunk), MAX_OUTPUT_CHARS);
      stderr = update.value;
      outputTruncated = outputTruncated || update.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${String(error.message ?? error)}`,
        outputTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdout,
        stderr,
        outputTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runConnectorLoop(
  config: ConnectorConfig,
  options: { name?: string | null; once: boolean }
): Promise<void> {
  const machineInfo = buildMachineInfo(
    options.name ? { name: options.name } : {}
  );
  const baseUrl = normalizeServerUrl(config.serverUrl);

  let running = true;
  let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let nextHeartbeatAt = 0;
  let retryDelayMs = INITIAL_TRANSIENT_RETRY_MS;
  let state: ConnectorRuntimeState = "connecting";

  let lastErrorKey: string | null = null;
  let repeatedErrorCount = 0;
  let lastSummaryAt = 0;

  const transitionState = (nextState: ConnectorRuntimeState) => {
    if (state === nextState) {
      return;
    }

    state = nextState;
    console.log(`[infuse-connect] state: ${nextState}`);
  };

  const stop = (signal: NodeJS.Signals) => {
    transitionState("disconnected_manual");
    console.log(`[infuse-connect] received ${signal}, shutting down`);
    running = false;
  };

  const onSigInt = () => stop("SIGINT");
  const onSigTerm = () => stop("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  console.log(
    `[infuse-connect] connected to ${baseUrl} as ${machineInfo.displayName}`
  );
  transitionState("connecting");

  try {
    while (running) {
      const now = Date.now();

      try {
        if (now >= nextHeartbeatAt) {
          const heartbeat = await fetchJson<{
            heartbeatIntervalMs?: number;
            pollIntervalMs?: number;
          }>(`${baseUrl}/api/computer/connector/heartbeat`, {
            method: "POST",
            token: config.token,
            body: machineInfo,
          });

          heartbeatIntervalMs =
            heartbeat.heartbeatIntervalMs ?? heartbeatIntervalMs;
          pollIntervalMs = heartbeat.pollIntervalMs ?? pollIntervalMs;
          nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
        }

        const pull = await fetchJson<PullResponse>(
          `${baseUrl}/api/computer/connector/commands/pull`,
          {
            method: "POST",
            token: config.token,
            body: {},
          }
        );

        pollIntervalMs = pull.pollIntervalMs ?? pollIntervalMs;

        if (pull.command) {
          const { id, command, timeoutMs = 120000, risk } = pull.command;
          console.log(`[infuse-connect] command received: ${id}`);

          if (isHighRiskCommand(command, risk) && !config.allowHighRisk) {
            await fetchJson<{ success: boolean }>(
              `${baseUrl}/api/computer/connector/commands/${encodeURIComponent(id)}/result`,
              {
                method: "POST",
                token: config.token,
                body: {
                  status: "FAILED",
                  exitCode: 1,
                  stdout: "",
                  stderr: "",
                  error:
                    "Blocked by connector policy: high-risk command requires --allow-high-risk.",
                  outputTruncated: false,
                  metadata: {
                    policyBlocked: true,
                    risk: risk ?? "UNKNOWN",
                  },
                },
              }
            );
          } else {
            const result = await executeCommand(command, timeoutMs);
            const status = result.timedOut
              ? "FAILED"
              : result.exitCode === 0
                ? "SUCCEEDED"
                : "FAILED";

            await fetchJson<{ success: boolean }>(
              `${baseUrl}/api/computer/connector/commands/${encodeURIComponent(id)}/result`,
              {
                method: "POST",
                token: config.token,
                body: {
                  status,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  outputTruncated: result.outputTruncated,
                  error: result.timedOut
                    ? `Command timed out after ${timeoutMs}ms`
                    : undefined,
                  metadata: {
                    durationMs: result.durationMs,
                  },
                },
              }
            );
          }
        }

        transitionState("authenticated");

        if (lastErrorKey) {
          console.log("[infuse-connect] connector recovered");
          lastErrorKey = null;
          repeatedErrorCount = 0;
          lastSummaryAt = 0;
        }
        retryDelayMs = INITIAL_TRANSIENT_RETRY_MS;
      } catch (error: unknown) {
        if (shouldTreatAsAuthFailure(error)) {
          const statusPart =
            error instanceof ConnectorHttpError ? ` (HTTP ${error.status})` : "";
          transitionState("disconnected_auth");
          console.error(
            `[infuse-connect] authentication failed${statusPart}. The connector token is invalid, expired, or revoked.`
          );
          console.error(
            "[infuse-connect] Generate a new code in /computer and reconnect with:"
          );
          if (baseUrl === normalizeServerUrl(DEFAULT_SERVER_URL)) {
            console.error(
              "[infuse-connect] npx infuse-connect connect --code <new-token>"
            );
          } else {
            console.error(
              `[infuse-connect] npx infuse-connect connect --server ${baseUrl} --code <new-token>`
            );
          }
          throw new ConnectorExitError("Connector authentication failed", 2);
        }

        if (options.once) {
          throw error;
        }

        transitionState("retrying_network");
        const message = describeError(error);
        const errorKey =
          error instanceof ConnectorHttpError
            ? `http:${error.status}:${message}`
            : `generic:${message}`;
        const errorNow = Date.now();

        if (errorKey !== lastErrorKey) {
          lastErrorKey = errorKey;
          repeatedErrorCount = 1;
          lastSummaryAt = errorNow;
          console.error(`[infuse-connect] connector error: ${message}`);
        } else {
          repeatedErrorCount += 1;
          if (errorNow - lastSummaryAt >= REPEATED_ERROR_SUMMARY_MS) {
            console.error(
              `[infuse-connect] connector error (repeated x${repeatedErrorCount}): ${message}`
            );
            lastSummaryAt = errorNow;
          }
        }

        const delayMs = jitteredDelayMs(retryDelayMs);
        console.log(`[infuse-connect] retrying in ${delayMs}ms`);
        retryDelayMs = nextRetryDelayMs(retryDelayMs);
        await sleep(delayMs);
        continue;
      }

      if (options.once) {
        break;
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    console.log("[infuse-connect] stopped");
  }
}

async function resolveConfig(
  command: CommandName | "help",
  options: Record<string, string | boolean>
): Promise<ConnectorConfig | null> {
  const server = optionString(options, "server");
  const token = getTokenFromOptions(options);
  const allowHighRisk = optionFlag(options, "allow-high-risk");

  if (command === "connect") {
    if (!token) {
      throw new Error("connect requires --code/--token");
    }

    const config: ConnectorConfig = {
      serverUrl: resolveConnectServerUrl(options),
      token,
      allowHighRisk,
    };

    await writeConfig(config);
    console.log(`[infuse-connect] config saved at ${CONFIG_PATH}`);
    return config;
  }

  if (server && token) {
    const config: ConnectorConfig = {
      serverUrl: normalizeServerUrl(server),
      token,
      allowHighRisk,
    };

    await writeConfig(config);
    return config;
  }

  return readConfig();
}

async function run(): Promise<void> {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));

    if (optionFlag(options, "help") || command === "help") {
      printUsage();
      return;
    }

    if (command === "disconnect") {
      const config = await resolveConfig("start", options);
      if (!config) {
        throw new Error("No connector config found.");
      }

      try {
        await fetchJson<{ success: boolean }>(
          `${normalizeServerUrl(config.serverUrl)}/api/computer/connector/disconnect`,
          {
            method: "POST",
            token: config.token,
            body: {},
          }
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[infuse-connect] disconnect API warning: ${message}`);
      }

      await clearConfig();
      console.log("[infuse-connect] disconnected and local config removed");
      return;
    }

    const config = await resolveConfig(command, options);
    if (!config) {
      throw new Error("No connector config found.");
    }

    await runConnectorLoop(config, {
      name: optionString(options, "name"),
      once: optionFlag(options, "once"),
    });
  } catch (error: unknown) {
    if (error instanceof ConnectorExitError) {
      console.error(`[infuse-connect] ${error.message}`);
      process.exit(error.exitCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[infuse-connect] ${message}`);
    printUsage();
    process.exit(1);
  }
}

void run();
