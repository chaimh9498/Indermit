# Security policy

Report security concerns privately to `security@indermit.com`. Do not include live API keys, payment information, or personal data in a public GitHub issue.

## Important deployment rules

- Never place Stripe, OpenAI, Google, xAI, Clerk secret, or image-signing keys in the frontend or GitHub Pages variables.
- Only `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_URL` are public frontend values.
- Add production secrets with `wrangler secret put`.
- Keep Stripe webhook signature verification enabled.
- Restrict Clerk authorized parties to the real frontend domains.
- Review provider safety requirements and add abuse monitoring before a public launch.
