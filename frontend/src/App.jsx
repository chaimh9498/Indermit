import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/clerk-react";
import { ArrowUpRight, ChevronDown, LockKeyhole, Sparkles } from "lucide-react";

const MODELS = [
  "Auto · Indermit selects the best model",
  "Google · Gemini Image",
  "OpenAI · Image generation",
  "xAI · Imagine",
];

function App() {
  return (
    <div className="site-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <div className="beta-bar">
        <span className="beta-dot" />
        INDERMIT IS IN BETA
        <span>Account creation is open. Image generation is coming soon.</span>
      </div>

      <header className="site-header">
        <a className="brand" href="/" aria-label="Indermit home">
          <img src="/indermit-mark.webp" alt="" />
          <BrandWordmark />
        </a>

        <div className="header-actions">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="button button-quiet">Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="button button-primary">Create account</button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <span className="account-label">Account active</span>
            <UserButton />
          </SignedIn>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <h1>AI image generation.<br /><span>All in one place.</span></h1>
            <p>
              Indermit brings leading AI image generators into one simple platform.
              Buy credits once and use them across every available model—without
              juggling separate apps, subscriptions, or accounts.
            </p>

            <div className="hero-actions">
              <SignedOut>
                <SignUpButton mode="modal">
                  <button className="button button-primary button-large">
                    Create your Indermit account <ArrowUpRight size={18} />
                  </button>
                </SignUpButton>
              </SignedOut>
              <SignedIn>
                <div className="signed-in-message">
                  <span className="check">✓</span>
                  Your account is ready for the beta rollout.
                </div>
              </SignedIn>
            </div>
          </div>

        </section>

        <section className="studio-preview" aria-label="Indermit Studio">
          <div className="composer">
            <textarea
              disabled
              aria-label="Image prompt"
              placeholder="Describe the image you want to create…"
            />
            <div className="composer-footer">
              <label className="model-menu">
                <span className="model-icon"><Sparkles size={15} /></span>
                <span className="model-copy">
                  <small>Model</small>
                  <strong>Select a model</strong>
                </span>
                <select defaultValue="" aria-label="Image models">
                  <option value="">Select a model</option>
                  {MODELS.map((model) => (
                    <option value={model} key={model} disabled>{model} · Unavailable during beta</option>
                  ))}
                </select>
                <ChevronDown size={16} />
              </label>
              <button className="generate-button" disabled>
                <LockKeyhole size={16} /> Generate
              </button>
            </div>
          </div>

        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="/" aria-label="Indermit home">
          <img src="/indermit-mark.webp" alt="" />
          <BrandWordmark />
        </a>
        <nav aria-label="Legal and support">
          <a href="/terms.html">Terms</a>
          <a href="/privacy.html">Privacy</a>
          <a href="mailto:support@indermit.com">Support</a>
        </nav>
      </footer>
    </div>
  );
}

function BrandWordmark() {
  return (
    <span className="brand-wordmark" aria-hidden="true">
      <svg className="wordmark-i" viewBox="0 0 24 32" focusable="false">
        <path d="M4 0H24V32H4C1.8 32 0 30.2 0 28V26H17V6H0V4C0 1.8 1.8 0 4 0Z" />
      </svg>
      <span className="wordmark-middle">NDERMI</span><span className="wordmark-t">T</span>
    </span>
  );
}

export default App;
