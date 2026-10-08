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
        <span>Accounts are open. Image generation is temporarily paused.</span>
      </div>

      <header className="site-header">
        <a className="brand" href="/" aria-label="Indermit home">
          <img src="/indermit-mark.webp" alt="" />
          <span>indermit</span>
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
            <div className="status-pill"><Sparkles size={14} /> The unified AI image studio</div>
            <h1>AI image generation.<br /><span>All in one place.</span></h1>
            <p>
              Indermit brings leading AI image generators into one simple studio,
              so you can choose the right model without switching between apps.
            </p>

            <div className="hero-actions">
              <SignedOut>
                <SignUpButton mode="modal">
                  <button className="button button-primary button-large">
                    Create your Indermit account <ArrowUpRight size={18} />
                  </button>
                </SignUpButton>
                <span>Account creation is available now.</span>
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

        <section className="studio-preview" aria-labelledby="studio-title">
          <div className="studio-topline">
            <div>
              <span className="section-label">INDERMIT STUDIO</span>
              <h2 id="studio-title">Create from one canvas.</h2>
            </div>
            <span className="paused-badge"><LockKeyhole size={13} /> Generation paused</span>
          </div>

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

          <div className="availability-note">
            <span>01</span>
            <p><strong>Accounts are open now.</strong> Generation access will return in stages as we finish the beta safeguards and launch setup.</p>
          </div>
        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="/">
          <img src="/indermit-mark.webp" alt="" />
          <span>indermit</span>
        </a>
        <p>AI image generation, brought together.</p>
        <nav aria-label="Legal and support">
          <a href="/terms.html">Terms</a>
          <a href="/privacy.html">Privacy</a>
          <a href="mailto:support@indermit.com">Support</a>
        </nav>
      </footer>
    </div>
  );
}

export default App;
