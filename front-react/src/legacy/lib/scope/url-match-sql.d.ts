// Type-only snapshot; no database or server implementation is included.
import { type SQL } from "drizzle-orm";
export declare function targetMatchSql(cited: SQL, target: SQL): SQL;
