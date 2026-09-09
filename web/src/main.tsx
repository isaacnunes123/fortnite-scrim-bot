import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PlayerMap } from "./PlayerMap";
import { PublicBoards } from "./PublicBoards";
import "./styles.css";

const path = window.location.pathname;
const isMap = path.startsWith("/mapa/");
const isBoards = path === "/tabelas" || path.startsWith("/tabelas/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isMap ? <PlayerMap /> : isBoards ? <PublicBoards /> : <App />}
  </StrictMode>,
);
