import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import nunjucks from "nunjucks";
import { DateTime } from "luxon";

import { settings, PROJECT_ROOT } from "../core/config.js";
import { CalendarStore } from "../features/calendar/store.js";
import { WeatherService } from "../features/weather/service.js";

const app = Fastify({ logger: false });
const store = new CalendarStore(settings);
const weather = new WeatherService(settings);
const PRIMARY_WIDGET_PATH = "/today";
let firstRefreshStarted = false;

function checkToken(token) {
  if (token !== settings.accessToken) {
    const error = new Error("Invalid token");
    error.statusCode = 403;
    throw error;
  }
}

function parseCalendarFilter(raw) {
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "all") return null;
  const requested = new Set(raw.split(/[\s,]+/).filter(Boolean));
  const valid = new Set(store.sources.map((source) => source.id));
  const unknown = [...requested].filter((value) => !valid.has(value));
  if (unknown.length) {
    const error = new Error(`Unknown calendar id: ${unknown.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return requested;
}

function widgetUrl({ token, day, cal, refresh = false }) {
  const url = new URL(PRIMARY_WIDGET_PATH, "http://local");
  url.searchParams.set("token", token);
  url.searchParams.set("day", day);
  if (cal) url.searchParams.set("cal", cal);
  if (refresh) url.searchParams.set("refresh", "1");
  return `${url.pathname}${url.search}`;
}

function startupReport() {
  const originHost = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host;
  const origin = `http://${originHost}:${settings.port}`;
  const token = settings.accessToken;

  console.log("");
  console.log("Dayglance server is running");
  console.log(`- Listen: http://${settings.host}:${settings.port}`);
  console.log(`- Widget: ${origin}/today?token=${token}`);
  console.log(`- API:    ${origin}/api/today?token=${token}`);
  console.log(`- Refresh:${origin}/today?token=${token}&refresh=1`);
  console.log(`- Filter: ${origin}/today?token=${token}&cal=1`);
  console.log("");
}

function startBackgroundRefresh() {
  if (firstRefreshStarted) return;
  firstRefreshStarted = true;
  store.refresh().catch((error) => {
    console.error("Initial store refresh failed:", error?.message || error);
  });
  weather.refresh().catch((error) => {
    console.error("Initial weather refresh failed:", error?.message || error);
  });
}

function staleMinutes() {
  if (!store.state.last_success) return null;
  const last = DateTime.fromISO(store.state.last_success, { zone: settings.timezone });
  return Math.max(0, Math.round(DateTime.now().setZone(settings.timezone).diff(last, "minutes").minutes));
}

function weekDays(targetDay, token, cal, calendarIds) {
  const start = targetDay.startOf("week");
  return Array.from({ length: 7 }, (_, index) => {
    const day = start.plus({ days: index });
    return {
      date: day.toISODate(),
      label: String(day.day),
      weekday: "一二三四五六日"[day.weekday - 1],
      url: widgetUrl({ token, day: day.toISODate(), cal }),
      is_active: day.hasSame(targetDay, "day"),
      is_today: day.hasSame(DateTime.now().setZone(settings.timezone), "day"),
      has_events: store.eventsForDay(day.toISODate(), calendarIds).length > 0,
    };
  });
}

app.register(fastifyStatic, {
  root: path.join(PROJECT_ROOT, "public"),
  prefix: "/static/",
  maxAge: "1d",
});

app.register(fastifyView, {
  engine: { nunjucks },
  root: path.join(PROJECT_ROOT, "views"),
  viewExt: "njk",
  options: {
    autoescape: true,
  },
});

app.get("/", async () => "Calendar widget is running.");

app.get("/healthz", async (_, reply) => {
  if (!store.state.last_success) return { ok: "true", status: "no_sync_yet" };
  const minutes = staleMinutes();
  if (minutes !== null && minutes > 360) {
    return reply.code(503).send({ ok: "false", status: "stale_sync", minutes_since_last_success: minutes });
  }
  return { ok: "true", status: "healthy" };
});

app.get("/refresh", async (request) => {
  checkToken(request.query.token);
  await weather.refresh();
  return store.refresh();
});

app.get("/api/today", async (request) => {
  checkToken(request.query.token);
  const day = request.query.day || DateTime.now().setZone(settings.timezone).toISODate();
  const calendarIds = parseCalendarFilter(request.query.calendar || request.query.cal || null);
  return store.payloadForDay(day, calendarIds);
});

async function renderToday(request, reply) {
  checkToken(request.query.token);
  const token = request.query.token;
  const cal = request.query.calendar || request.query.cal || null;
  const calendarIds = parseCalendarFilter(cal);
  const targetDay = DateTime.fromISO(request.query.day || DateTime.now().setZone(settings.timezone).toISODate(), { zone: settings.timezone });

  if (request.query.refresh === "1" || request.query.refresh === true) {
    await store.refresh();
    await weather.refresh();
    reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return reply.redirect(widgetUrl({ token, day: targetDay.toISODate(), cal }), 303);
  }

  const payload = store.payloadForDay(targetDay.toISODate(), calendarIds);
  const { weather: weatherText, forecast } = weather.current();

  // Allow the browser/Obsidian iframe to cache the HTML for 60 seconds
  // This makes switching back and forth between notes feel completely instant
  reply.header("Cache-Control", "public, max-age=60");

  return reply.view("today.njk", {
    ...payload,
    target_day: targetDay.toISODate(),
    week_days: weekDays(targetDay, token, cal, calendarIds),
    prev_week_url: widgetUrl({ token, day: targetDay.minus({ days: 7 }).toISODate(), cal }),
    prev_url: widgetUrl({ token, day: targetDay.minus({ days: 1 }).toISODate(), cal }),
    today_url: widgetUrl({ token, day: DateTime.now().setZone(settings.timezone).toISODate(), cal }),
    next_url: widgetUrl({ token, day: targetDay.plus({ days: 1 }).toISODate(), cal }),
    next_week_url: widgetUrl({ token, day: targetDay.plus({ days: 7 }).toISODate(), cal }),
    refresh_url: widgetUrl({ token, day: targetDay.toISODate(), cal, refresh: true }),
    refresh_interval_seconds: settings.refreshIntervalSeconds,
    stale_minutes: staleMinutes(),
    weather: weatherText,
    weather_forecast: forecast,
  });
}

app.get("/today", renderToday);
app.get("/widget/today", renderToday);

app.setErrorHandler((error, _, reply) => {
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({ detail: error.message || "Internal Server Error" });
});

await store.load();
await weather.load();
await app.listen({ host: settings.host, port: settings.port });
startupReport();
startBackgroundRefresh();
setInterval(() => {
  store.refresh().catch(() => {});
  weather.refresh().catch(() => {});
}, settings.refreshIntervalSeconds * 1000).unref();
