import { useCallback, useEffect, useState } from "react";
import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton, useAuth } from "@clerk/clerk-react";
import { ArrowRight, ChevronDown, CreditCard, Gauge, Image as ImageIcon, KeyRound, LoaderCircle, LockKeyhole, Paperclip, RefreshCw, Send, Sparkles, Users, X } from "lucide-react";
import { apiRequest } from "./api";

const MODELS = [
  { id: "auto", name: "Auto", provider: "Indermit", credits: 2, enabled: true },
  { id: "google-nano-banana", name: "Nano Banana 2 Lite", provider: "Google", credits: 2, enabled: true },
  { id: "openai-sunburst", name: "GPT Image 2.5 Sunburst Low", provider: "OpenAI", credits: 1, enabled: true },
  { id: "xai-imagine", name: "Grok Imagine 2.0 Low", provider: "xAI", credits: 2, enabled: true },
];

const BUNDLES = [
  { id: "starter", name: "Starter", credits: 100, price: "$5" },
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
    if (!isSignedIn) return setAccessError("Create an account or sign in to join the public beta.");
    setAccessBusy(true);
    setAccessError("");
    try {
      const result = await apiRequest("/v1/beta/enroll", getToken, { method: "POST", body: JSON.stringify({}) });
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
          <h1>AI image generation.<br /><span>All in one place.</span></h1>
          <p>Indermit brings leading AI image generators into one simple platform. Buy credits once and use them across every available model without needing to handle separate apps, subscriptions, or accounts.</p>
          <section className="studio-preview" aria-label="Indermit Studio preview"><Composer isSignedIn={props.isSignedIn} onActivate={props.onActivate} /></section>
        </div></section>
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
  const [sourceImage, setSourceImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [latestGeneration, setLatestGeneration] = useState(null);
  const [message, setMessage] = useState("");
  const [admin, setAdmin] = useState(null);
  const [members, setMembers] = useState([]);
  const [adminRefreshing, setAdminRefreshing] = useState(false);
  const [adminUpdatedAt, setAdminUpdatedAt] = useState(null);

  const loadAccount = useCallback(async () => setAccount(await apiRequest("/v1/account", getToken)), [getToken]);
  const loadImages = useCallback(async () => { const result = await apiRequest("/v1/generations", getToken); setImages(result.generations || []); }, [getToken]);
  const loadAdmin = useCallback(async () => {
    if (beta.role !== "admin") return;
    const [status, memberList] = await Promise.all([apiRequest("/v1/admin/status", getToken), apiRequest("/v1/admin/members", getToken)]);
    setAdmin(status); setMembers(memberList.members || []); setAdminUpdatedAt(new Date().toISOString());
  }, [beta.role, getToken]);

  useEffect(() => { Promise.all([loadAccount(), loadImages(), loadAdmin()]).catch((error) => setMessage(error.message)); }, [loadAccount, loadAdmin, loadImages]);

  async function generate(event) {
    event.preventDefault();
    if (!prompt.trim()) return setMessage("Describe the image you want to create.");
    const submittedPrompt = prompt.trim();
    const operationType = sourceImage ? "edit" : "generation";
    setBusy(true); setMessage(""); setGenerationProgress({ prompt: submittedPrompt, model: activeModel.name, operationType, status: "creating" });
    try {
      const result = await apiRequest("/v1/generations", getToken, {
        method: "POST",
        body: JSON.stringify({
          prompt: submittedPrompt,
          model,
          aspectRatio,
          inputImage: sourceImage?.base64 ? { mimeType: sourceImage.mimeType, data: sourceImage.base64 } : undefined,
          sourceGenerationId: sourceImage?.generationId,
        }),
      });
      setAccount((current) => ({ ...current, creditBalance: result.creditBalance }));
      setImages((current) => [result.generation, ...current]);
      setLatestGeneration(result.generation);
      setGenerationProgress({ prompt: submittedPrompt, model: activeModel.name, operationType, status: "loading", imageUrl: result.generation.imageUrl });
      setPrompt("");
      setSourceImage(null);
    } catch (error) {
      setGenerationProgress(null); setMessage(error.message);
    } finally { setBusy(false); }
  }

  function chooseSourceImage(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setMessage("Upload a PNG, JPEG, or WebP image.");
    if (file.size > 5 * 1024 * 1024) return setMessage("Uploaded images must be 5 MB or smaller.");
    const reader = new FileReader();
    reader.onerror = () => setMessage("The image could not be read.");
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      if (!base64) return setMessage("The image could not be read.");
      setMessage("");
      setSourceImage({ name: file.name, mimeType: file.type, base64, previewUrl: dataUrl, size: file.size });
    };
    reader.readAsDataURL(file);
  }

  function editGeneratedImage(item) {
    setView("create");
    setLatestGeneration(null);
    setPrompt("");
    setModel(MODELS.some((candidate) => candidate.id === item.model && candidate.enabled) ? item.model : "auto");
    setAspectRatio(["1:1", "16:9", "9:16"].includes(item.aspectRatio) ? item.aspectRatio : "1:1");
    setSourceImage({ generationId: item.id, previewUrl: item.imageUrl, name: "Indermit image" });
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
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

  async function refreshAdmin() {
    if (adminRefreshing) return;
    setAdminRefreshing(true); setMessage("");
    try { await loadAdmin(); }
    catch (error) { setMessage(error.message); }
    finally { setAdminRefreshing(false); }
  }

  const activeModel = MODELS.find((item) => item.id === model);
  return <div className="app-shell"><BetaBar /><header className="app-header"><BrandWordmark /><nav className="app-nav">
    <button className={view === "create" ? "active" : ""} onClick={() => setView("create")}><Sparkles size={15} /> Create</button>
    <button className={view === "images" ? "active" : ""} onClick={() => setView("images")}><ImageIcon size={15} /> My images</button>
    <button className={view === "credits" ? "active" : ""} onClick={() => setView("credits")}><CreditCard size={15} /> Buy credits</button>
    {beta.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => { setView("admin"); refreshAdmin(); }}><Gauge size={15} /> Owner</button>}
  </nav><div className="account-cluster"><span><strong>{account.creditBalance}</strong> credits</span><UserButton /></div></header>
  <main className="workspace">{message && <div className="notice-banner">{message}<button onClick={() => setMessage("")}>×</button></div>}
    {view === "create" && <section className="workspace-panel create-view"><div className="page-heading"><span>PUBLIC BETA STUDIO</span><h1>What do you want to create?</h1><p>Google Nano Banana 2 Lite, Grok Imagine 2.0 Low, and GPT Image 2.5 Sunburst Low are available now.</p></div>
      <form className="live-composer" onSubmit={generate}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1200} placeholder={sourceImage ? "Describe how you want to edit this image…" : "Describe the image you want to create…"} />
        {sourceImage && <div className="source-image-preview"><img src={sourceImage.previewUrl} alt="Image selected for editing" /><div><strong>Editing this image</strong><span>{sourceImage.generationId ? "Generated with Indermit" : `${sourceImage.name} · ${(sourceImage.size / 1024 / 1024).toFixed(2)} MB`}</span></div><button type="button" onClick={() => setSourceImage(null)} aria-label="Remove selected image"><X size={15} /></button></div>}
        <div className="composer-controls">
        <label className="upload-control"><Paperclip size={16} /><span>{sourceImage ? "Change" : "Upload"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseSourceImage} /></label>
        <label className="live-select"><span><small>Model</small><strong>{activeModel.provider} · {activeModel.name}</strong></span><select value={model} onChange={(event) => setModel(event.target.value)}>{MODELS.map((item) => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.provider} · {item.name}{!item.enabled ? " — Coming soon" : ` — ${item.credits} credits`}</option>)}</select><ChevronDown size={15} /></label>
        <label className="ratio-select"><span>Ratio</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>1:1</option><option>16:9</option><option>9:16</option></select></label>
        <button className="generate-live" disabled={busy || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={17} />} {sourceImage ? "Edit" : "Generate"} · {activeModel.credits} credits</button>
      </div></form>
      {latestGeneration && <article className="inline-result" key={latestGeneration.id}>
        <div className="inline-result-image"><img src={latestGeneration.imageUrl} alt={latestGeneration.prompt} /></div>
        <div className="inline-result-details"><span>{latestGeneration.operationType === "edit" ? "EDITED" : "CREATED"} WITH {latestGeneration.provider.toUpperCase()}</span><h2>Your image is ready</h2><p>{latestGeneration.prompt}</p><div><a href={latestGeneration.downloadUrl}>Download image</a><button className="edit-result-button" onClick={() => editGeneratedImage(latestGeneration)}>Edit this image</button><button onClick={() => setLatestGeneration(null)}>Create another</button></div></div>
      </article>}
    </section>}
    {view === "images" && <section className="workspace-panel"><div className="page-heading compact"><span>YOUR LIBRARY</span><h1>My images</h1><button className="icon-button" onClick={loadImages}><RefreshCw size={15} /> Refresh</button></div>{images.length ? <div className="image-grid">{images.map((item) => <article className="image-card" key={item.id}><img src={item.imageUrl} alt={item.prompt} /><div><p>{item.prompt}</p><span>{item.operationType === "edit" ? "Edit" : "Generation"} · {item.provider} · {item.creditCost} credits</span><div className="image-card-actions"><a href={item.downloadUrl}>Download</a><button onClick={() => editGeneratedImage(item)}>Edit</button></div></div></article>)}</div> : <EmptyState icon={<ImageIcon />} title="No images yet" text="Your private generations and edits will appear here." />}</section>}
    {view === "credits" && <section className="workspace-panel"><div className="page-heading"><span>PUBLIC BETA CHECKOUT</span><h1>Buy Indermit credits</h1></div><div className="mode-card"><LockKeyhole size={18} /><div><strong>{beta.stripeReady ? "Secure Stripe checkout is connected" : "Checkout is being configured"}</strong>{!beta.stripeReady && <p>Purchasing stays disabled until the live Stripe key and webhook are both available.</p>}</div></div><div className="bundle-grid beta-bundle-grid">{BUNDLES.map((bundle) => <article className="beta-package" key={bundle.id}><span>{bundle.name}</span><strong>{bundle.price}</strong><p>{bundle.credits} credits · one-time purchase</p><div className="bundle-model-list"><b>Generate or edit with</b>{MODELS.filter((item) => item.id !== "auto").map((item) => <div key={item.id}><span><strong>{item.name}</strong><small>{item.provider} · 1K low quality</small></span><em>{item.credits} {item.credits === 1 ? "credit" : "credits"} / image</em></div>)}</div><div className="package-usage-limit"><b>Public-beta usage limits</b><span>Up to 20 completed images per hour and 60 completed images per day, per account.</span></div><button disabled={!beta.stripeReady || busy || account.creditBalance > 5 || beta.purchaseEligible === false} onClick={() => checkout(bundle.id)}>Buy 100 credits</button></article>)}</div><p className="beta-package-note">You can purchase another package when your balance reaches 5 credits or less. Accounts remain open after all 25 purchasing places are claimed.</p></section>}
    {view === "admin" && beta.role === "admin" && <AdminView data={admin} members={members} onAdjust={adjustCredits} onRefresh={refreshAdmin} refreshing={adminRefreshing} updatedAt={adminUpdatedAt} />}
  </main>
  <SiteFooter />
  {generationProgress && <div className="generation-overlay" role="dialog" aria-modal="true" aria-label="Creating your image"><div className="generation-progress-card">
    <div className="generation-visual"><div className="generation-glow" /><video className="generation-logo-animation" src="/indermit-generation-loader.mp4" poster="/indermit-mark.webp" autoPlay loop muted playsInline preload="auto" aria-hidden="true" /></div>
    <span className="section-label">{generationProgress.status === "creating" ? (generationProgress.operationType === "edit" ? "EDITING" : "GENERATING") : "FINALIZING"}</span>
    <h2>{generationProgress.status === "creating" ? (generationProgress.operationType === "edit" ? "Editing your image…" : "Creating your image…") : "Your image is ready…"}</h2>
    <p>{generationProgress.status === "creating" ? `${generationProgress.model} is ${generationProgress.operationType === "edit" ? "applying your changes" : "turning your prompt into an image"}.` : "Preparing the finished image in your studio."}</p>
    <div className="generation-prompt">“{generationProgress.prompt}”</div>
    <div className="generation-fade-bar"><span /></div>
    {generationProgress.imageUrl && <img className="generation-preloader" src={generationProgress.imageUrl} alt="" onLoad={() => setGenerationProgress(null)} onError={() => { setGenerationProgress(null); setMessage("The image was created, but the preview could not load. You can find it in My Images."); }} />}
  </div></div>}
  </div>;
}

function AdminView({ data, members, onAdjust, onRefresh, refreshing, updatedAt }) {
  if (!data) return <div className="loading-state"><LoaderCircle className="spin" /> Loading owner dashboard…</div>;
  return <section className="workspace-panel admin-view"><div className="page-heading compact"><span>OWNER PORTAL</span><h1>Private beta operations</h1><button type="button" className="icon-button" onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={15} /> {refreshing ? "Refreshing…" : "Refresh"}</button>{updatedAt && <small className="admin-refresh-time" aria-live="polite">Last updated {formatRefreshTime(updatedAt)}</small>}</div>
    <div className="metric-grid"><Metric label="Paid beta users" value={`${data.summary.paidBetaUsers}/25`} icon={<Users />} /><Metric label="Generations" value={data.summary.generations} icon={<Sparkles />} /><Metric label="Completed" value={data.summary.completed} tone="good" /><Metric label="Failed" value={data.summary.failed} tone={data.summary.failed ? "bad" : "good"} /></div>
    <UsageDashboard data={data.usage} />
    <div className="admin-columns"><section className="admin-card"><h2>Model and payment status</h2>{data.models.map((model) => <div className="status-row" key={model.id}><div><strong>{model.provider} · {model.name}</strong><span>{model.credits} credits per image</span></div><em className={model.enabled ? "online" : "offline"}>{model.enabled ? "Available" : "Coming soon"}</em></div>)}<div className="status-row"><div><strong>Stripe</strong><span>Webhook: {data.stripe.webhookReady ? "ready" : "not configured"}</span></div><em className={data.stripe.mode === "test" ? "online" : "offline"}>{data.stripe.mode}</em></div></section>
      <section className="admin-card"><h2>Financial definitions</h2><div className="usage-definitions"><p><strong>Provider cost</strong> Actual returned token usage when available; fixed published pricing or a labeled estimate otherwise.</p><p><strong>Net revenue</strong> Paid credits used, valued after allocated Stripe and Radar fees. Promotional credits count as $0 revenue.</p><p><strong>Gross profit</strong> Net revenue minus provider cost. It excludes tax, chargebacks, owner labor, and costs outside the API request.</p><p><strong>Provider balances</strong> Must still be reconciled with provider billing because standard API keys do not expose every account balance.</p></div></section></div>
    <section className="admin-card"><h2>Beta members</h2>{members.map((member) => <div className="member-row" key={member.user_id}><div><strong>{member.user_id}</strong><span>{member.role} · {member.credit_balance} credits</span></div><div><button onClick={() => onAdjust(member.user_id, 10)}>+10</button><button onClick={() => onAdjust(member.user_id, 100)}>+100</button></div></div>)}</section>
    <section className="admin-card table-card"><h2>Recent image activity</h2><div className="activity-table"><div className="activity-head"><span>User</span><span>Model / action</span><span>Status</span><span>Cost / profit</span><span>Time</span></div>{data.recentGenerations.map((item) => <div className="activity-row" key={item.id}><span>{item.user_id}</span><span>{item.provider} · {item.model}<br />{item.operation_type === "edit" ? "Edit" : "Generation"}</span><span className={`activity-status ${item.status}`}>{item.status}{item.error_code ? ` · ${item.error_code}` : ""}</span><span>{formatMoney(item.provider_cost_usd)} / {formatMoney(item.gross_profit_usd)}<br /><small>{formatCostSource(item.cost_source)}</small></span><span>{formatDate(item.created_at)}</span></div>)}</div></section>
  </section>;
}

function UsageDashboard({ data }) {
  if (!data) return <section className="admin-card usage-dashboard"><h2>Unified API usage</h2><p className="usage-empty">Usage data is unavailable until the API update finishes deploying.</p></section>;
  return <>
    <section className="admin-card usage-dashboard">
      <div className="usage-heading"><div><span>ALL PROVIDERS · {data.timezone}</span><h2>Unified API usage</h2></div><small>{data.note}</small></div>
      <div className="usage-spend-grid"><UsageSpend label="Today provider cost" value={data.financials.today.providerCostUsd} /><UsageSpend label="Today net revenue" value={data.financials.today.netRevenueUsd} /><UsageSpend label="Today gross profit" value={data.financials.today.grossProfitUsd} /><UsageSpend label="All-time gross profit" value={data.financials.allTime.grossProfitUsd} /></div>
      <div className="provider-usage-grid">{data.providers.map((item) => {
        const percentage = Math.min(100, item.dailyLimit ? (item.today.attempts / item.dailyLimit) * 100 : 0);
        return <article className="provider-usage-card" key={item.provider}><div><strong>{item.provider}</strong><em>{formatMoney(item.allTime.grossProfitUsd)} profit</em></div><b>{item.today.attempts}<small> / {item.dailyLimit} today</small></b><div className="usage-progress"><span style={{ width: `${percentage}%` }} /></div><p>{item.today.completed} completed · {item.today.failed} failed · {formatMoney(item.today.providerCostUsd)} cost</p><dl><div><dt>7 days</dt><dd>{item.sevenDays.attempts} attempts · {formatMoney(item.sevenDays.grossProfitUsd)} profit</dd></div><div><dt>All time</dt><dd>{item.allTime.attempts} attempts · {formatMoney(item.allTime.providerCostUsd)} cost</dd></div></dl></article>;
      })}</div>
    </section>
    <section className="admin-card table-card usage-model-card"><h2>Generation versus editing profitability</h2><div className="usage-model-table"><div className="usage-model-head"><span>Provider / model / action</span><span>Today</span><span>7 days</span><span>30 days</span><span>All time</span><span>Credits used</span></div>{data.models.length ? data.models.map((item) => <div className="usage-model-row" key={`${item.provider}-${item.model}-${item.operationType}`}><span><strong>{item.provider}</strong><small>{item.modelName} · {item.operationType === "edit" ? "Editing" : "Generation"}</small></span><span>{usageCell(item.today)}</span><span>{usageCell(item.sevenDays)}</span><span>{usageCell(item.thirtyDays)}</span><span>{usageCell(item.allTime)}</span><span>{item.allTime.creditsCharged}</span></div>) : <p className="usage-empty">No API image activity has been recorded yet.</p>}</div></section>
  </>;
}

function UsageSpend({ label, value }) { return <article><span>{label}</span><strong>{formatMoney(value)}</strong></article>; }
function usageCell(period) { return <><b>{period.attempts}</b><small>{period.completed} ok · {period.failed} failed<br />Cost {formatMoney(period.providerCostUsd)} · Profit {formatMoney(period.grossProfitUsd)}</small></>; }
function formatMoney(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value || 0)); }
function formatCostSource(value) { return value === "provider_usage" ? "Provider-reported" : value === "provider_fixed" ? "Published fixed price" : value === "estimated" ? "Estimated" : "Not recorded"; }

function Metric({ label, value, icon, tone = "" }) { return <article className={`metric ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong></article>; }
function EmptyState({ icon, title, text }) { return <div className="empty-state">{icon}<h2>{title}</h2><p>{text}</p></div>; }
function formatDate(value) { return value ? new Date(`${value.replace(" ", "T")}Z`).toLocaleString() : "—"; }
function formatRefreshTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—"; }
function Composer({ isSignedIn, onActivate }) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("auto");
  const activeModel = MODELS.find((item) => item.id === model);
  const generateButton = <button className="generate-button preview-generate" disabled={!prompt.trim()} onClick={isSignedIn ? onActivate : undefined}><Send size={16} /> Generate · {activeModel.credits} credits</button>;
  return <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1200} placeholder="Describe the image you want to create…" /><div className="composer-footer"><label className="model-menu"><span className="model-icon"><Sparkles size={15} /></span><span className="model-copy"><small>Model</small><strong>{activeModel.provider} · {activeModel.name}</strong></span><select value={model} onChange={(event) => setModel(event.target.value)}>{MODELS.map((item) => <option key={item.id} value={item.id}>{item.provider} · {item.name} · {item.credits} credits</option>)}</select><ChevronDown size={16} /></label>{isSignedIn ? generateButton : <SignUpButton mode="modal">{generateButton}</SignUpButton>}</div><p className="preview-note">Write your prompt and choose a model. Create an account when you are ready to generate.</p></div>;
}
function BetaBar() { return <div className="beta-bar"><span className="beta-dot" /> Indermit is in public beta. <span>Accounts are open. Credit purchases are limited.</span></div>; }
function Header() { return <header className="site-header"><a className="brand" href="/" aria-label="Indermit home"><BrandWordmark /></a><div className="header-actions"><SignedOut><SignInButton mode="modal"><button className="button button-quiet">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="button button-secondary">Create account</button></SignUpButton></SignedOut><SignedIn><UserButton /></SignedIn></div></header>; }
function SiteFooter() { return <footer><a className="brand footer-brand" href="/" aria-label="Indermit home"><BrandWordmark /></a><nav aria-label="Legal and support"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="mailto:support@indermit.com">Support</a></nav></footer>; }
function BrandWordmark() { return <img className="brand-wordmark" src="/indermit-wordmark-official.png" alt="Indermit" />; }

export default App;
