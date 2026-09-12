// Playwright storageState (cookies + localStorage) round-tripped through
// Firebase Storage. GitHub Actions runners have no persistent disk — this
// is the serialized stand-in for "one browser profile, reused" (CLAUDE.md
// Collector rules), using the same service account already used for
// Firestore.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getStorage } from "firebase-admin/storage";
import { ensureFirebaseApp } from "../firebase-app.js";

const STORAGE_OBJECT_PATH = "browser/storageState.json";

function bucket() {
  if (!process.env["FIREBASE_STORAGE_BUCKET"]) {
    // Deliberately not defaulting to a guessed `${projectId}.appspot.com` /
    // `.firebasestorage.app` — those naming schemes differ by project age,
    // and CLAUDE.md is explicit: never guess. Read the real name off the
    // Firebase console's Storage tab.
    throw new Error("FIREBASE_STORAGE_BUCKET is not set — check the Firebase console's Storage tab.");
  }
  ensureFirebaseApp();
  return getStorage().bucket();
}

// Downloads the last known-good storageState into a fresh temp file and
// returns its path — pass that straight to
// `browser.newContext({ storageState: path })`. Returns undefined when
// nothing has ever been uploaded (first run ever, or every run so far
// failed before a clean finish), in which case Playwright should start a
// plain cookie-less context — never an error, a fresh profile is a valid
// starting state.
export async function downloadStorageState(): Promise<string | undefined> {
  const file = bucket().file(STORAGE_OBJECT_PATH);
  const [exists] = await file.exists();
  if (!exists) return undefined;

  const dir = await mkdtemp(path.join(tmpdir(), "tanitjobs-storage-state-"));
  const localPath = path.join(dir, "storageState.json");
  await file.download({ destination: localPath });
  return localPath;
}

// Upload the state captured via `context.storageState({ path })`. The
// caller (once.ts, TKT-029) must only call this after a clean finish — a
// crashed or challenged run must never overwrite the last known-good state.
// This function has no way to know whether the run was clean; that
// ordering is entirely the caller's responsibility, on purpose, so a
// half-finished cycle can't accidentally poison the next one's cookies.
export async function uploadStorageState(localPath: string): Promise<void> {
  await bucket().upload(localPath, { destination: STORAGE_OBJECT_PATH });
}

export async function cleanupStorageStateFile(localPath: string): Promise<void> {
  await rm(path.dirname(localPath), { recursive: true, force: true });
}
