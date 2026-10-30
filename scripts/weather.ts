// description: Current weather and today's forecast. Args: <lat> <lon>. Uses Open-Meteo (free, no key).
const [lat, lon] = process.argv.slice(2).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.log("Need a location: share your location from the app first.");
  process.exit(0);
}
const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto";
const res = await fetch(url);
if (!res.ok) { console.log(`Weather service error ${res.status}`); process.exit(1); }
const d: any = await res.json();
const CODES: Record<number, string> = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow",
  73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers", 95: "thunderstorm" };
const c = d.current, t = d.daily;
console.log(`Now ${Math.round(c.temperature_2m)}° (feels ${Math.round(c.apparent_temperature)}°), ${CODES[c.weather_code] ?? "mixed"}, wind ${Math.round(c.wind_speed_10m)} km/h.`);
console.log(`Today ${Math.round(t.temperature_2m_min[0])}–${Math.round(t.temperature_2m_max[0])}°, ${t.precipitation_probability_max[0]}% chance of rain.`);
