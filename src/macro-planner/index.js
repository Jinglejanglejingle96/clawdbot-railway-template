// Phone access to the Python meal planner on the persistent Jeeves workspace.
// The wrapper owns the public URL and cookie; Python stays on loopback.
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

const COOKIE = "jm_key";
const COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i >= 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function resolveToken(stateDir) {
  const configured = process.env.MEAL_PLANNER_TOKEN?.trim();
  if (configured) return configured;
  const tokenPath = path.join(stateDir, "meal-planner.token");
  try {
    const saved = fs.readFileSync(tokenPath, "utf8").trim();
    if (saved) return saved;
  } catch { /* first run */ }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

function publicBase() {
  const explicit = process.env.MEAL_PLANNER_BASE_URL?.trim() || process.env.NEWS_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return domain ? `https://${domain}` : "";
}

export function createMacroPlannerRouter({ workspaceDir, stateDir, setupPassword, mountPath = "/macros", port = 8766,
  pythonCommand = process.env.MEAL_PLANNER_PYTHON || "python3" }) {
  const router = express.Router();
  const token = resolveToken(stateDir);
  const base = publicBase();
  if (base) {
    const linkDir = path.join(workspaceDir, "data", "coach");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(linkDir, "meal_planner_link.txt"), `${base}${mountPath}?k=${token}\n`, { encoding: "utf8", mode: 0o600 });
  }

  const target = `http://127.0.0.1:${port}`;
  let child = null;
  let starting = null;
  let ready = false;

  function continueAuthorized(req, res, next) {
    if (req.method === "GET" && req.originalUrl.split("?")[0] === mountPath) {
      return res.redirect(302, `${mountPath}/`);
    }
    return next();
  }

  async function ensureRunning() {
    if (ready && child && child.exitCode === null) return;
    if (starting) return starting;
    starting = (async () => {
      if (!fs.existsSync(path.join(workspaceDir, "scripts", "meal_planner", "server.py"))) {
        throw new Error("Planner package is missing from the Jeeves workspace");
      }
      if (child && child.exitCode === null) child.kill("SIGTERM");
      let spawnError = null;
      child = childProcess.spawn(pythonCommand, ["-u", "-m", "scripts.meal_planner.server", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: workspaceDir,
        env: { ...process.env, J33V35_WORKSPACE: workspaceDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", (err) => { spawnError = err; });
      child.on("exit", () => { ready = false; });
      child.stdout.on("data", (chunk) => process.stdout.write(`[macro-planner] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[macro-planner] ${chunk}`));
      for (let attempt = 0; attempt < 30; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Planner exited with status ${child.exitCode}`);
        try {
          const headers = process.env.MEAL_PLANNER_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.MEAL_PLANNER_ACCESS_TOKEN}` } : {};
          const response = await fetch(`${target}/api/today`, { headers, signal: AbortSignal.timeout(500) });
          if (response.ok) { ready = true; return; }
        } catch { /* still starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Planner did not become ready");
    })().finally(() => { starting = null; });
    return starting;
  }

  router.use((req, res, next) => {
    const supplied = typeof req.query.k === "string" ? req.query.k : "";
    if (req.method === "GET" && supplied && safeEqual(supplied, token)) {
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure || req.get("x-forwarded-proto") === "https",
        maxAge: COOKIE_MAX_AGE_MS,
      });
      return res.redirect(302, `${mountPath}/`);
    }
    if (readCookie(req, COOKIE) && safeEqual(readCookie(req, COOKIE), token)) {
      return continueAuthorized(req, res, next);
    }
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    if (scheme === "Basic" && encoded && setupPassword) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const pw = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pw, setupPassword)) return continueAuthorized(req, res, next);
    }
    res.set("WWW-Authenticate", 'Basic realm="Jeeves Macro Planner"');
    return res.status(401).type("text/plain").send("Jeeves Macro Planner is private.");
  });

  router.use(async (req, res) => {
    if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) return res.sendStatus(405);
    if (req.method !== "GET") {
      const origin = req.get("origin");
      const expected = `${req.get("x-forwarded-proto") || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`;
      if ((origin && origin !== expected) || req.get("sec-fetch-site") === "cross-site") {
        return res.status(403).json({ error: "Cross-site write blocked" });
      }
    }
    try {
      await ensureRunning();
      const headers = {};
      if (req.method !== "GET") headers["Content-Type"] = "application/json";
      if (process.env.MEAL_PLANNER_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.MEAL_PLANNER_ACCESS_TOKEN}`;
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(65000),
      });
      res.status(upstream.status).set("Cache-Control", "no-store").type(upstream.headers.get("content-type") || "application/octet-stream");
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      return res.status(503).json({ error: `Macro Planner unavailable: ${err.message}` });
    }
  });

  router.close = async () => {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
      timeout.unref();
    });
  };
  return router;
}
