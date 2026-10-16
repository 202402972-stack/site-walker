import React from "react";
import { createRoot } from "react-dom/client";
import { Console } from "./console.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/archivo";
import "./tokens.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<main><Console /></main>);
