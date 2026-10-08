import { useCallback, useEffect, useState } from "react";
import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton, useAuth } from "@clerk/clerk-react";
import { ArrowRight, ChevronDown, CreditCard, Gauge, Image as ImageIcon, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, Send, Sparkles, Users } from "lucide-react";
import { apiRequest } from "./api";

const MODELS = [
  { id: "auto", name: "Auto", provider: "Indermit", credits: 2, enabled: true },
  { id: "google-nano-banana", name: "Nano Banana 2 Lite", provider: "Google", credits: 2, enabled: true },
  { id: "openai-sunburst", name: "GPT Image 2.5 Sunburst", provider: "OpenAI", credits: 1, enabled: false },
  { id: "xai-imagine", name: "Grok Imagine 2.0", provider: "xAI", credits: 2, enabled: true },
];

const BUNDLES = [
  { id: "starter", name: "Starter", credits: 100, price: "$5" },
  { id: "creator", name: "Creator", credits: 330, price: "$15" },
  { id: "pro", name: "Pro", credits: 920, price: "$40" },
];

function App() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [beta, setBeta] = useState({ loading: true, enrolled: false, role: null, stripeReady: false, stripeMode: "live" });
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem("indermit-beta-code") || "");
  const [accessError, setAccessError] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);

  const checkMembership = useCallback(async () => {
    if (!isLoaded || !isSignedIn) {
      setBeta({ loading: false, enrolled: false, role: null, stripeReady: false, stripeMode: "live" });
      return;
    }
    try {
      const result = await apiRequest("/v1/beta/me", getToken);
      setBeta({ loading: false, ...result });
    } catch (error) {
      setBeta({ loading: false, enrolled: false, role: null, stripeReady: false, stripeMode: "live" });
      setAccessError(error.message);
    }
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => { checkMembership(); }, [checkMembership]);

  async function activateBeta(event) {
    event.preventDefault();
    const code = accessCode.trim();
    if (!code) return setAccessError("Enter your private beta access key.");
    sessionStorage.setItem("indermit-beta-code", code);
    if (!isSignedIn) return setAccessError("Access key saved. Sign in or create an account to activate it.");
    setAccessBusy(true);
    setAccessError("");
    try {
      const result = await apiRequest("/v1/beta/enroll", getToken, { method: "POST", body: JSON.stringify({ code }) });
      setBeta((current) => ({ ...current, ...result, loading: false }));
      sessionStorage.removeItem("indermit-beta-code");
      setAccessOpen(false);
    } catch (error) {
      setAccessError(error.message);
    } finally {
      setAccessBusy(false);
    }
  }

  if (beta.enrolled) return <Studio getToken={getToken} beta={beta} />;

  return <Landing accessCode={accessCode} accessError={accessError} accessOpen={accessOpen} accessBusy={accessBusy} betaLoading={beta.loading} isSignedIn={isSignedIn} onAccessCode={setAccessCode} onAccessOpen={setAccessOpen} onActivate={activateBeta} />;
}

function Landing(props) {
  return (
    <div className="site-shell">
      <div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" />
      <BetaBar /><Header onAccess={() => props.onAccessOpen(true)} />
      <main>
        <section className="hero"><div className="hero-copy">
          <div className="status-pill"><LockKeyhole size={13} /> PRIVATE BETA</div>
          <h1>AI image generation.<br /><span>All in one place.</span></h1>
          <p>Indermit brings leading AI image generators into one simple platform. Buy credits once and use them across every available model without needing to handle separate apps, subscriptions, or accounts.</p>
          <button className="button button-primary button-large" onClick={() => props.onAccessOpen(true)}>Enter private beta <ArrowRight size={16} /></button>
        </div></section>
        <section className="studio-preview" aria-label="Indermit Studio preview"><Composer /></section>
      </main>
      <SiteFooter />
      {props.accessOpen && <div className="modal-backdrop" onMouseDown={() => props.onAccessOpen(false)}><section className="access-card" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => props.onAccessOpen(false)} aria-label="Close">×</button>
        <div className="access-icon"><KeyRound size={22} /></div><span className="section-label">INVITE ONLY</span><h2>Enter the private beta</h2>
        <p>Use the access key provided by Indermit. Your account will remember beta access after activation.</p>
        <form onSubmit={props.onActivate}><label htmlFor="beta-key">Beta access key</label><input id="beta-key" type="password" autoComplete="one-time-code" value={props.accessCode} onChange={(event) => props.onAccessCode(event.target.value)} placeholder="Enter access key" />
          {props.accessError && <p className="form-message">{props.accessError}</p>}
          <button className="button button-primary access-submit" disabled={props.accessBusy || props.betaLoading}>{props.accessBusy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={16} />}{props.isSignedIn ? "Activate beta access" : "Save key and continue"}</button>
        </form>
        {!props.isSignedIn && <div className="access-auth"><span>Then sign in or create an account:</span><div><SignInButton mode="modal"><button className="button button-secondary">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="button button-secondary">Create account</button></SignUpButton></div></div>}
      </section></div>}
    </div>
  );
}

function Studio({ getToken, beta }) {
  const [view, setView] = useState("create");
  const [account, setAccount] = useState({ creditBalance: 0 });
  const [images, setImages] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("auto");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [busy, setBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [latestGeneration, setLatestGeneration] = useState(null);
  const [message, setMessage] = useState("");
  const [admin, setAdmin] = useState(null);
  const [members, setMembers] = useState([]);

  const loadAccount = useCallback(async () => setAccount(await apiRequest("/v1/account", getToken)), [getToken]);
  const loadImages = useCallback(async () => { const result = await apiRequest("/v1/generations", getToken); setImages(result.generations || []); }, [getToken]);
  const loadAdmin = useCallback(async () => {
    if (beta.role !== "admin") return;
    const [status, memberList] = await Promise.all([apiRequest("/v1/admin/status", getToken), apiRequest("/v1/admin/members", getToken)]);
    setAdmin(status); setMembers(memberList.members || []);
  }, [beta.role, getToken]);

  useEffect(() => { Promise.all([loadAccount(), loadImages(), loadAdmin()]).catch((error) => setMessage(error.message)); }, [loadAccount, loadAdmin, loadImages]);

  async function generate(event) {
    event.preventDefault();
    if (!prompt.trim()) return setMessage("Describe the image you want to create.");
    const submittedPrompt = prompt.trim();
    setBusy(true); setMessage(""); setGenerationProgress({ prompt: submittedPrompt, model: activeModel.name, status: "creating" });
    try {
      const result = await apiRequest("/v1/generations", getToken, { method: "POST", body: JSON.stringify({ prompt: submittedPrompt, model, aspectRatio }) });
      setAccount((current) => ({ ...current, creditBalance: result.creditBalance }));
      setImages((current) => [result.generation, ...current]);
      setLatestGeneration(result.generation);
      setGenerationProgress({ prompt: submittedPrompt, model: activeModel.name, status: "loading", imageUrl: result.generation.imageUrl });
      setPrompt("");
    } catch (error) {
      setGenerationProgress(null); setMessage(error.message);
    } finally { setBusy(false); }
  }

  async function checkout(bundleId) {
    setBusy(true); setMessage("");
    try { const result = await apiRequest("/v1/billing/checkout", getToken, { method: "POST", body: JSON.stringify({ bundleId }) }); window.location.assign(result.url); }
    catch (error) { setMessage(error.message); setBusy(false); }
  }

  async function adjustCredits(userId, amount) {
    setMessage("");
    try { await apiRequest("/v1/admin/credits", getToken, { method: "POST", body: JSON.stringify({ userId, amount }) }); await Promise.all([loadAccount(), loadAdmin()]); }
    catch (error) { setMessage(error.message); }
  }

  const activeModel = MODELS.find((item) => item.id === model);
  return <div className="app-shell"><BetaBar /><header className="app-header"><BrandWordmark /><nav className="app-nav">
    <button className={view === "create" ? "active" : ""} onClick={() => setView("create")}><Sparkles size={15} /> Create</button>
    <button className={view === "images" ? "active" : ""} onClick={() => setView("images")}><ImageIcon size={15} /> My images</button>
    <button className={view === "credits" ? "active" : ""} onClick={() => setView("credits")}><CreditCard size={15} /> Buy credits</button>
    {beta.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => { setView("admin"); loadAdmin(); }}><Gauge size={15} /> Owner</button>}
  </nav><div className="account-cluster"><span><strong>{account.creditBalance}</strong> credits</span><UserButton /></div></header>
  <main className="workspace">{message && <div className="notice-banner">{message}<button onClick={() => setMessage("")}>×</button></div>}
    {view === "create" && <section className="workspace-panel create-view"><div className="page-heading"><span>PRIVATE BETA STUDIO</span><h1>What do you want to create?</h1><p>Google Nano Banana 2 Lite is available now. Other models will be enabled as they are connected and tested.</p></div>
      <form className="live-composer" onSubmit={generate}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1200} placeholder="Describe the image you want to create…" /><div className="composer-controls">
        <label className="live-select"><span><small>Model</small><strong>{activeModel.provider} · {activeModel.name}</strong></span><select value={model} onChange={(event) => setModel(event.target.value)}>{MODELS.map((item) => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.provider} · {item.name}{!item.enabled ? " — Coming soon" : ` — ${item.credits} credits`}</option>)}</select><ChevronDown size={15} /></label>
        <label className="ratio-select"><span>Ratio</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>1:1</option><option>16:9</option><option>9:16</option></select></label>
        <button className="generate-live" disabled={busy || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={17} />} Generate · {activeModel.credits} credits</button>
      </div></form>
      {latestGeneration && <article className="inline-result" key={latestGeneration.id}>
        <div className="inline-result-image"><img src={latestGeneration.imageUrl} alt={latestGeneration.prompt} /></div>
        <div className="inline-result-details"><span>CREATED WITH {latestGeneration.provider.toUpperCase()}</span><h2>Your image is ready</h2><p>{latestGeneration.prompt}</p><div><a href={latestGeneration.downloadUrl}>Download image</a><button onClick={() => setLatestGeneration(null)}>Create another</button></div></div>
      </article>}
    </section>}
    {view === "images" && <section className="workspace-panel"><div className="page-heading compact"><span>YOUR LIBRARY</span><h1>My images</h1><button className="icon-button" onClick={loadImages}><RefreshCw size={15} /> Refresh</button></div>{images.length ? <div className="image-grid">{images.map((item) => <article className="image-card" key={item.id}><img src={item.imageUrl} alt={item.prompt} /><div><p>{item.prompt}</p><span>{item.provider} · {item.creditCost} credits</span><a href={item.downloadUrl}>Download</a></div></article>)}</div> : <EmptyState icon={<ImageIcon />} title="No images yet" text="Your private generations will appear here." />}</section>}
    {view === "credits" && <section className="workspace-panel"><div className="page-heading"><span>PRIVATE BETA CHECKOUT</span><h1>Buy Indermit credits</h1><p>These are real payments processed securely by Stripe. Credits are added to your account after payment succeeds.</p></div><div className="mode-card"><LockKeyhole size={18} /><div><strong>{beta.stripeReady ? "Secure checkout is connected" : "Checkout is being configured"}</strong><p>{beta.stripeReady ? "Only approved private-beta members can access these packages. Failed generations are automatically refunded to your credit balance." : "Purchasing stays disabled until the live Stripe key and webhook are both available."}</p></div></div><div className="bundle-grid">{BUNDLES.map((bundle) => <article key={bundle.id}><span>{bundle.name}</span><strong>{bundle.price}</strong><p>{bundle.credits} credits</p><button disabled={!beta.stripeReady || busy} onClick={() => checkout(bundle.id)}>Buy with Stripe</button></article>)}</div></section>}
    {view === "admin" && beta.role === "admin" && <AdminView data={admin} members={members} onAdjust={adjustCredits} onRefresh={loadAdmin} />}
  </main>
  {generationProgress && <div className="generation-overlay" role="dialog" aria-modal="true" aria-label="Creating your image"><div className="generation-progress-card">
    <div className="generation-visual"><div className="generation-glow" /><div className="generation-frame"><Sparkles size={31} /></div><div className="generation-ring"><span /></div></div>
    <span className="section-label">{generationProgress.status === "creating" ? "GENERATING" : "FINALIZING"}</span>
    <h2>{generationProgress.status === "creating" ? "Creating your image…" : "Your image is ready…"}</h2>
    <p>{generationProgress.status === "creating" ? `${generationProgress.model} is turning your prompt into an image.` : "Preparing the finished image in your studio."}</p>
    <div className="generation-prompt">“{generationProgress.prompt}”</div>
    <div className="generation-fade-bar"><span /></div>
    {generationProgress.imageUrl && <img className="generation-preloader" src={generationProgress.imageUrl} alt="" onLoad={() => setGenerationProgress(null)} onError={() => { setGenerationProgress(null); setMessage("The image was created, but the preview could not load. You can find it in My Images."); }} />}
  </div></div>}
  </div>;
}

function AdminView({ data, members, onAdjust, onRefresh }) {
  if (!data) return <div className="loading-state"><LoaderCircle className="spin" /> Loading owner dashboard…</div>;
  return <section className="workspace-panel admin-view"><div className="page-heading compact"><span>OWNER PORTAL</span><h1>Private beta operations</h1><button className="icon-button" onClick={onRefresh}><RefreshCw size={15} /> Refresh</button></div>
    <div className="metric-grid"><Metric label="Beta members" value={data.summary.betaMembers} icon={<Users />} /><Metric label="Generations" value={data.summary.generations} icon={<Sparkles />} /><Metric label="Completed" value={data.summary.completed} tone="good" /><Metric label="Failed" value={data.summary.failed} tone={data.summary.failed ? "bad" : "good"} /></div>
    <div className="admin-columns"><section className="admin-card"><h2>Model status</h2>{data.models.map((model) => <div className="status-row" key={model.id}><div><strong>{model.provider} · {model.name}</strong><span>{model.credits} credits per image</span></div><em className={model.enabled ? "online" : "offline"}>{model.enabled ? "Available" : "Coming soon"}</em></div>)}<div className="status-row"><div><strong>Stripe</strong><span>Webhook: {data.stripe.webhookReady ? "ready" : "not configured"}</span></div><em className={data.stripe.mode === "test" ? "online" : "offline"}>{data.stripe.mode}</em></div></section>
      <section className="admin-card"><h2>Beta members</h2>{members.map((member) => <div className="member-row" key={member.user_id}><div><strong>{member.user_id}</strong><span>{member.role} · {member.credit_balance} credits</span></div><div><button onClick={() => onAdjust(member.user_id, 10)}>+10</button><button onClick={() => onAdjust(member.user_id, 100)}>+100</button></div></div>)}</section></div>
    <section className="admin-card table-card"><h2>Recent generation activity</h2><div className="activity-table"><div className="activity-head"><span>User</span><span>Model</span><span>Status</span><span>Credits</span><span>Time</span></div>{data.recentGenerations.map((item) => <div className="activity-row" key={item.id}><span>{item.user_id}</span><span>{item.provider} · {item.model}</span><span className={`activity-status ${item.status}`}>{item.status}{item.error_code ? ` · ${item.error_code}` : ""}</span><span>{item.credit_cost}</span><span>{formatDate(item.created_at)}</span></div>)}</div></section>
  </section>;
}

function Metric({ label, value, icon, tone = "" }) { return <article className={`metric ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong></article>; }
function EmptyState({ icon, title, text }) { return <div className="empty-state">{icon}<h2>{title}</h2><p>{text}</p></div>; }
function formatDate(value) { return value ? new Date(`${value.replace(" ", "T")}Z`).toLocaleString() : "—"; }
function Composer() { return <div className="composer"><textarea disabled placeholder="Describe the image you want to create…" /><div className="composer-footer"><label className="model-menu"><span className="model-icon"><Sparkles size={15} /></span><span className="model-copy"><small>Model</small><strong>Select a model</strong></span><select disabled><option>Select a model</option></select><ChevronDown size={16} /></label><button className="generate-button" disabled><LockKeyhole size={16} /> Private beta</button></div></div>; }
function BetaBar() { return <div className="beta-bar"><span className="beta-dot" /> INDERMIT PRIVATE BETA <span>Access is limited to invited testers.</span></div>; }
function Header({ onAccess }) { return <header className="site-header"><a className="brand" href="/" aria-label="Indermit home"><BrandWordmark /></a><div className="header-actions"><SignedOut><SignInButton mode="modal"><button className="button button-quiet">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="button button-secondary">Create account</button></SignUpButton></SignedOut><SignedIn><UserButton /></SignedIn><button className="button button-primary" onClick={onAccess}>Beta access</button></div></header>; }
function SiteFooter() { return <footer><a className="brand footer-brand" href="/" aria-label="Indermit home"><BrandWordmark /></a><nav aria-label="Legal and support"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="mailto:support@indermit.com">Support</a></nav></footer>; }
function BrandWordmark() { return <img className="brand-wordmark" src="/indermit-wordmark-official.png" alt="Indermit" />; }

export default App;
