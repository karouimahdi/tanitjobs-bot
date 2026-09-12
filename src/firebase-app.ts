// Single shared Firebase Admin app init. db/repo.ts and browser/session-state.ts
// both need the default app, and initializeApp() options only take effect on
// whichever call creates the app first — splitting the init logic between two
// modules would silently drop storageBucket if repo.ts's Firestore access
// happened to run first. One function, called from both places, avoids that.

import { getApps, initializeApp } from "firebase-admin/app";

export function ensureFirebaseApp(): void {
  if (getApps().length > 0) return;
  initializeApp({
    projectId: process.env["GCLOUD_PROJECT"] ?? "demo-tanitjobs-bot",
    storageBucket: process.env["FIREBASE_STORAGE_BUCKET"],
  });
}
