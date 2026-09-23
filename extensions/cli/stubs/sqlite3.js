class UnsupportedDatabase {
  constructor() {
    throw new Error(
      "SQLite-backed Core indexing is unavailable in the standalone Continue CLI bundle",
    );
  }
}

export const Database = UnsupportedDatabase;
export default { Database: UnsupportedDatabase };
