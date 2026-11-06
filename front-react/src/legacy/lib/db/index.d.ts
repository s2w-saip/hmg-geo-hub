// Type-only snapshot; no database or server implementation is included.
import "server-only";
import postgres from "postgres";
import * as schema from "./schema";
export declare function getDb(): import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema> & {
    $client: postgres.Sql<{}>;
};
