import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import { API_URL } from "./api";
import "./styles.css";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

function Root() {
  const [signupBonusAvailable, setSignupBonusAvailable] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const checkOffer = async () => {
      try {
        const response = await fetch(`${API_URL}/v1/promotions/signup-bonus`);
        const offer = await response.json();
        if (active) setSignupBonusAvailable(response.ok && offer.available === true);
      } catch {
        if (active) setSignupBonusAvailable(false);
      }
    };
    checkOffer();
    const timer = window.setInterval(checkOffer, 15000);
    const refreshOffer = () => { if (document.visibilityState === "visible") checkOffer(); };
    document.addEventListener("visibilitychange", refreshOffer);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOffer);
    };
  }, []);

  if (!clerkKey) return <SetupPage />;
  const localization = signupBonusAvailable ? {
    signUp: {
      start: {
        title: "Sign up to receive 2 free credits",
        subtitle: "Available during the limited launch offer.",
      },
    },
  } : undefined;
  return <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/" localization={localization}><App /></ClerkProvider>;
}

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
