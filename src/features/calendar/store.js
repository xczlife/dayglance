import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";

import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from "../../core/fs-utils.js";
import { fetchTextWithTimeout } from "../../core/http.js";
import { parseCalendarText } from "./parser.js";

const DEFAULT_COLORS = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
];

function calendarNameFromText(text, fallback) {
  const match = text.match(/^X-WR-CALNAME:(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function calendarColorFromText(text, fallback) {
  const apple = text.match(/^X-APPLE-CALENDAR-COLOR:(.+)$/m);
  if (apple?.[1]?.trim()) return apple[1].trim();
  const generic = text.match(/^COLOR:(.+)$/m);
  return generic?.[1]?.trim() || fallback;
}

export class CalendarStore {
  constructor(settings) {
    this.settings = settings;
    this.statePath = path.join(settings.cacheDir, "state.json");
    this.eventsPath = path.join(settings.cacheDir, "events.json");
    this.sourcesPath = path.join(settings.cacheDir, "sources.json");
    this.dayIndex = new Map();
    this.sources = [];
    this.state = { last_refresh_attempt: null, last_success: null, sources: [] };
    this._refreshPromise = null;
  }

  async load() {
    await ensureDir(this.settings.cacheDir);
    const [state, eventsByDay, sources] = await Promise.all([
      readJson(this.statePath, this.state),
      readJson(this.eventsPath, {}),
      readJson(this.sourcesPath, []),
    ]);
    this.state = state;
    this.sources = sources;
    this.dayIndex = new Map(Object.entries(eventsByDay));
  }

  eventsForDay(dayIso, calendarIds = null) {
    const events = this.dayIndex.get(dayIso) ?? [];
    if (!calendarIds) return events.slice(0, this.settings.maxEventsPerDay);
    return events.filter((event) => calendarIds.has(event.source_id)).slice(0, this.settings.maxEventsPerDay);
  }

  payloadForDay(dayIso, calendarIds = null) {
    const day = DateTime.fromISO(dayIso, { zone: this.settings.timezone });
    const selectedIds = calendarIds ?? new Set(this.sources.map((source) => source.id));
    return {
      date: day.toISODate(),
      date_label: `${day.month}月${day.day}日`,
      weekday_label: "一二三四五六日"[day.weekday - 1],
      timezone: this.settings.timezone,
      now: DateTime.now().setZone(this.settings.timezone).toISO(),
      now_label: DateTime.now().setZone(this.settings.timezone).toFormat("HH:mm"),
      events: this.eventsForDay(day.toISODate(), calendarIds),
      calendars: this.sources.map((source) => ({
        id: source.id,
        name: source.name,
        color: source.color,
        selected: selectedIds.has(source.id),
      })),
      state: this.state,
    };
  }

  staleMinutes() {
    if (!this.state.last_success) return null;
    const last = DateTime.fromISO(this.state.last_success, { zone: this.settings.timezone });
    return Math.max(0, Math.round(DateTime.now().setZone(this.settings.timezone).diff(last, "minutes").minutes));
  }

  async refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._refresh();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _refresh() {
    const now = DateTime.now().setZone(this.settings.timezone);
    const windowStart = now.startOf("day").minus({ days: 30 });
    const windowEnd = now.endOf("day").plus({ days: 365 });
    const dayIndex = new Map();
    const sourceMeta = [];
    const stateSources = [];

    for (let i = 0; i < this.settings.calendars.length; i += 1) {
      const source = this.settings.calendars[i];
      const fallbackColor = source.color || source.fallbackColor || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
      const cacheFile = path.join(this.settings.cacheDir, `${source.id}.ics`);
      const meta = {
        id: source.id,
        index: source.index,
        name: source.name || source.id,
        color: fallbackColor,
        ok: false,
        using_cache: false,
        cache_file: cacheFile,
        fetched_at: null,
        error: null,
      };

      let text = null;
      try {
        text = await fetchTextWithTimeout(source.url, {
          timeoutMs: this.settings.requestTimeoutSeconds * 1000,
          headers: { "user-agent": "dayglance/0.1" },
          redirect: "follow",
        });
        if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Downloaded content is not VCALENDAR.");
        await writeTextAtomic(cacheFile, text);
        meta.ok = true;
        meta.fetched_at = now.toISO();
      } catch (error) {
        meta.error = error instanceof Error ? error.message : String(error);
        meta.using_cache = true;
        text = await fs.readFile(cacheFile, "utf8").catch(() => null);
      }

      if (!text) {
        stateSources.push(meta);
        sourceMeta.push({ id: source.id, name: meta.name, color: meta.color });
        continue;
      }

      meta.name = source.name || calendarNameFromText(text, source.id);
      meta.color = source.color || calendarColorFromText(text, fallbackColor);
      sourceMeta.push({ id: source.id, name: meta.name, color: meta.color });

      try {
        const parsedDays = parseCalendarText({
          text,
          source: { ...source, name: meta.name, color: meta.color },
          timezone: this.settings.timezone,
          now,
          windowStart,
          windowEnd,
          maxEventsPerDay: this.settings.maxEventsPerDay,
        });

        for (const [dayKey, events] of parsedDays.entries()) {
          if (!dayIndex.has(dayKey)) dayIndex.set(dayKey, []);
          for (const event of events) {
            dayIndex.get(dayKey).push(event);
          }
        }
      } catch (error) {
        meta.error = meta.error || (error instanceof Error ? error.message : String(error));
      }

      stateSources.push(meta);
    }

    for (const [dayKey, events] of dayIndex.entries()) {
      events.sort((a, b) => {
        if (a.all_day && !b.all_day) return -1;
        if (!a.all_day && b.all_day) return 1;
        return a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title);
      });
      dayIndex.set(dayKey, events.slice(0, this.settings.maxEventsPerDay));
    }

    this.state = {
      last_refresh_attempt: now.toISO(),
      last_success: stateSources.some((source) => source.ok) ? now.toISO() : this.state.last_success,
      sources: stateSources,
    };
    this.sources = sourceMeta;
    this.dayIndex = dayIndex;

    await Promise.all([
      writeJsonAtomic(this.statePath, this.state),
      writeJsonAtomic(this.sourcesPath, this.sources),
      writeJsonAtomic(this.eventsPath, Object.fromEntries(dayIndex)),
    ]);

    return this.state;
  }
}
