# Mandrill DKIM Hash Mismatch Reproduction

Minimal, standalone reproduction of a **DKIM body hash mismatch** observed on
messages sent through Mandrill (Mailchimp Transactional) `messages.sendTemplate`
with a PDF attachment, from the `send.getcaya.com` sending domain.

This repo uses the same SDK version, Node version, TypeScript version, and call
shape as our production code path, flattened into a single file so Mandrill
support can inspect the send without any monorepo baggage.

---

## TL;DR — the bug

For attachments above a certain size (confirmed at ~508 KB, passes at ~595 B),
the outbound MIME part has:

- **Base64 body wrapped at ~998 characters per line** instead of the RFC 2045
  §6.8 mandated maximum of **76 characters**.
- **A leading U+0020 SPACE prepended to every continuation line** of the base64
  body — 696 out of 697 lines in our captured 508 KB reproduction. This is the
  shape of an RFC 5322 header-fold (`CRLF<SP>`) applied to a body, which is not
  permitted for a MIME part.

Both behaviours occur *after* DKIM signing, so the receiver recomputes `bh=`
over bytes Mandrill never hashed, and reports `dkim=neutral (body hash did not
verify)` — Gmail's phrasing for a body-hash mismatch.

Both signatures fail identically (`d=mandrillapp.com` and `d=send.getcaya.com`,
same selector `mte1`, same `bh=`), which rules out customer-side DKIM/domain
misconfiguration: it is purely in Mandrill's outbound MIME emitter.

The base64 body still decodes (decoders tolerate whitespace), so the attachment
arrives intact — only DKIM verification fails.

---

## Evidence from a captured `.eml`

Measured directly from a delivered `multipart/mixed` message carrying the 508 KB
`sample-large.pdf`:

```
Attachment part body:     696,226 bytes
EOL:                      CRLF (correct for SMTP)
Line 0   (no SP prefix):  998 chars — starts "JVBERi0x…"
Lines 1..696 (SP prefix): 998 chars each — each starts " BxIFEgc…"
Line 697:                 224 chars (trailing)
Lines starting with " ":  696 / 697
```

Both `DKIM-Signature` headers on the same message declared:

```
v=1; a=rsa-sha256; c=relaxed/relaxed;
d=mandrillapp.com;     s=mte1; bh=fbD/zm8D3LtgfwzK7WN92xxabCOvWW8ByNmsVrUhg8w=
d=send.getcaya.com;    s=mte1; bh=fbD/zm8D3LtgfwzK7WN92xxabCOvWW8ByNmsVrUhg8w=
```

Gmail's `Authentication-Results`:

```
dkim=neutral (body hash did not verify) header.i=@mandrillapp.com   header.s=mte1
dkim=neutral (body hash did not verify) header.i=@send.getcaya.com  header.s=mte1
spf=pass  dmarc=pass
```

Note: `c=relaxed/relaxed` body canonicalization collapses *internal* runs of
whitespace on a non-empty line, but does not remove a leading SP that precedes
non-whitespace content. So the injected continuation-line SPs defeat the hash
even under relaxed canonicalization.

### Verifying the pattern on any received `.eml`

```python
with open('message.eml', 'rb') as f:
    data = f.read()
i = data.find(b'Content-Disposition: attachment; filename="sample')
start = data.find(b'\r\n\r\n', i) + 4
end = data.find(b'--', start)
body = data[start:end].rstrip(b'\r\n')
lines = body.split(b'\r\n')
print('lines:', len(lines),
      '| unique lens:', sorted({len(l) for l in lines}),
      '| leading-SP lines:', sum(1 for l in lines if l.startswith(b' ')))
```

On the failing message this prints `unique lens: [224, 998]` and
`leading-SP lines: 696 / 697`.

---

## Size-dependence

| PDF                  | Size       | DKIM at Gmail                 |
|----------------------|-----------:|-------------------------------|
| `sample.pdf`         |    595 B   | `dkim=pass`                   |
| `sample-large.pdf`   |    508 KB  | `dkim=neutral (body hash did not verify)` |

Same `send.ts`, same account, same template, same API call — the only variable
is attachment byte count. Switch between them by setting `FILE_NAME` in `.env`.

Happy to sweep intermediate sizes (50/100/250/400 KB) on request to pinpoint
the exact threshold where Mandrill's emitter switches to the broken wrapping
path.

---

## What to look at when reproducing

After running the script, open the received message at `TO_EMAIL` and inspect
its raw headers (e.g. Gmail "Show original"):

- `Authentication-Results:` — compare small vs. large send. Expect
  `dkim=pass` on small, `dkim=neutral (body hash did not verify)` on large.
- `DKIM-Signature:` — both the `d=mandrillapp.com` and `d=send.getcaya.com`
  signatures will carry the same `bh=` and both will fail on the large send.
- The raw attachment MIME part — verify the 998-char line length and leading
  SP on continuation lines using the Python snippet above, or by `grep -c`.

Please share back:

1. The console output from this script (all send parameters + response + `_id`).
2. The full raw headers **and raw body** of the received large-attachment
   message — the body measurements are needed to confirm the emitter defect.
3. The `Authentication-Results` of both the small and the large send, to
   demonstrate the size dependence.

---

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

```bash
nvm use
npm install
cp .env.example .env
# edit .env and fill in MANDRILL_API_KEY, TO_EMAIL
```

Optionally modify `FILE_NAME` in `.env` depending on the test scenario:

- `sample.pdf` — small file (~595 B), DKIM passes.
- `sample-large.pdf` — large file (~508 KB), DKIM fails with the pattern
  described above.

## Run

```bash
npm run build
npm run send
```

The script will:

1. Log every parameter passed to `messages.sendTemplate` (attachment is logged
   as metadata + size only — the base64 body is not dumped).
2. Call `messages.sendTemplate`.
3. Log the full Mandrill response and the message `_id`.

---

## How this mirrors our production path

The reproduction deliberately preserves three things that make it identical to
our production sender:

1. **Same SDK call shape.** `src/send.ts` contains a flattened copy of our
   in-house `MandrillClient.sendEmail` wrapper. The message object passed to
   `messages.sendTemplate` (attachments array, merge vars, metadata,
   template_name, template_content) matches byte-for-byte what production
   sends for document auto-forwarding.
2. **Same attachment encoding path.** Our production code reads the PDF from
   S3 as a `Readable` stream and base64-encodes it with
   `Buffer.concat(chunks).toString('base64')`. The repro does the same by
   streaming the local file via `createReadStream`, so the base64 string handed
   to the SDK is produced the same way.
3. **Same pinned versions.** `@mailchimp/mailchimp_transactional@1.4.1`,
   `typescript@5.9.3`, `@types/node@22.19.17`, Node 22.

---

## Files

- `src/send.ts` — single-file reproduction (SDK wrapper + stream-to-base64 +
  call site).
- `sample.pdf` — ~595 B PDF used when `FILE_NAME=sample.pdf`. Passes DKIM.
- `sample-large.pdf` — ~508 KB PDF used when `FILE_NAME=sample-large.pdf`.
  Fails DKIM with the 998-char / leading-SP pattern.
- `package.json` — pinned deps (`@mailchimp/mailchimp_transactional@1.4.1`,
  `typescript@5.9.3`, `@types/node@22.19.17`).
- `tsconfig.json` — CommonJS output to `dist/`.
- `.env.example` — required env vars (`MANDRILL_API_KEY`, `TO_EMAIL`,
  `FROM_EMAIL`, `FILE_NAME`).

---

## Suspected root cause (for Mandrill engineers)

The outbound MIME emitter for `messages.sendTemplate` appears to switch to a
different attachment-serialization path above a byte threshold. On the
high-size path, the base64 body is being folded as if it were an RFC 5322
header (`CRLF<SP>` every ~998 chars), producing a non-RFC-2045 body. If the
DKIM signer runs before this re-fold, `bh=` is computed over the un-folded
body and no longer matches the delivered body. A fix would be to either
(a) keep RFC 2045 76-char wrapping without a leading SP on continuation lines,
or (b) re-sign after any post-processing that mutates body bytes.
