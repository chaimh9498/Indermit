import { useEffect, useMemo, useState } from "react";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import {
  ArrowRight,
  Check,
  Coins,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Menu,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { apiRequest } from "./api";

const MODELS = [
  {
    id: "openai-sunburst",
    provider: "OpenAI",
    name: "Sunburst",
    description: "Precise composition, detail, and typography.",
    credits: 70,
    accent: "mint",
    badge: "Best quality",
  },
  {
    id: "google-nano-banana",
    provider: "Google",
    name: "Nano Banana 2",
    description: "Fast generation with excellent prompt understanding.",
    credits: 50,
    accent: "blue",
    badge: "Balanced",
  },
  {
    id: "xai-imagine",
    provider: "xAI",
    name: "Imagine",
    description: "Bold, high-speed creative image generation.",
    credits: 40,
    accent: "violet",
    badge: "Fastest",
  },
];

const ASPECTS = [
  { value: "1:1", label: "Square", shape: "square" },
  { value: "16:9", label: "Landscape", shape: "landscape" },
  { value: "9:16", label: "Portrait", shape: "portrait" },
];

const PACKAGES = [
  { id: "starter", credits: 500, price: 5, label: "Starter" },
  { id: "creator", credits: 1650, price: 15, label: "Creator", popular: true },
  { id: "pro", credits: 4600, price: 40, label: "Pro" },
];

function App() {
  const { getToken } = useAuth();
  const [model, setModel] = useState(MODELS[0]);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [balance, setBalance] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [buyOpen, setBuyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const selectedAspect = useMemo(
    () => ASPECTS.find((item) => item.value === aspect),
    [aspect],
  );

  async function loadAccount() {
    try {
      const [account, images] = await Promise.all([
        apiRequest("/v1/account", getToken),
        apiRequest("/v1/generations", getToken),
      ]);
      setBalance(account.creditBalance);
      setHistory(images.generations || []);
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      setMessage("Payment received. Your credits will appear in a moment.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function generate() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await apiRequest("/v1/generations", getToken, {
        method: "POST",
        body: JSON.stringify({ model: model.id, prompt: prompt.trim(), aspectRatio: aspect }),
      });
      setBalance(result.creditBalance);
      setHistory((current) => [result.generation, ...current]);
    } catch (error) {
      setMessage(error.message);
      if (error.message.toLowerCase().includes("credit")) setBuyOpen(true);
    } finally {
      setLoading(false);
    }
  }

  async function buyCredits(bundleId) {
    setMessage("");
    try {
      const result = await apiRequest("/v1/billing/checkout", getToken, {
        method: "POST",
        body: JSON.stringify({ bundleId }),
      });
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="app-shell">
      <div className="noise" />
      <Header
        balance={balance}
        onBuy={() => setBuyOpen(true)}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        loadAccount={loadAccount}
      />

      <main>
        <section className="hero">
          <div className="eyebrow"><Sparkles size={14} /> The world's best image models, one canvas</div>
          <h1>Imagine it.<br /><span>Choose who creates it.</span></h1>
          <p className="hero-copy">One prompt. Multiple creative engines. Pick the model that fits your idea and turn words into exceptional images.</p>
          <div className="trust-row">
            <span><span className="provider-dot openai" /> OpenAI</span>
            <span><span className="provider-dot google" /> Google</span>
            <span><span className="provider-dot xai" /> xAI</span>
          </div>
        </section>

        <section className="studio" id="create">
          <div className="studio-heading">
            <div>
              <span className="section-kicker">01 · MODEL</span>
              <h2>Choose your creative engine</h2>
            </div>
            <span className="tiny-note">Switch anytime</span>
          </div>

          <div className="model-grid">
            {MODELS.map((item) => (
              <button
                className={`model-card ${item.accent} ${model.id === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => setModel(item)}
              >
                <div className="model-top">
                  <ProviderMark provider={item.provider} />
                  <span className="model-badge">{item.badge}</span>
                </div>
                <p className="provider-name">{item.provider}</p>
                <h3>{item.name}</h3>
                <p className="model-description">{item.description}</p>
                <div className="model-bottom">
                  <span><Coins size={14} /> {item.credits} credits</span>
                  <span className="select-check">{model.id === item.id ? <Check size={15} /> : <ArrowRight size={15} />}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="composer">
            <div className="composer-meta">
              <span className="section-kicker">02 · PROMPT</span>
              <span>{prompt.length}/1200</span>
            </div>
            <textarea
              maxLength={1200}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the image you want to create…"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") generate();
              }}
            />
            <div className="composer-footer">
              <div className="aspect-picker">
                {ASPECTS.map((item) => (
                  <button
                    key={item.value}
                    className={aspect === item.value ? "active" : ""}
                    onClick={() => setAspect(item.value)}
                    title={item.label}
                  >
                    <span className={`aspect-icon ${item.shape}`} /> {item.value}
                  </button>
                ))}
              </div>
              <SignedIn>
                <button className="generate-button" onClick={generate} disabled={!prompt.trim() || loading}>
                  {loading ? <LoaderCircle className="spin" size={18} /> : <WandSparkles size={18} />}
                  {loading ? "Creating…" : `Generate · ${model.credits}`}
                </button>
              </SignedIn>
              <SignedOut>
                <SignUpButton mode="modal">
                  <button className="generate-button"><WandSparkles size={18} /> Sign up to create</button>
                </SignUpButton>
              </SignedOut>
            </div>
          </div>

          {message && <div className="notice">{message}</div>}
          <p className="keyboard-hint">{selectedAspect.label} output · Press ⌘ Enter to generate</p>
        </section>

        <SignedIn>
          <Gallery history={history} loadAccount={loadAccount} />
        </SignedIn>

        <section className="value-strip">
          <div><Zap size={20} /><span><strong>One balance</strong> across every model</span></div>
          <div><ImageIcon size={20} /><span><strong>Your gallery</strong> saved automatically</span></div>
          <div><Sparkles size={20} /><span><strong>No subscriptions</strong> pay only when you create</span></div>
        </section>
      </main>

      <footer>
        <a className="brand" href="/"><BrandMark /> indermit</a>
        <p>One place to create with the models you trust.</p>
        <div><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="mailto:support@indermit.com">Support</a></div>
      </footer>

      {buyOpen && <CreditModal onClose={() => setBuyOpen(false)} onBuy={buyCredits} />}
    </div>
  );
}

function Header({ balance, onBuy, menuOpen, setMenuOpen, loadAccount }) {
  return (
    <header>
      <a className="brand" href="/"><BrandMark /> indermit</a>
      <nav className={menuOpen ? "open" : ""}>
        <a href="#create" onClick={() => setMenuOpen(false)}>Create</a>
        <SignedIn><button className="nav-link" onClick={() => { loadAccount(); setMenuOpen(false); }}>My images</button></SignedIn>
        <a href="#pricing" onClick={() => { onBuy(); setMenuOpen(false); }}>Pricing</a>
      </nav>
      <div className="header-actions">
        <SignedIn>
          <button className="balance-pill" onClick={onBuy}><Coins size={15} /> {balance ?? "—"} <span>credits</span></button>
          <UserButton />
        </SignedIn>
        <SignedOut>
          <SignInButton mode="modal"><button className="text-button">Sign in</button></SignInButton>
          <SignUpButton mode="modal"><button className="primary-small">Start creating</button></SignUpButton>
        </SignedOut>
        <button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
          {menuOpen ? <X /> : <Menu />}
        </button>
      </div>
    </header>
  );
}

function Gallery({ history, loadAccount }) {
  useEffect(() => { loadAccount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!history.length) return null;
  return (
    <section className="gallery">
      <span className="section-kicker">YOUR CREATIONS</span>
      <div className="gallery-title"><h2>Recent images</h2><span>{history.length} saved</span></div>
      <div className="gallery-grid">
        {history.map((item) => (
          <article className="gallery-item" key={item.id}>
            <img src={item.imageUrl} alt={item.prompt} loading="lazy" />
            <div className="gallery-overlay">
              <div><strong>{item.provider}</strong><p>{item.prompt}</p></div>
              <a href={item.downloadUrl} aria-label="Download"><Download size={18} /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CreditModal({ onClose, onBuy }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" id="pricing" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X /></button>
        <span className="section-kicker">CREDITS</span>
        <h2>Fund your next idea</h2>
        <p>Credits never expire. Use them with any available model.</p>
        <div className="package-grid">
          {PACKAGES.map((item) => (
            <button className={`package ${item.popular ? "popular" : ""}`} key={item.id} onClick={() => onBuy(item.id)}>
              {item.popular && <span className="popular-label">MOST POPULAR</span>}
              <strong>{item.label}</strong>
              <span className="package-price">${item.price}</span>
              <span>{item.credits.toLocaleString()} credits</span>
              <small>{Math.floor(item.credits / 50)}+ standard creations</small>
            </button>
          ))}
        </div>
        <div className="secure-note"><Check size={16} /> Secure checkout powered by Stripe</div>
      </div>
    </div>
  );
}

function BrandMark() {
  return <span className="brand-mark"><span /><span /><span /></span>;
}

function ProviderMark({ provider }) {
  return <span className={`provider-mark ${provider.toLowerCase()}`}>{provider === "OpenAI" ? "◎" : provider === "Google" ? "G" : "𝕏"}</span>;
}

export default App;
