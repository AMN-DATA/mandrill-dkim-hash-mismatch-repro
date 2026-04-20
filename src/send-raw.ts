import Mailchimp, {
  type ApiClient,
  type TemplateContent
} from '@mailchimp/mailchimp_transactional'
import MailComposer from 'nodemailer/lib/mail-composer'
import { AxiosError } from 'axios'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

enum MandrillTemplates {
  DOCUMENT_FORWARD = 'documentForward',
  DOCUMENT_FORWARD_FAILURE = 'documentForwardFailure',
  INTEGRATIONS_DOCUMENT_FORWARD = 'integrationsDocumentForward',
}

const MandrillTemplateDefaults = {
  [MandrillTemplates.DOCUMENT_FORWARD]: 'autoforwarding',
  [MandrillTemplates.DOCUMENT_FORWARD_FAILURE]: 'mail-autoforwarding-04-2020',
  [MandrillTemplates.INTEGRATIONS_DOCUMENT_FORWARD]:
    'integrations-autoforwarding',
}

function isAxiosError<T>(result: AxiosError | T): result is AxiosError {
  return result instanceof AxiosError
}

function buildMimeMessage({
  fromEmail,
  toEmail,
  subject,
  html,
  attachment,
  metadata,
}: {
  fromEmail: string
  toEmail: string
  subject: string
  html: string
  attachment: { filename: string; contentType: string; content: Buffer }
  metadata: Record<string, string>
}): Promise<string> {
  const composer = new MailComposer({
    from: fromEmail,
    to: toEmail,
    subject,
    html,
    headers: {
      'X-MC-Metadata': JSON.stringify(metadata),
    },
    attachments: [
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      },
    ],
  })

  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) return reject(err)
      resolve(message.toString())
    })
  })
}

async function main() {
  const apiKey = requireEnv('MANDRILL_API_KEY')
  const toEmail = requireEnv('TO_EMAIL')
  const fromEmail = requireEnv('FROM_EMAIL')
  const filename = process.env['FILE_NAME'] ?? 'sample.pdf'

  const client: ApiClient = Mailchimp(apiKey)

  const templateName = MandrillTemplateDefaults[MandrillTemplates.DOCUMENT_FORWARD]

  const mergeVars: TemplateContent[] = [
    { name: 'name', content: 'Repro User' },
    { name: 'accountEmail', content: 'repro@example.com' },
    { name: 'filename', content: filename },
    { name: 'documentCreatedAt', content: '13.04.2026' },
    { name: 'documentSenderName', content: 'Repro Sender' },
    { name: 'documentSubject', content: 'Repro Subject' },
    { name: 'documentTags', content: ['REPRO'].map(tag =>
        tag.toUpperCase()
      ) as unknown as string, },
  ]

  // Step 1: Render the template via Mandrill API
  console.log(`Rendering template "${templateName}"...`)
  const renderResult = await client.templates.render({
    template_name: templateName,
    template_content: [],
    merge_vars: mergeVars,
  })

  if (isAxiosError(renderResult)) {
    throw renderResult
  }

  const html = renderResult.html
  console.log(`Template rendered (${html.length} chars)`)

  // Step 2: Read the PDF into a Buffer
  const pdfPath = resolve(__dirname, '..', filename)
  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(pdfPath)
    stream.on('data', (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

  // Step 3: Build MIME message via nodemailer MailComposer
  const metadata: Record<string, string> = {
    attemptId: `repro-${Date.now()}`,
    environment: 'production',
    website: 'https://www.caya.com',
  }

  const subject = `Mandrill PDF repro (send-raw) - ${Date.now()}`

  const rawMessage = await buildMimeMessage({
    fromEmail,
    toEmail,
    subject,
    html,
    attachment: {
      filename,
      contentType: 'application/pdf',
      content: pdfBuffer,
    },
    metadata,
  })

  console.log(`MIME message built (${rawMessage.length} bytes)`)

  // Dump the raw MIME to a file for inspection before sending
  const { writeFileSync } = await import('node:fs')
  const dumpPath = resolve(__dirname, '..', 'debug-raw-mime.eml')
  writeFileSync(dumpPath, rawMessage)
  console.log(`MIME dumped to ${dumpPath}`)

  // Step 4: Send via sendRaw
  const result = await client.messages.sendRaw({
    raw_message: rawMessage,
    from_email: fromEmail,
    to: [toEmail],
  })

  if (isAxiosError(result)) {
    throw result
  }

  console.log('--- Mandrill response ---')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error('Send failed:', error)
  process.exit(1)
})
