// TKT-003 acceptance check: proves a service account can reach the Firestore
// emulator, write a doc, and read it back. Run via `npm run verify:emulator`,
// which boots the emulator, runs this, then tears the emulator down.
//
// Superseded as the "real" Firestore access point by src/db/repo.ts (TKT-008)
// — this file stays narrowly scoped to proving the emulator wiring works.

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT ?? "demo-tanitjobs-bot";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    "emulator-check: FIRESTORE_EMULATOR_HOST is not set — run this via " +
      "`npm run verify:emulator`, not directly.",
  );
  process.exit(1);
}

// The Firestore emulator doesn't check credentials at all — the Admin SDK
// skips real token resolution once it sees FIRESTORE_EMULATOR_HOST, so no
// credential (real or fake) needs to be supplied here.
initializeApp({ projectId });

const db = getFirestore();
const docRef = db.collection("_emulator_check").doc("ping");
const written = { ok: true, checkedAt: new Date().toISOString() };

await docRef.set(written);
const snapshot = await docRef.get();
const read = snapshot.data();

if (!snapshot.exists || read?.["ok"] !== true || read?.["checkedAt"] !== written.checkedAt) {
  console.error("emulator-check: write/read round-trip did not match", { written, read });
  process.exit(1);
}

console.log(`emulator-check: wrote and read back ${JSON.stringify(read)} against project "${projectId}" — OK`);
process.exit(0);
