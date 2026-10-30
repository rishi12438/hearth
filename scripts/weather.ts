// description: Weather now, today and the next hours, shown as a tile. Args: <city name> or <lat> <lon>. Uses Open-Meteo (free, no key).
const args = process.argv.slice(2);
let lat = Number(args[0]), lon = Number(args[1]), place = "";
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  const q = args.join(" ").trim();
  if (!q) { console.log("Tell me a city, or share your location from the app."); process.exit(0); }
  const g: any = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(q)}`)).json();
  const hit = g?.results?.[0];
  if (!hit) { console.log(`I couldn't find a place called ${q}.`); process.exit(1); }
  lat = hit.latitude; lon = hit.longitude; place = [hit.name, hit.country_code].filter(Boolean).join(", ");
}
const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
  "&hourly=temperature_2m,precipitation_probability&forecast_hours=12" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto";
const res = await fetch(url);
if (!res.ok) { console.log(`Weather service error ${res.status}`); process.exit(1); }
const d: any = await res.json();
const CODES: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow",
  73: "Snow", 75: "Heavy snow", 80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm" };
const c = d.current, t = d.daily, hr = d.hourly;
const summary = CODES[c.weather_code] ?? "Mixed";
const tile = {
  type: "weather", title: place || "Weather",
  data: {
    place: place || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, temp: c.temperature_2m, feels: c.apparent_temperature, summary,
    high: t.temperature_2m_max[0], low: t.temperature_2m_min[0], rain: t.precipitation_probability_max[0], wind: c.wind_speed_10m,
    hours: hr.time.slice(0, 12).filter((_: string, i: number) => i % 2 === 0).map((time: string, i: number) => ({ t: time.slice(11, 16), temp: hr.temperature_2m[i * 2], rain: hr.precipitation_probability[i * 2] })),
  },
};
console.log(`@tile ${JSON.stringify(tile)}`);
console.log(`${place ? place + ": " : ""}${Math.round(c.temperature_2m)}°, ${summary.toLowerCase()}. Today ${Math.round(t.temperature_2m_min[0])}–${Math.round(t.temperature_2m_max[0])}°, ${t.precipitation_probability_max[0]}% chance of rain.`);
