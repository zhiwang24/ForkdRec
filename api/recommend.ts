// api/recommend.ts
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

export default async function handler(req, res) {
  if (req.headers["x-api-key"] !== process.env.API_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // TODO: fetch weather + menus, score recommendations
  const hallsSnap = await db.collection("halls").get();
  const halls = hallsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // stub response
  return res.status(200).json({ ok: true, hallCount: halls.length });
}
