import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PlayerMap } from "./PlayerMap";
import "./styles.css";

const isMap = window.location.pathname.startsWith("/mapa/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isMap ? <PlayerMap /> : <App />}</StrictMode>,
);
