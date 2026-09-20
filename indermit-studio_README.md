# Indermit Studio

Indermit is a paid-credit image-generation studio for `indermit.com`. Visitors sign in through Clerk, purchase credits through Stripe, and generate images with OpenAI, Google, or xAI from one interface.

The frontend is a Vite/React static site designed for GitHub Pages. The API is a Cloudflare Worker using D1 for the credit ledger and R2 for generated images. No private API key is shipped to the browser.

## Included in this MVP

- Clerk-hosted sign-up, sign-in, account security, and social login support
- Stripe-hosted Checkout for three credit packages
- Signed and idempotent Stripe webhook processing
- Server-owned credit balance and immutable transaction ledger
- Atomic credit reservation before each generation
- Automatic credit refund when a provider fails
- OpenAI, Google, and configurable xAI image adapters
- Private R2 image storage with signed image URLs
- Responsive dark studio UI and personal generation history
- GitHub Actions workflow for GitHub Pages
- Draft Terms and Privacy pages that must be reviewed before launch

## Architecture

```text
indermit.com (GitHub Pages)
  ├─ Clerk hosted authentication
  ├─ Stripe hosted Checkout
  └─ api.indermit.com (Cloudflare Worker)
       ├─ D1: users, credits, purchases, generations
       ├─ R2: generated image files
       └─ OpenAI / Google / xAI APIs
```

## 1. Install and test

Use Node.js 20 or newer.

```bash
npm install
npm run check
```

## 2. Configure Clerk

1. Create a Clerk application.
2. Enable the login methods you want, such as Google, Apple, and email verification.
3. Add `http://localhost:5173` and `https://indermit.com` as allowed origins/redirects.
4. Copy `frontend/.env.example` to `frontend/.env.local` and set the Clerk publishable key.
5. Copy the Clerk issuer URL into the Worker configuration. It normally resembles `https://example.clerk.accounts.dev`.

The Worker verifies Clerk JWTs itself through the application's JWKS endpoint. Passwords and social-login tokens never enter the Indermit database.

## 3. Create Cloudflare resources

Authenticate Wrangler, then create the database and image bucket:

```bash
npx wrangler login
npx wrangler d1 create indermit-db
npx wrangler r2 bucket create indermit-images
```

Put the returned D1 ID into `worker/wrangler.toml`, then run:

```bash
npm run db:migrate:remote --workspace worker
```

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill it with test credentials. Never commit that file.

## 4. Add Worker secrets

From the `worker` directory, run each command and paste the value when prompted:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put XAI_API_KEY
npx wrangler secret put XAI_IMAGE_MODEL
npx wrangler secret put IMAGE_SIGNING_SECRET
npx wrangler secret put CLERK_JWKS_URL
npx wrangler secret put CLERK_AUTHORIZED_PARTIES
```

Generate `IMAGE_SIGNING_SECRET` with a secure password generator. `CLERK_AUTHORIZED_PARTIES` should be a comma-separated list such as `https://indermit.com,https://www.indermit.com`.

The xAI model name is deliberately configured as a secret instead of hard-coded because account availability and current model IDs can differ. Copy the exact image model ID shown in the xAI console.

## 5. Deploy the Worker

```bash
npm run deploy --workspace worker
```

Confirm `https://YOUR-WORKER.workers.dev/v1/health` returns an `ok` response. Then attach `api.indermit.com` as a Worker custom domain and set:

```toml
routes = [{ pattern = "api.indermit.com", custom_domain = true }]
```

Deploy again after changing the route.

## 6. Configure Stripe

In Stripe Workbench, add this webhook endpoint:

```text
https://api.indermit.com/v1/webhooks/stripe
```

Subscribe it to `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Start in Stripe test mode and complete a test purchase before using live keys.

Credit packages are defined on the server in `worker/src/stripe.js`; model credit costs are defined in `worker/src/providers.js`. The labels shown in the frontend are in `frontend/src/App.jsx`. Update both display and server values together. The backend values are authoritative.

## 7. Deploy GitHub Pages

Create a GitHub repository and push this project to its `main` branch. In the repository:

1. Open **Settings → Pages** and choose **GitHub Actions** as the source.
2. Open **Settings → Secrets and variables → Actions → Variables**.
3. Add `VITE_CLERK_PUBLISHABLE_KEY` with the Clerk publishable key.
4. Add `VITE_API_URL` with `https://api.indermit.com`.
5. Run the **Deploy frontend to GitHub Pages** workflow.
6. Configure `indermit.com` as the Pages custom domain and apply GitHub's recommended DNS records.

The `frontend/public/CNAME` file is already set to `indermit.com`.

## Local development

Terminal 1:

```bash
npm run dev:api
```

Terminal 2:

```bash
npm run dev
```

The frontend runs at `http://localhost:5173`; the Worker normally runs at `http://localhost:8787`.

## Before accepting real payments

- Replace the draft Terms and Privacy pages with counsel-reviewed versions.
- Test successful, cancelled, duplicated, and delayed Stripe webhook deliveries.
- Confirm every provider's production rate limits and safety policies.
- Decide your refund policy and customer-support process.
- Add production monitoring, alerting, abuse limits, and a spending cap for every AI provider.
- Confirm credit prices cover provider cost, failed-call behavior, Stripe fees, taxes, and margin.

OpenAI's current Image API supports direct single-image generation. Its documentation recommends the Image API for a single prompt and notes that image models may require organization verification: <https://developers.openai.com/api/docs/guides/image-generation>.
