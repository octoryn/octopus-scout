// The real-world default storage backend is now SQLite, but the existing test
// suite was written against the file backend. Pin the file backend for tests
// UNLESS the env var is already set (so dedicated sqlite tests can override it).
if (process.env.OCTORYN_SCOUT_DISABLE_DOTENV === undefined) {
  process.env.OCTORYN_SCOUT_DISABLE_DOTENV = "1";
}

if (process.env.OCTORYN_SCOUT_STORAGE_BACKEND === undefined) {
  process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "file";
}
