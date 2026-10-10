# Interactive setup cards (generic OAuth sign-in + QR pairing in chat)

> **Status: IMPLEMENTED (P0–P2), P3 polish in progress.** Approach approved; the
> design is generic and declarative — no `anthropic-oauth` / `openai-codex` /
> `whatsapp-web` is hardcoded in the card system. A provider/channel opts in by
> *declaring* a capability (`LLMProvider.oauth` / `ChannelAdapter.pairing`),
> exactly like the secret-paste popup is driven by `configSchema`.
>
> - **P0** (done): `LLMProvider.oauth` declaration + provider-oauth route scans
>   for it; `SetupCardKind` types.
> - **P1** (done): OAuth sign-in card (`services/provider-signin.ts`, kind
>   `'oauth'`); `request_provider_setup` opens it.
> - **P2** (done): QR pairing card (kind `'qr'`, event-resolved via
>   `channel:pairing`); `request_channel_setup` opens it.
> - **P3** (done): re-pair an existing channel, docs.
> - **Plugin parity** (done): the vault token read/refresh is now a single
>   generic accessor (`_oauth-vault-access.ts`, declaration-driven) shared by the
>   built-ins and exposed to plugin providers as `ctx.oauth.getAccessToken`
>   (namespace-gated). A plugin LLM provider that declares `oauth` gets the
>   sign-in card AND can read/refresh its tokens; a plugin channel that declares
>   `pairing:'qr'` gets the QR card + re-pair for free.

## 1. Problem

Queenie (the configurator Agent) connects providers and channels **in chat**
via secure-input cards. Today every card is "fill some secret fields", driven
generically by the target's declared schema:

- `request_provider_setup` → popup of the provider's `secret` `configSchema`
  fields → create + test provider.
- `request_channel_setup` → popup of the adapter's `password` `configSchema`
  fields → create + activate channel.

But three new connections have **no secret to paste**:

- **Claude Max**, **OpenAI Codex**, and **xAI SuperGrok** (subscription LLMs): browser OAuth sign-in
  (PKCE), then paste back an authorization code. Codex and SuperGrok use a loopback redirect URL the server does not serve — paste the whole URL.
- **WhatsApp (QR)** (`whatsapp-web` channel): pair by scanning a QR code.

A temporary guardrail (shipped) makes the tools return `manual_setup_required`
with steps so Queenie points the user at the Settings UI. That works but breaks
Hivekeep's "I do it for you, in chat" promise. This spec replaces the guardrail
with **in-chat cards**, the generic way.

## 2. Current machinery (what we generalize)

All grounded in real code:

| Piece | File | Role |
|---|---|---|
| Card lifecycle | `src/server/services/secret-prompts.ts` | `createSecretPrompt` → SSE `prompt:secret-request`; `respondToSecretPrompt` dispatches by `purpose`; `finalizeSecretPrompt` resumes the Agent + SSE `prompt:secret-resolved` |
| Table | `secret_prompts` (`schema.md`) | `id, agentId, taskId, purpose, spec (JSON), status, resultRef, …`. **`spec` is free-form JSON** |
| Types | `src/shared/types.ts` | `SecretPromptPurpose`, `SecretPromptField`, `SecretPromptRequest` |
| Tools | `src/server/tools/secure-input-tools.ts` | `request_provider_setup`, `request_channel_setup`, `prompt_secret` |
| Front | `src/client/components/chat/SecretPromptModal.tsx` + `hooks/useSecretPrompts.ts` | renders fields, POSTs `/api/secret-prompts/:id/respond` |
| Route | `src/server/routes/secret-prompts.ts` | `respond` / `cancel` |
| OAuth engine (built) | `_oauth-pkce.ts`, `routes/provider-oauth.ts`, `_oauth-token-store.ts` | PKCE start/exchange, vault tokens — already generic over a `PkceClient` |
| QR engine (built) | SDK `pairing`/`startWithPairing`, `channel:pairing` SSE, `whatsapp-web.ts` | already generic over `pairing: 'qr'` |

The OAuth and QR *engines* already exist and are already declarative. What is
missing is the **card layer** that lets Queenie drive them in chat, and one
formalization of the OAuth declaration (see §4).

## 3. Core model: a connection has *setup methods*

Every connectable thing (LLM provider OR channel adapter) advertises one or more
**setup methods**. A method is a declared capability, never a hardcoded type:

| Method | Meaning | Declared by (generic source) |
|---|---|---|
| `secret` | Fill declared secret/password fields | provider `configSchema` has a `secret` field / adapter `configSchema` has a `password` field (today) |
| `oauth` | Authorization-code / PKCE browser sign-in | provider declares an `oauth` descriptor (see §4) |
| `qr` | Pair by scanning a code | adapter declares `pairing: 'qr'` + `startWithPairing` (already exists) |

The card system resolves the method from these declarations and renders the
matching card. It must contain **zero** references to specific provider/channel
ids. Add a new OAuth provider or a new QR channel later → it gets the card for
free.

## 4. The one new declaration (formalize OAuth)

Today the OAuth wiring lives in a registry inside a route
(`OAUTH_PROVIDERS` in `routes/provider-oauth.ts`, holding `ANTHROPIC_PKCE_CLIENT`
/ `CODEX_PKCE_CLIENT`). That is the proto-generic version. To make it a true
declaration, move it onto the provider:

```ts
// LLMProvider (SDK + server types) gains an optional, declarative field:
interface ProviderOAuthDescriptor {
  /** PKCE public client (authorize/token URLs, client id, scopes, redirect). */
  client: PkceClient
  /** Pull durable extras out of the token response into the vault bundle
   *  (e.g. Codex ChatGPT account id from the id_token). Optional. */
  buildExtra?: (tokens: PkceTokenResponse) => Record<string, string> | undefined
  /** Hint for the card copy: does the provider show the code on a page
   *  ('page', e.g. Anthropic) or redirect to a loopback URL the user copies
   *  ('loopback', e.g. Codex)? Drives the paste hint, generically. */
  redirectStyle: 'page' | 'loopback'
}

interface LLMProvider {
  // …existing…
  readonly oauth?: ProviderOAuthDescriptor
}
```

`routes/provider-oauth.ts` keeps the HTTP routes but builds its registry by
**scanning providers for `.oauth`** instead of a hand-maintained map. Result:
the existing `ANTHROPIC_PKCE_CLIENT` / `CODEX_PKCE_CLIENT` become
`anthropicOAuthProvider.oauth` / `openaiCodexProvider.oauth`. Channels need no
new declaration — `pairing: 'qr'` already is one.

> This is the heart of the founder's concern: after this, "supports sign-in" is
> a property a provider *declares*, queryable generically, not a list the card
> system knows about.

## 5. The card abstraction (extend, don't fork)

Generalize the card from "secret fields" to a small discriminated union by a new
`kind`, **stored inside the existing `spec` JSON** (so **no DB migration**;
`kind` absent ⇒ `'fields'`, fully backward compatible).

```ts
type SetupCardKind = 'fields' | 'oauth' | 'qr'

// SSE prompt:secret-request payload becomes a union on `kind`:
//  kind:'fields' → { fields: SecretPromptField[] }            (today, unchanged)
//  kind:'oauth'  → { authorizeUrl, providerDisplayName, redirectStyle }  (+ a code input)
//  kind:'qr'     → { } ; the QR image arrives live via channel:pairing
```

Naming: the concept is no longer only about secrets. **Recommendation:** keep
the internal table/service name (`secret_prompts`) to avoid a migration, but
introduce a thin neutral type alias layer (`SetupCard*`) for the union and the
new kinds. (Open decision D2.)

### 5.1 `oauth` card

1. **Create** (`request_provider_setup` when the provider declares `.oauth`, or
   the existing Settings "Sign in"): the server runs the existing PKCE *start*
   (mint verifier+challenge, build authorize URL). It stores the **verifier
   server-side only**, inside the card's `spec` row (never sent to the client),
   and emits `prompt:secret-request` with `kind:'oauth'` + `authorizeUrl`.
2. **Render** (`SecretPromptModal`): a "Sign in with {provider}" button opening
   `authorizeUrl` in a new tab, a paste hint (page vs loopback, from
   `redirectStyle`), and one code input. This is essentially the existing
   provider-dialog sign-in panel, reused as a card.
3. **Respond** (`POST /secret-prompts/:id/respond` with `{ code }`): treated
   like a secret value (client→server only). `respondToSecretPrompt`,
   `kind:'oauth'`, reads the verifier from the spec row, calls the existing
   exchange (`exchangePkceCode`) + token-vaulting + provider create (reuse the
   `provider-oauth` `complete` logic, factored into a service function), then
   `finalizeSecretPrompt` resumes Queenie with a non-sensitive summary.

The code is short-lived and never reaches the LLM (same guarantees as a secret
field). Tokens go to the vault (already built).

### 5.2 `qr` card

1. **Create** (`request_channel_setup` when the adapter declares `pairing:'qr'`):
   the server creates the channel (inactive) and starts pairing
   (`activateChannel` → `startWithPairing`). It emits `prompt:secret-request`
   with `kind:'qr'` carrying the `channelId`.
2. **Render**: the modal subscribes to `channel:pairing` (already emitted by the
   host, already encodes the QR to a PNG data-URL) filtered by `channelId`, and
   shows the live QR + "waiting to scan" / "connected" — the same UI already
   built into `ChannelFormDialog`, reused as a card.
3. **Resolve**: this card has **no user POST**; it resolves from a server event.
   When the pairing handler reports `connected` for that channel, it finalizes
   the card (resume Queenie: "WhatsApp connected"). On `logged-out`/`error` →
   finalize as failure. On user dismiss → `cancelSecretPrompt` (and deactivate
   the half-paired channel, like the dialog already does).

This is the one genuinely new lifecycle wrinkle: a card finalized by an SSE
event rather than a respond call. `finalizeSecretPrompt` already does all the
work; we add an internal `resolveSetupCardForChannel(channelId, outcome)` that
the pairing bridge calls.

## 6. Tools become method-aware (and stop dead-ending)

`request_provider_setup` / `request_channel_setup` inspect declared methods:

```
method = pickMethod(target)   // 'secret' | 'oauth' | 'qr', from declarations
switch method:
  'secret' → today's behavior (fields card)
  'oauth'  → create an oauth card (start PKCE)         // replaces the guardrail
  'qr'     → create a qr card (start pairing)          // replaces the guardrail
```

If a target ever declares **multiple** methods (none do today; e.g. a provider
offering both an API key and OAuth), the tool either takes a `method` arg or
presents a one-line choice. Out of scope for P1–P2; noted as D-multi.

The `manual_setup_required` guardrail stays only as a **fallback** for the case
where a card cannot be created (should not happen once wired).

## 7. Security (unchanged guarantees)

- **OAuth:** `code_verifier` lives server-side (card spec row), never sent to the
  client; the authorization code is treated as a secret value (client→server,
  exchanged server-side, never logged, never in a `messages` row, never to the
  LLM); tokens → encrypted vault. Resume summary is non-sensitive (existing
  `finalizeSecretPrompt` path).
- **QR:** the QR payload is ephemeral pairing data, not a user secret; safe to
  display. Session persisted as today (data dir, see `WHATSAPP_WEB_DIR`).
- **Authorization:** creating providers/channels is global config → cards stay
  **admin-only** (the tools already call `requireAdmin`). (Open decision D4.)

## 8. Backward compatibility

- Existing `secret` cards (provider key, channel token, vault, reveal): **no
  change** — absent `kind` ⇒ `'fields'`.
- `secret_prompts` schema: **no migration** (`kind` rides in the JSON `spec`).
- The Settings "Add provider/channel" dialogs already do OAuth/QR; they stay as
  they are. Cards are the *chat-native* path. (Open decision D5: unify later?)
- The shipped guardrail is downgraded to a fallback, not removed.

## 9. Phasing

- **P0 — Declarations.** Add `LLMProvider.oauth` (+ move the 2 descriptors onto
  the providers); make `provider-oauth` build its registry by scanning. Add
  `SetupCardKind` + the union types. Zero behavior change yet. Tests.
- **P1 — OAuth card.** Factor `provider-oauth` `complete` into a reusable
  service; add `kind:'oauth'` create (start) + respond (exchange) paths; add the
  oauth renderer to `SecretPromptModal`; wire `request_provider_setup`. i18n,
  docs, tests.
- **P2 — QR card.** Add `kind:'qr'` create (start pairing) + event-driven
  resolve; add the qr renderer (reuse the dialog's QR panel); wire
  `request_channel_setup`; correlate `channel:pairing` → card. i18n, docs, tests.
- **P3 — Polish.** Re-pair an existing channel from a card / channel card;
  multi-method choice; remove guardrail dead-code paths; queenie.md +
  queenie-knowledge.md + prompt updates (Queenie now *does* it in chat again, so
  revert the "exception" carve-out); docs-site.

## 10. Open decisions (need your call)

- **D1 — Declarative OAuth on the provider.** Move OAuth wiring onto
  `LLMProvider.oauth` and scan for it (vs. keep the route-level registry).
  *Recommend: yes* — it is the generality win you asked for. Small cost.
- **D2 — Naming.** Keep `secret_prompts`/`SecretPrompt*` internal names + add a
  `SetupCard*` type layer (no migration), or do a full rename migration to a
  neutral "setup/connection card". *Recommend: keep names, add the type layer.*
- **D3 — QR re-pairing.** Support re-pairing an existing (logged-out) channel
  from a card / the channel card, not just at creation. *Recommend: include a
  small version in P3.*
- **D4 — Who can respond.** Keep cards admin-only (global config). *Recommend:
  yes.*
- **D5 — Unify with Settings dialogs.** Eventually route the Settings
  Add-provider/Add-channel dialogs through the same card kinds, or keep them
  separate. *Recommend: keep separate for now; revisit later.*
- **D-multi — Multiple methods per target.** How to choose when a target offers
  both `secret` and `oauth` (none today). *Recommend: defer; add a `method` arg
  when the first such case appears.*

## 11. What this explicitly is NOT

- Not a rewrite of the secret-prompt system — it is an extension by `kind`.
- Not provider/channel-specific — the card layer reads declared methods only.
- Not a change to the OAuth/QR engines themselves (already built and generic);
  P0 only *relocates* the OAuth declaration onto the provider.
