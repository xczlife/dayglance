import path from "node:path";
import { DateTime } from "luxon";

import { readJson, writeJsonAtomic } from "../../core/fs-utils.js";
import { fetchJsonWithTimeout } from "../../core/http.js";

const WEATHER_EMOJI = {
  "晴": "☀️",
  "少云": "🌤️",
  "晴间多云": "⛅",
  "多云": "⛅",
  "阴": "☁️",
  "阵雨": "🌦️",
  "雷阵雨": "⛈️",
  "小雨": "🌧️",
  "中雨": "🌧️",
  "大雨": "🌧️",
  "暴雨": "🌧️",
  "小雪": "❄️",
  "中雪": "❄️",
  "大雪": "❄️",
  "暴雪": "❄️",
  "雾": "🌫️",
  "霾": "🌫️",
  "未知": "🌡️",
};

export class WeatherService {
  constructor(settings) {
    this.settings = settings;
    this.cacheFile = path.join(settings.cacheDir, "..", "weather.json");
    this.weatherCache = new Map();
    this.forecastCache = new Map();
  }

  async load() {
    const raw = await readJson(this.cacheFile, {});
    for (const [key, value] of Object.entries(raw)) {
      if (value.kind === "weather") this.weatherCache.set(key, value);
      if (value.kind === "forecast") this.forecastCache.set(key, value);
    }
  }

  async snapshot() {
    const payload = {};
    for (const [key, value] of this.weatherCache.entries()) payload[key] = value;
    for (const [key, value] of this.forecastCache.entries()) payload[key] = value;
    await writeJsonAtomic(this.cacheFile, payload);
  }

  async current() {
    if (this.settings.weatherProvider !== "amap") {
      return { weather: null, forecast: null };
    }

    if (!this.settings.weatherApiKey || !this.settings.weatherLocation) {
      return { weather: null, forecast: null };
    }

    const [weather, forecast] = await Promise.all([
      this.fetchWeather(this.settings.weatherLocation, this.settings.weatherApiKey),
      this.fetchForecast(this.settings.weatherLocation, this.settings.weatherApiKey),
    ]);

    let text = weather;
    if (forecast?.length) {
      const today = forecast[0];
      const emoji = weather?.split(" ")[0] || today.day_emoji;
      text = `${emoji} ${today.night_temp}°-${today.day_temp}°`;
    }
    return { weather: text, forecast };
  }

  async fetchWeather(location, apiKey) {
    const cacheKey = `amap:${location}`;
    const now = DateTime.now().setZone(this.settings.timezone);
    const cached = this.weatherCache.get(cacheKey);
    if (cached && now.diff(DateTime.fromISO(cached.at), "minutes").minutes < 30) return cached.text;

    try {
      const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
      url.search = new URLSearchParams({
        key: apiKey,
        city: location,
        extensions: "base",
        output: "JSON",
      }).toString();
      const data = await fetchJsonWithTimeout(url, {
        timeoutMs: this.settings.requestTimeoutSeconds * 1000,
        headers: { "user-agent": "dayglance/0.1" },
      });
      if (data.status === "1" && data.lives?.length) {
        const live = data.lives[0];
        const emoji = WEATHER_EMOJI[live.weather] || "🌡️";
        const text = `${emoji} ${live.temperature}°`;
        this.weatherCache.set(cacheKey, { kind: "weather", at: now.toISO(), text });
        await this.snapshot();
        return text;
      }
    } catch {}

    return cached?.text || null;
  }

  async fetchForecast(location, apiKey) {
    const cacheKey = `amap_fc:${location}`;
    const now = DateTime.now().setZone(this.settings.timezone);
    const cached = this.forecastCache.get(cacheKey);
    if (cached && now.diff(DateTime.fromISO(cached.at), "minutes").minutes < 60) return cached.data;

    try {
      const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
      url.search = new URLSearchParams({
        key: apiKey,
        city: location,
        extensions: "all",
        output: "JSON",
      }).toString();
      const data = await fetchJsonWithTimeout(url, {
        timeoutMs: this.settings.requestTimeoutSeconds * 1000,
        headers: { "user-agent": "dayglance/0.1" },
      });
      if (data.status === "1" && data.forecasts?.length) {
        const casts = data.forecasts[0].casts ?? [];
        const today = DateTime.now().setZone(this.settings.timezone).startOf("day");
        const result = casts.slice(0, 4).map((cast) => {
          const date = DateTime.fromISO(cast.date, { zone: this.settings.timezone });
          return {
            label: date.hasSame(today, "day") ? "今天" : ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][date.weekday - 1],
            day_emoji: WEATHER_EMOJI[cast.dayweather] || "🌡️",
            day_temp: cast.daytemp,
            night_temp: cast.nighttemp,
          };
        });
        this.forecastCache.set(cacheKey, { kind: "forecast", at: now.toISO(), data: result });
        await this.snapshot();
        return result;
      }
    } catch {}

    return cached?.data || null;
  }
}
