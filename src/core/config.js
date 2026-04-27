import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "../..");

const DEFAULT_COLORS = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
];

function slug(value, fallback) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

const configPath = path.join(PROJECT_ROOT, "config.yml");
if (!fs.existsSync(configPath)) {
  throw new Error(`Configuration file not found: ${configPath}. Please copy config.example.yml to config.yml and fill in your values.`);
}

const rawConfig = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
const core = rawConfig.core || {};
const server = rawConfig.server || {};
const sync = rawConfig.sync || {};
const weather = rawConfig.weather || {};
const cals = rawConfig.calendars || {};

const accessToken = core.accessToken?.trim();
if (!accessToken) throw new Error("core.accessToken is required in config.yml.");

function calendarSources() {
  const seen = new Set();
  const sources = [];
  
  let position = 0;
  for (const [key, calConfig] of Object.entries(cals)) {
    if (!calConfig?.url) throw new Error(`Calendar '${key}' is missing a 'url'.`);
    
    const id = slug(key, String(position));
    if (seen.has(id)) throw new Error(`Duplicate calendar id: ${id}`);
    seen.add(id);

    sources.push({
      index: position,
      id,
      url: calConfig.url.trim(),
      name: calConfig.name?.trim() || null,
      color: calConfig.color?.trim() || null,
      fallbackColor: DEFAULT_COLORS[position % DEFAULT_COLORS.length],
    });
    position++;
  }
  
  return sources;
}

const calendars = calendarSources();
if (!calendars.length) throw new Error("At least one calendar source must be configured in config.yml.");

export const settings = {
  projectRoot: PROJECT_ROOT,
  port: server.port || 8000,
  host: server.host?.trim() || "127.0.0.1",
  timezone: core.timezone?.trim() || "Asia/Shanghai",
  accessToken,
  refreshIntervalSeconds: sync.refreshIntervalSeconds || 900,
  requestTimeoutSeconds: sync.requestTimeoutSeconds || 20,
  maxEventsPerDay: sync.maxEventsPerDay || 80,
  cacheDir: path.resolve(PROJECT_ROOT, "./storage/calendar"),
  weatherProvider: weather.provider?.trim().toLowerCase() || null,
  weatherApiKey: String(weather.apiKey || "").trim() || null,
  weatherLocation: String(weather.location || "").trim() || null,
  calendars,
};
