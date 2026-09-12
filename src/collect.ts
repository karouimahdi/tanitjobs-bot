// TODO(TKT-030): local-dev convenience loop that runs once.ts on a jittered
// interval. Production scheduling is GitHub Actions' cron trigger invoking
// once.ts directly (.github/workflows/collect.yml) — nothing in production
// should depend on this file.

console.log("collect: not implemented yet (local-dev loop only) — see TKT-030.");
