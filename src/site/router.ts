// GET / and GET /privacy: the public pages. Both are fixed for the life of the process, so each is rendered once.

import { Router, type Response } from "express";
import { LANDING_SCRIPT, renderLanding, type LandingPage } from "./landing.js";
import { pageHeaders } from "./layout.js";
import { renderPrivacy, type PrivacyPage } from "./privacy.js";

export type SiteDeps = LandingPage & PrivacyPage;

export function siteRouter(deps: SiteDeps): Router {
  const router = Router();
  const landing = renderLanding(deps);
  const privacy = renderPrivacy(deps);

  router.get("/", (_req, res) => send(res, landing, LANDING_SCRIPT));
  router.get("/privacy", (_req, res) => send(res, privacy));

  return router;
}

function send(res: Response, html: string, script?: string) {
  res.set(pageHeaders(script)).type("html").send(html);
}
