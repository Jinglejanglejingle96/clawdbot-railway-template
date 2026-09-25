// THE JEEVES DAILY — web routes.
//
// Mounted at /news by src/server.js, ahead of the dashboard catch-all.
// Reads editions REPORTER wrote to the workspace volume and renders them.
// Nothing here calls a model.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import { ensureImages } from "./images.js";
import { renderArchive, renderArticle, renderEmpty, renderFrontPage } from "./render.js";
import {
  DATE_RE,
  findStory,
  listEditions,
  londonToday,
  newspaperDir,
  pruneEditions,
  readEdition,
  readLatestEdition,
} from "./store.js";

const COOKIE = "jd_key";
const COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const FIRST_EDITION = "2026-09-23";

function resolveNewsToken(stateDir) {
  const fromEnv = process.env.NEWS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenPath = path.join(stateDir, "news.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through and mint one
  }
  const generated = crypto.randomBytes(24).toString("base64url");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort; an ephemeral token still works until restart
  }
  return generated;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** Publicly reachable base URL, used only to write the link REPORTER pastes. */
function publicBase() {
  const explicit = process.env.NEWS_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return domain ? `https://${domain}` : "";
}

// Archive rows need each edition's lead headline; memoise on mtime so the
// archive page does not re-parse every file on every load.
const summaryCache = new Map();

function editionSummary(workspaceDir, date) {
  let stamp = 0;
  try {
    stamp = fs.statSync(path.join(newspaperDir(workspaceDir), `${date}.json`)).mtimeMs;
  } catch {
    return null;
  }
  const hit = summaryCache.get(date);
  if (hit && hit.stamp === stamp) return hit.value;
  const ed = readEdition(workspaceDir, date);
  if (!ed) return null;
  const value = { date, headline: ed.lead?.headline ?? "", storyCount: ed.storyCount };
  summaryCache.set(date, { stamp, value });
  return value;
}

export function createNewspaperRouter({ workspaceDir, stateDir, setupPassword, mountPath = "/news" }) {
  const router = express.Router();
  const token = resolveNewsToken(stateDir);

  // Publish the reading link where REPORTER can read it, so the token never
  // has to live in the prompt repo.
  const base = publicBase();
  if (base) {
    try {
      fs.mkdirSync(newspaperDir(workspaceDir), { recursive: true });
      fs.writeFileSync(
        path.join(newspaperDir(workspaceDir), "link.txt"),
        `${base}${mountPath}?k=${token}\n`,
        "utf8",
      );
    } catch {
      // non-fatal
    }
  }

  // --- access -------------------------------------------------------------
  // Same posture as the rest of the wrapper: open when no password is set.
  // Otherwise a long-lived reading key (shareable in a Telegram link) or the
  // existing dashboard password both work.
  router.use((req, res, next) => {
    if (!setupPassword) return next();

    const supplied = typeof req.query.k === "string" ? req.query.k : "";
    if (supplied && safeEqual(supplied, token)) {
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure || req.get("x-forwarded-proto") === "https",
        maxAge: COOKIE_MAX_AGE_MS,
      });
      return next();
    }
    if (readCookie(req, COOKIE) && safeEqual(readCookie(req, COOKIE), token)) return next();

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const pw = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pw, setupPassword)) return next();
    }

    res.set("WWW-Authenticate", 'Basic realm="The Jeeves Daily"');
    return res.status(401).type("text/plain").send("The Jeeves Daily is private.");
  });

  // Stylesheet URL is versioned by file mtime, so a redeploy that changes the
  // design is picked up immediately instead of after the cache expires.
  const cssPath = new URL("./theme.css", import.meta.url);
  let cssVersion = "1";
  try {
    cssVersion = Math.round(fs.statSync(cssPath).mtimeMs).toString(36);
  } catch {
    // keep the default
  }

  // Per-request rendering context. Carries the reading key through links when
  // the reader arrived by key and cookies were not accepted.
  function context(req, date) {
    const key = typeof req.query.k === "string" && req.query.k ? encodeURIComponent(req.query.k) : "";
    const carry = key ? `?k=${key}` : "";
    let editionNo = null;
    if (date) {
      // Old editions are pruned, so count from the first issue, not the oldest file.
      const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${FIRST_EDITION}T00:00:00Z`)) / 86400000);
      if (Number.isFinite(days) && days >= 0) editionNo = (days + 1).toLocaleString("en-GB");
    }
    return {
      date: date ?? londonToday(),
      editionNo,
      css: `${mountPath}/style.css?v=${cssVersion}${key ? `&k=${key}` : ""}`,
      link: (p) => `${mountPath}${p === "/" ? "" : p}${carry}`,
    };
  }

  router.get("/style.css", (_req, res) => {
    res.type("text/css").set("Cache-Control", "public, max-age=86400").send(fs.readFileSync(cssPath, "utf8"));
  });

  router.get("/archive", (req, res) => {
    const entries = listEditions(workspaceDir)
      .map((d) => editionSummary(workspaceDir, d))
      .filter(Boolean);
    res.type("html").set("Cache-Control", "private, max-age=60").send(renderArchive(entries, context(req, entries[0]?.date)));
  });

  router.get("/", async (req, res, next) => {
    try {
      const edition = readLatestEdition(workspaceDir);
      if (!edition) {
        return res
          .status(404)
          .type("html")
          .send(renderEmpty(context(req, null), "REPORTER has not filed an edition yet."));
      }
      pruneEditions(workspaceDir, edition.date);
      await ensureImages(workspaceDir, edition, { prune: true });
      res.type("html").set("Cache-Control", "private, max-age=60").send(renderFrontPage(edition, context(req, edition.date)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:date", async (req, res, next) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return next();
    try {
      const edition = readEdition(workspaceDir, date);
      if (!edition) {
        return res
          .status(404)
          .type("html")
          .send(renderEmpty(context(req, date), "No edition was published on this date."));
      }
      await ensureImages(workspaceDir, edition);
      res.type("html").set("Cache-Control", "private, max-age=300").send(renderFrontPage(edition, context(req, date)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:date/s/:slug", async (req, res, next) => {
    const { date, slug } = req.params;
    if (!DATE_RE.test(date)) return next();
    try {
      const edition = readEdition(workspaceDir, date);
      const story = findStory(edition, slug);
      if (!story) {
        return res
          .status(404)
          .type("html")
          .send(renderEmpty(context(req, date), "That story is not in this edition."));
      }
      await ensureImages(workspaceDir, edition, { budgetMs: 2500 });
      res.type("html").set("Cache-Control", "private, max-age=300").send(renderArticle(edition, story, context(req, date)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
