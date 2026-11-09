import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { BindingPage } from "./BindingPage";
import { EuropeBindingPage } from "./EuropeBindingPage";

const europe = new URLSearchParams(window.location.search).get('preparationMode') === 'vic-v2-europe';

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {europe ? <EuropeBindingPage /> : <BindingPage />}
  </StrictMode>,
);
