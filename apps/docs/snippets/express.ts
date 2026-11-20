import { toNodeHandler } from "@usherjs/core/node";
import express from "express";
import { usher } from "./usher.js";

const app = express();
app.use(express.json()); // Body parsers before or after Usher both work.
// Once, at the root: serves /api/usher/* and the /.well-known documents, and passes everything else on.
app.use(toNodeHandler(usher, { trustProxy: true }));
app.get("/", (_req, res) => {
  res.send("Your app");
});
app.listen(3000);
