// GET /privacy: the public pages. Both are fixed for the life of the process, so each is rendered once.

import { Router, type Response } from "express";
import { pageHeaders } from "./layout.js";
import { renderPrivacy, type PrivacyPage } from "./privacy.js";

export type SiteDeps = PrivacyPage;

export function siteRouter(deps: SiteDeps): Router {
  const router = Router();
  const privacy = renderPrivacy(deps);

  router.get("/privacy", (_req, res) => send(res, privacy));

  return router;
}

function send(res: Response, html: string, script?: string) {
  res.set(pageHeaders(script)).type("html").send(html);
}
