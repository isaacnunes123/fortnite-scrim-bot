import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ClosedPage } from "./ClosedPage";
import { HomePage } from "./HomePage";
import { PlayerMap } from "./PlayerMap";
import { PublicBoards } from "./PublicBoards";
import "./styles.css";

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const isMap = path.startsWith("/mapa/");
const isBoards = path === "/tabelas" || path.startsWith("/tabelas/");
const isClosed = path === "/closed";
const isStaff =
  path === "/painel" ||
  path === "/staff" ||
  path.startsWith("/painel/") ||
  path.startsWith("/staff/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isMap ? (
      <PlayerMap />
    ) : isBoards ? (
      <PublicBoards />
    ) : isClosed ? (
      <ClosedPage />
    ) : isStaff ? (
      <App />
    ) : (
      <HomePage />
    )}
  </StrictMode>,
);
