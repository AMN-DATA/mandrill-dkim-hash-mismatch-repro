# Mandrill DKIM Hash Mismatch Reproduction

Minimal, standalone reproduction of a **DKIM hash mismatch** observed on messages
sent through Mandrill (Mailchimp Transactional) `messages.sendTemplate` with a
PDF attachment, from the `send.getcaya.com` sending domain.

This repo uses the same SDK version, Node version, TypeScript version, and call
shape as our production code path, flattened into a single file so Mandrill
support can inspect the send without any monorepo baggage.

## What to look at

After running the script, open the received message at `TO_EMAIL` and inspect
its raw headers (e.g. Gmail "Show original"):

- `Authentication-Results:` will report
  `dkim=fail (body hash did not verify)` (or similar) for `d=send.getcaya.com`.
- `DKIM-Signature:` header is present but the `bh=` body hash does not match the
  delivered body.

Please share:

1. The console output from this script (all send parameters + response + `_id`).
2. The full raw headers of the received message, including
   `Authentication-Results` and `DKIM-Signature`.

## Prerequisites

- Node.js 22 (an `.nvmrc` is provided — run `nvm use`).
- A Mandrill (Mailchimp Transactional) account with:
  - A valid API key.
  - A template named **`autoforwarding`** that accepts the merge variables
    `name`, `accountEmail`, `filename`, `documentCreatedAt`,
    `documentSenderName`, `documentSubject`, `documentTags`. The template
    contents do not matter for the DKIM check — a trivial template is fine.
- `send.getcaya.com` (or your equivalent sending domain) configured in the
  Mandrill account for the `FROM_EMAIL` you use.

## Setup

```sh
nvm use
npm install
cp .env.example .env
# edit .env and fill in MANDRILL_API_KEY, TO_EMAIL
```

Optionally modify `FILE_NAME` in `.env` file depending on the test scenario.

- sample.pdf - small file around 500 bytes _vs_
- sample-large.pdf - large file around 500KB

## Run

```sh
npm send
```

The script will:

1. Log every parameter passed to `messages.sendTemplate` (attachment is logged
   as metadata + size only — the base64 body is not dumped).
2. Call `messages.sendTemplate`.
3. Log the full Mandrill response and the message `_id`.

## Files

- `src/send.ts` — single-file reproduction.
- `sample.pdf` — small bundled PDF used as the attachment.
- `sample-large.pdf` — medium size bundled PDF used as the attachment. (~500KB)
- `package.json` — pinned deps: `@mailchimp/mailchimp_transactional@1.4.1`,
  `typescript@5.9.3`, `@types/node@22.19.17`.
