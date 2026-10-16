import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { Landing } from "./landing.js";
import type { Limits, SampleRun } from "./shared.js";
import sample from "./sample.json";
import "@fontsource-variable/inter";
import "@fontsource-variable/archivo";
import "./tokens.css";

declare global {
  interface Window {
    __SW_CONFIG__?: Limits;
  }
}

function config(): Limits {
  if (typeof window !== "undefined" && window.__SW_CONFIG__) return window.__SW_CONFIG__;
  const el = typeof document !== "undefined" ? document.getElementById("sw-config") : null;
  if (el?.textContent) return JSON.parse(el.textContent) as Limits;
  throw new Error("Site Walker configuration missing from page.");
}

const root = document.getElementById("root");
if (root) {
  const props = { limits: config(), sample: sample as SampleRun };
  if (root.hasChildNodes()) hydrateRoot(root, <Landing {...props} />);
  else createRoot(root).render(<Landing {...props} />);
}
