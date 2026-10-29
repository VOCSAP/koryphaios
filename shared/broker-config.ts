import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BrokerConfigFile {
  port?: number;
  broker_url?: string | null;
  broker_token?: string | null;
  offline_replica?: boolean;
}

export interface BrokerConfigResult<T extends BrokerConfigFile = BrokerConfigFile> {
  config: T;
  path: string;
  error: string | null;
}

export type BrokerMode = "local" | "remote" | "replica";

export function settingsFilePath(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "claude-peers", "config.json");
    return join(homedir(), "AppData", "Roaming", "claude-peers", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "claude-peers", "config.json");
  return join(homedir(), ".config", "claude-peers", "config.json");
}

function decodeConfigBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  return buffer.toString("utf-8");
}

export function readBrokerConfig<T extends BrokerConfigFile = BrokerConfigFile>(
  onWarn?: (message: string) => void,
): BrokerConfigResult<T> {
  const path = settingsFilePath();
  try {
    if (!existsSync(path)) return { config: {} as T, path, error: null };
    const raw = decodeConfigBuffer(readFileSync(path)).replace(/^﻿/, "");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("config root must be an object");
    }
    return { config: data as T, path, error: null };
  } catch (error) {
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // The file vanished or is unreadable. The generic diagnostic remains accurate.
    }
    const reason = isDir ? `${path} is a directory, not a file` : error instanceof Error ? error.message : String(error);
    const message = `ignoring malformed config ${path}: ${reason} (using defaults)`;
    onWarn?.(message);
    return { config: {} as T, path, error: reason };
  }
}

export function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

export function loadBrokerConfig<T extends BrokerConfigFile = BrokerConfigFile>(
  onWarn?: (message: string) => void,
): BrokerConfigResult<T> {
  const result = readBrokerConfig<T>(onWarn);
  const fileConfig = result.config;
  return {
    ...result,
    config: {
      ...fileConfig,
      port: Number.parseInt(process.env.CLAUDE_PEERS_PORT ?? String(fileConfig.port ?? 7899), 10),
      broker_url: process.env.CLAUDE_PEERS_BROKER_URL ?? fileConfig.broker_url ?? null,
      broker_token: process.env.CLAUDE_PEERS_BROKER_TOKEN ?? fileConfig.broker_token ?? null,
      offline_replica: parseBooleanFlag(process.env.CLAUDE_PEERS_OFFLINE_REPLICA, fileConfig.offline_replica === true),
    } as T,
  };
}

export function brokerMode(config: Pick<BrokerConfigFile, "broker_url" | "offline_replica">): BrokerMode {
  if (!config.broker_url) return "local";
  return config.offline_replica ? "replica" : "remote";
}

export function brokerUrl(config: Pick<BrokerConfigFile, "broker_url" | "offline_replica" | "port">): string {
  if (brokerMode(config) === "remote") return config.broker_url as string;
  return `http://127.0.0.1:${config.port ?? 7899}`;
}

export function brokerHeaders(config: Pick<BrokerConfigFile, "broker_token">, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (config.broker_token) headers.Authorization = `Bearer ${config.broker_token}`;
  return headers;
}
