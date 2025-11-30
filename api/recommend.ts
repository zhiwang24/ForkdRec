// api/recommend.ts
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fetch from "node-fetch";

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}
const db = getFirestore();

// Weather → desired tags
function weatherTags({ tempC, condition }: { tempC: number; condition: string }) {
  const cond = condition.toLowerCase();
  const tags: string[] = [];
  if (cond.includes("rain")) tags.push("soup", "comfort", "hot");
  if (cond.includes("snow")) tags.push("soup", "hot", "comfort");
  if (tempC >= 28) tags.push("cold", "salad", "drink");
  if (tempC <= 10) tags.push("soup", "hot", "comfort");
  return tags.length ? tags : ["balanced"];
}

// Meal detection
function currentMealKey(date = new Date()) {
  const h = date.getHours();
  if (h >= 9 && h < 12) return "breakfast";
  if (h >= 12 && h < 17) return "lunch";
  if (h >= 17 && h < 21) return "dinner";
  return "lunch";
}

// Tag menu items
function tagMenu(items: { name: string; category?: string; labels?: string[] }[]) {
  return items.map((i) => {
    const name = i.name.toLowerCase();
    const cat = (i.category ?? "").toLowerCase();
    const labels = (i.labels ?? []).map((l) => l.toLowerCase());
    const tags = new Set<string>();
    if (name.includes("soup")) tags.add("soup");
    if (name.includes("salad")) tags.add("salad");
    if (name.includes("cold brew") || name.includes("iced") || name.includes("smoothie")) tags.add("drink").add("cold");
    if (name.includes("grill") || name.includes("burger") || name.includes("bbq") || name.includes("fried")) tags.add("comfort");
    if (cat.includes("beverage")) tags.add("drink");
    labels.forEach((l) => tags.add(l));
    return { ...i, tags: Array.from(tags) };
  });
}

// Score hall: tag overlap + open bonus + short-wait bonus
function scoreHall(hall, desiredTags: string[]) {
  const menu = tagMenu(hall.menuItems || []);
  const tagSet = new Set(menu.flatMap((m) => m.tags));
  let score = 0;
  desiredTags.forEach((t) => { if (tagSet.has(t)) score += 2; });
  if (hall.status === "open" || hall.isOpen === true) score += 1;
  // optional: parse waitTime like "5-10 min" and reward shorter waits
  const waitText = (hall.waitTime || "").toLowerCase();
  const match = waitText.match(/(\d+)/);
  if (match) {
    const mins = parseInt(match[1], 10);
    if (!Number.isNaN(mins)) {
      if (mins <= 5) score += 1;
      else if (mins <= 10) score += 0.5;
    }
  }
  const matchedTags = desiredTags.filter((t) => tagSet.has(t));
  const sampleItems = menu.filter((m) => m.tags.some((t) => desiredTags.includes(t))).slice(0, 3).map((m) => m.name);
  return { score, matchedTags, sampleItems };
}

// Open-Meteo fetch (set lat/lon to campus)
async function fetchWeather(lat = 33.7756, lon = -84.3963) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`weather fetch ${resp.status}`);
  const data = await resp.json();
  const tempC = data.current?.temperature_2m;
  const precip = data.current?.precipitation ?? 0;
  const code = data.current?.weather_code ?? 0;
  const condition =
    code === 0 ? "clear" :
    [1,2,3].includes(code) ? "cloudy" :
    [45,48].includes(code) ? "fog" :
    [51,53,55,56,57,61,63,65,66,67].includes(code) ? "rain" :
    [71,73,75,77,85,86].includes(code) ? "snow" : "cloudy";
  return { tempC, precipitation: precip, condition };
}

// Nutrislice menu fetcher
async function fetchMenu(slug: string, meal = "lunch") {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  const url = `https://techdining.api.nutrislice.com/menu/api/weeks/school/${slug}/menu-type/${meal}/${y}/${m}/${d}/?format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`nutrislice ${res.status}`);
  const data = await res.json();
  const items: any[] = [];
  function parse(arr: any[]) {
    let station = "Other";
    for (const obj of arr) {
      if (obj?.is_station_header && obj.text) { station = obj.text; continue; }
      const food = obj?.food;
      if (food?.name) {
        items.push({
          id: String(food.id ?? food.synced_id ?? obj.id ?? Math.random()),
          name: food.name,
          category: food.food_category ?? station,
          labels: (food.icons?.food_icons ?? []).map((i: any) => i.name || i.slug || "").filter(Boolean),
        });
      }
    }
  }
  if (Array.isArray(data?.menu_items)) parse(data.menu_items);
  return items;
}

export default async function handler(req, res) {
  if (req.headers["x-api-key"] !== process.env.API_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const weather = await fetchWeather(); // campus lat/lon above
    const desired = weatherTags(weather);
    const meal = currentMealKey();

    const hallsSnap = await db.collection("halls").get();
    const halls = hallsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const enriched = [];
    for (const h of halls) {
      let menuItems: any[] = h.menuItems || [];
      if ((!menuItems || menuItems.length === 0) && h.nutrisliceSlug) {
        try { menuItems = await fetchMenu(h.nutrisliceSlug, meal); } catch { menuItems = []; }
      }
      const { score, matchedTags, sampleItems } = scoreHall({ ...h, menuItems }, desired);
      enriched.push({ hallId: h.id, name: h.name, score, matchedTags, sampleItems });
    }

    let picks = enriched
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((p) => ({
        hallId: p.hallId,
        name: p.name,
        score: p.score,
        reason: `Matches ${p.matchedTags.join(", ") || "general"} for ${weather.condition}`,
        sampleItems: p.sampleItems,
      }));

    // Fallback if nothing scored
    if (picks.length === 0) {
      picks = enriched
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((p) => ({
          hallId: p.hallId,
          name: p.name,
          score: p.score,
          reason: "Top open options right now",
          sampleItems: p.sampleItems,
        }));
    }

    return res.status(200).json({ weather, desiredTags: desired, meal, picks });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "failed", detail: String(e) });
  }
}
