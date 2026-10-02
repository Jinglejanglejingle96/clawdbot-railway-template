import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createMacroPlannerRouter } from "../src/macro-planner/index.js";

const fakePlanner = `from http.server import HTTPServer, BaseHTTPRequestHandler
import json, sys
class Handler(BaseHTTPRequestHandler):
 def respond(self, content, kind='application/json'):
  body = content.encode()
  self.send_response(200)
  self.send_header('Content-Type', kind)
  self.send_header('Content-Length', str(len(body)))
  self.end_headers()
  self.wfile.write(body)
 def do_GET(self):
  self.respond('{"date":"2026-10-02"}' if self.path.startswith('/api/') else '<h1>Macro Planner</h1>', 'application/json' if self.path.startswith('/api/') else 'text/html')
 def do_POST(self):
  body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
  self.respond(body)
HTTPServer(('127.0.0.1', int(sys.argv[-1])), Handler).serve_forever()
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("private phone link opens /macros and proxies API without exposing Python", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-macros-"));
  const workspaceDir = path.join(temp, "workspace");
  const stateDir = path.join(temp, "state");
  const pkg = path.join(workspaceDir, "scripts", "meal_planner");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "__init__.py"), "");
  fs.writeFileSync(path.join(pkg, "server.py"), fakePlanner);
  const previous = process.env.RAILWAY_PUBLIC_DOMAIN;
  process.env.RAILWAY_PUBLIC_DOMAIN = "jeeves.example.test";
  const router = createMacroPlannerRouter({ workspaceDir, stateDir, setupPassword: "password", port: await freePort(),
    pythonCommand: "python3" });
  const app = express();
  app.use("/macros", express.json({ limit: "4mb" }), router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const link = fs.readFileSync(path.join(workspaceDir, "data", "coach", "meal_planner_link.txt"), "utf8").trim();
    assert.equal(new URL(link).pathname, "/macros");
    assert.equal((await fetch(`${base}/macros/`)).status, 401);
    const entry = await fetch(`${base}/macros?k=${new URL(link).searchParams.get("k")}`, { redirect: "manual" });
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.get("location"), "/macros/");
    const cookie = entry.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^jm_key=/);
    assert.equal((await fetch(`${base}/macros/?k=${new URL(link).searchParams.get("k")}`, { redirect: "manual" })).headers.get("location"), "/macros/");
    const page = await fetch(`${base}/macros/`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Macro Planner/);
    const dashboard = await fetch(`${base}/macros/api/today`, { headers: { Cookie: cookie } });
    assert.deepEqual(await dashboard.json(), { date: "2026-10-02" });
    const meal = await fetch(`${base}/macros/api/meals`, { method: "POST",
      headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lunch" }) });
    assert.deepEqual(await meal.json(), { name: "Lunch" });
    const crossSite = await fetch(`${base}/macros/api/meals`, { method: "POST",
      headers: { Cookie: cookie, Origin: "https://elsewhere.test", "Content-Type": "application/json" },
      body: "{}" });
    assert.equal(crossSite.status, 403);
  } finally {
    await router.close();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
    else process.env.RAILWAY_PUBLIC_DOMAIN = previous;
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
