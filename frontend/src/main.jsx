import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import "./styles.css";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {clerkKey ? (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    ) : (
      <SetupPage />
    )}
  </React.StrictMode>,
);

function SetupPage() {
  return (
    <div className="app-shell">
      <div className="noise" />
      <header>
        <a className="brand" href="/" aria-label="Indermit home">
          <span aria-hidden="true">&#10022;</span> indermit
        </a>
      </header>
      <main>
        <section className="hero">
          <div className="eyebrow">&#10022; The world&apos;s best image models, one canvas</div>
          <h1>Imagine it.<br /><span>Choose who creates it.</span></h1>
          <p className="hero-copy">
            One prompt. Multiple creative engines. Pick the model that fits your idea
            and turn words into exceptional images.
          </p>
          <div className="trust-row">
            <span><span className="provider-dot openai" /> OpenAI</span>
            <span><span className="provider-dot google" /> Google</span>
            <span><span className="provider-dot xai" /> xAI</span>
          </div>
        </section>
        <section className="studio">
          <div className="composer">
            <div className="composer-meta"><span className="section-kicker">INDERMIT STUDIO</span></div>
            <textarea disabled placeholder="Image creation will be available after sign-in is configured." />
            <div className="composer-footer">
              <p className="notice">The studio is online. Authentication setup is the remaining step.</p>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <a className="brand" href="/">indermit</a>
        <p>One place to create with the models you trust.</p>
        <div><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a></div>
      </footer>
    </div>
  );
}
