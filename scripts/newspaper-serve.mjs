// Serve THE JEEVES DAILY locally against the fixtures built by
// newspaper-preview.mjs, using the real router:
//
//   node scripts/newspaper-preview.mjs --live
//   node scripts/newspaper-serve.mjs            → http://127.0.0.1:4173/news
//
// Set NEWS_PASSWORD to exercise the reading-key / Basic-auth path.

import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createNewspaperRouter } from "../src/newspaper/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = process.env.PREVIEW_WORKSPACE ?? path.join(root, ".preview", "workspace");
const port = Number(process.env.PORT ?? 4173);

const app = express();
app.use(
  "/news",
  createNewspaperRouter({
    workspaceDir: workspace,
    stateDir: path.join(root, ".preview"),
    setupPassword: process.env.NEWS_PASSWORD?.trim() || undefined,
  }),
);
app.get("/", (_req, res) => res.redirect("/news"));

// Device frame, for checking the responsive recomposition without resizing
// the actual browser window:  /frame?w=390&u=/news
app.get("/frame", (req, res) => {
  const w = Number(req.query.w ?? 390);
  const h = Number(req.query.h ?? 1400);
  const u = String(req.query.u ?? "/news");
  res.type("html").send(
    `<body style="margin:0;background:#555;display:flex;justify-content:center">
<iframe src="${u}" style="width:${w}px;height:${h}px;border:0;background:#fff" scrolling="no"></iframe>`,
  );
});

app.listen(port, "127.0.0.1", () => {
  console.log(`workspace: ${workspace}`);
  console.log(`http://127.0.0.1:${port}/news`);
});
