import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { CollectEntry } from "./MockCollectPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CollectEntry />
  </StrictMode>,
);
