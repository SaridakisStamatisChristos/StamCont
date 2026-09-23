export async function open() {
  throw new Error(
    "SQLite-backed Core indexing is unavailable in the standalone Continue CLI bundle",
  );
}
