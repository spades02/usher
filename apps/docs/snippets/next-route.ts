// app/api/usher/[...usher]/route.ts, and the same file at app/.well-known/[...usher]/route.ts
import { toRouteHandlers } from "usherjs";
import { usher } from "./usher.js";

export const { GET, POST, OPTIONS, DELETE } = toRouteHandlers(usher);
