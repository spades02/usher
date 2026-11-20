import pg from "pg";
import { postgresExecutor } from "usherjs";

// Your app's existing Postgres pool. Usher keeps its tables (prefixed `usher_`) next to yours.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = postgresExecutor(pool);
