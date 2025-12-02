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

function weatherTags({ tempC, condition }: { tempC: number; condition: string }) {
  const cond = condition.toLowerCase();
  const tags: string[] = [];
  if (cond.includes("rain")) tags.push("soup", "comfort", "hot");
  if (cond.includes("snow")) tags.push("soup", "hot", "comfort");
  if (tempC >= 28) tags.push("cold", "salad", "drink");
  if (tempC <= 10) tags.push("soup", "hot", "comfort");
  return tags.length ? tags : ["balanced"];
}

const DEFAULT_TIME_ZONE = process.env.LOCAL_TIME_ZONE || "America/New_York";

function normalizeMenuItems(items: any[]) {
  return (items || []).map((raw) => {
    let obj = raw;
    if (typeof raw === "string") {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = { name: raw };
      }
    }
    return {
      id: String(obj?.id ?? Math.random()),
      name: String(obj?.name ?? "Item"),
      category: obj?.category,
      labels: Array.isArray(obj?.labels) ? obj.labels : [],
    };
  });
}

function currentMealKey(timeZone = DEFAULT_TIME_ZONE, date = new Date()) {
  const h = parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(date),
    10,
  );
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 16) return "lunch";
  if (h >= 16 && h < 22) return "dinner";
  return "nono";
}

function tagMenu(items: { name: string; category?: string; labels?: string[] }[]) {
  return items.map((i) => {
    const name = i.name.toLowerCase();
    const cat = (i.category ?? "").toLowerCase();
    const labels = (i.labels ?? []).map((l) => l.toLowerCase());
    const tags = new Set<string>();
    if (name.includes("soup")) tags.add("soup");
    if (name.includes("salad")) tags.add("salad");
    if (name.includes("cold brew") || name.includes("iced") || name.includes("smoothie")) tags.add("drink").add("cold");
    if (name.includes("grill") || name.includes("pasta") || name.includes("bbq") || name.includes("fried")) tags.add("comfort");
    if (cat.includes("beverage")) tags.add("drink");
    labels.forEach((l) => tags.add(l));
    return { ...i, tags: Array.from(tags) };
  });
}

function scoreHall(hall, desiredTags: string[]) {
  const menu = tagMenu(hall.menuItems || []);
  const tagSet = new Set(menu.flatMap((m) => m.tags));
  let score = 0;
  desiredTags.forEach((t) => { if (tagSet.has(t)) score += 2; });
  if (hall.status === "open" || hall.isOpen === true) score += 1;
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

function humanReason({
  weatherCondition,
  weatherTempC,
  matchedTags,
  waitText,
  distanceText,
  sampleItems,
}: {
  weatherCondition: string;
  weatherTempC: number | null | undefined;
  matchedTags: string[];
  waitText?: string;
  distanceText?: string | null;
  sampleItems?: string[];
}) {
  const hasSoup = matchedTags.includes("soup");
  const hasCold = matchedTags.includes("cold") || matchedTags.includes("drink");
  const hasComfort = matchedTags.includes("comfort");
  const tempF = typeof weatherTempC === "number" ? Math.round((weatherTempC * 9) / 5 + 32) : null;

  let mood: string;
  if (weatherCondition.includes("rain") && (hasSoup || hasComfort)) {
    mood = "some good comfort pick for the rain are";
  } else if (weatherCondition === "clear" && hasCold) {
    mood = "some cool option for clear skies are";
  } else if (hasSoup || hasComfort) {
    mood = "some comfort-friendly food are";
  } else if (hasCold) {
    mood = "some refreshing picks are";
  } else {
    mood = "some solid option right now are";
  }

  const parts: string[] = [];
  if (tempF !== null) parts.push(`It's ${tempF}°F`);
  parts.push(mood);
  if (waitText) parts.push(`short wait (${waitText})`);
  if (distanceText) parts.push(distanceText);

  let reason = parts.join(", ");
  if (sampleItems && sampleItems.length) {
    reason += `: ${sampleItems.slice(0, 2).join(", ")}`;
  }
  return reason;
}

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
      [1, 2, 3].includes(code) ? "cloudy" :
        [45, 48].includes(code) ? "fog" :
          [51, 53, 55, 56, 57, 61, 63, 65, 66, 67].includes(code) ? "rain" :
            [71, 73, 75, 77, 85, 86].includes(code) ? "snow" : "cloudy";
  return { tempC, precipitation: precip, condition };
}

async function fetchMenu(slug: string, meal = "lunch") {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  const url = `https://techdining.api.nutrislice.com/menu/api/weeks/school/${slug}/menu-type/${meal}/${y}/${m}/${d}/?format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`nutrislice ${res.status}`);
  const data = await res.json();

  const items: any[] = [];

  function parseMenuItemsArray(arr: any[]) {
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

  if (Array.isArray((data as any)?.menu_items)) {
    parseMenuItemsArray((data as any).menu_items);
  } else {
    const bucket: any[] = [];
    function walk(node: any) {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        if (node.name && (node.menu_id || node.menuItemId || node.id || node.food)) {
          bucket.push({
            id: String(node.id ?? node.menuItemId ?? node.menu_id ?? Math.random()),
            name: node.name,
            category: (node.category ?? node.foodCategory ?? node.station ?? "Other") as string,
            labels: [],
          });
        }
        Object.values(node).forEach(walk);
      }
    }
    walk(data);
    const seen = new Set<string>();
    bucket.forEach((it) => {
      const key = `${it.id}|${it.name}`;
      if (!seen.has(key)) { seen.add(key); items.push(it); }
    });
  }

  return items;
}


export default async function handler(req, res) {
  if (req.headers["x-api-key"] !== process.env.API_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const weather = await fetchWeather();
    const desired = weatherTags(weather);
    const meal = currentMealKey();

    const hallsSnap = await db.collection("halls").get();
    const halls = hallsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const enriched = [];
    for (const h of halls) {
      let menuItems: any[] = [];
      if (h.nutrisliceSlug) {
        try {
          menuItems = await fetchMenu(h.nutrisliceSlug, meal);
        } catch {
          menuItems = [];
        }
      } else if (Array.isArray(h.menuItems)) {
        menuItems = normalizeMenuItems(h.menuItems);
      }
      const waitTimeText =
        h.waitTime ??
        (typeof h.currentWaitMinutes === "number" ? `${h.currentWaitMinutes} min` : undefined);
      const { score, matchedTags, sampleItems } = scoreHall({ ...h, menuItems, waitTime: waitTimeText }, desired);
      enriched.push({ hallId: h.id, name: h.name, score, matchedTags, sampleItems });
    }


    let picks = enriched
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 1)
      .map((p) => {
        const reason = humanReason({
          weatherCondition: weather.condition,
          weatherTempC: weather.tempC,
          matchedTags: p.matchedTags,
          waitText: halls.find((h) => h.id === p.hallId)?.waitTime,
          distanceText: undefined,
          sampleItems: p.sampleItems,
        });
        return {
          hallId: p.hallId,
          name: p.name,
          score: p.score,
          reason,
          sampleItems: p.sampleItems,
        };
      });

    if (picks.length === 0) {
      picks = enriched
        .sort((a, b) => b.score - a.score)
        .slice(0, 1)
        .map((p) => ({
          hallId: p.hallId,
          name: p.name,
          score: p.score,
          reason: "Top open option right now",
          sampleItems: p.sampleItems,
        }));
    }
    await db.collection("recommendations").doc("global").set({
      updatedAt: Date.now(),
      weather,
      meal,
      pick: picks[0] || null, // single top pick
    });


    return res.status(200).json({ weather, desiredTags: desired, meal, picks });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "failed", detail: String(e) });
  }
}
