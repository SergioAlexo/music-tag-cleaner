import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LyricsOutputPage } from "./pages/LyricsOutputPage";
import "./styles.css";

// The lyrics output window is the same bundle opened with ?view=lyrics-out
// (created by commands/lyrics_output.rs): it renders only its own page.
const isLyricsOutput = new URLSearchParams(window.location.search).get("view") === "lyrics-out";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary backLabel="Reload" onBack={() => window.location.reload()}>
      {isLyricsOutput ? <LyricsOutputPage /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
