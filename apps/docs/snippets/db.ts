import { postgresExecutor } from "@usherjs/core";
import pg from "pg";

// Your app's existing Postgres pool. Usher keeps its tables (prefixed `usher_`) next to yours.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = postgresExecutor(pool);
