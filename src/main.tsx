import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./index.css";

// Explicit opt-in until a separate Open V4 deployment has been verified.
// Never use a legacy token address as an implicit V4 fallback.
const mode = import.meta.env.VITE_MINING_PROTOCOL ?? "legacy";
const App = lazy(() => mode === "v4" ? import("./V4App") : import("./App"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ background: "#0b0f17", color: "#c3a3ef", minHeight: "100dvh", padding: "2rem" }}>Loading MineCast…</div>}>
      {mode === "legacy" || mode === "v4" ? <App /> : <p>Unknown mining protocol configuration.</p>}
    </Suspense>
  </React.StrictMode>
);
