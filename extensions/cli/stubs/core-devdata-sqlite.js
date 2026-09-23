// The CLI does not expose Core's local developer token-metrics database.
// Keep the BaseLLM call surface intact without loading sqlite3/native bindings.
export class DevDataSqliteDb {
  static async logTokensGenerated() {}

  static async getTokensPerDay() {
    return [];
  }

  static async getTokensPerModel() {
    return [];
  }
}
