import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Mailchimp, {
  type MergeVar,
} from '@mailchimp/mailchimp_transactional'

const __dirname = dirname(fileURLToPath(import.meta.url))

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

async function main() {
  const apiKey = requireEnv('MANDRILL_API_KEY')
  const toEmail = requireEnv('TO_EMAIL')
  const fromEmail = requireEnv('FROM_EMAIL')

  const pdfPath = resolve(__dirname, '..', 'sample.pdf')
  const pdfBuffer = readFileSync(pdfPath)
  const pdfBase64 = pdfBuffer.toString('base64')
  const filename = 'sample.pdf'

  const templateName = 'autoforwarding'
  const subject = 'Mandrill PDF repro'

  const mergeVars: MergeVar[] = [
    { name: 'name', content: 'Repro User' },
    { name: 'accountEmail', content: 'repro@example.com' },
    { name: 'filename', content: filename },
    { name: 'documentCreatedAt', content: '13.04.2026' },
    { name: 'documentSenderName', content: 'Repro Sender' },
    { name: 'documentSubject', content: 'Repro Subject' },
    { name: 'documentTags', content: ['REPRO'] as unknown as string },
  ]

  const payload = {
    message: {
      attachments: [
        {
          content: pdfBase64,
          name: filename,
          type: 'application/pdf',
        },
      ],
      from_email: fromEmail,
      merge_vars: [{ rcpt: toEmail, vars: mergeVars }],
      metadata: {
        attemptId: 'repro',
        environment: 'repro',
        website: 'https://www.caya.com',
      },
      subject,
      to: [{ email: toEmail }],
    },
    template_content: [] as { name: string; content: string }[],
    template_name: templateName,
  }

  console.log('--- Mandrill sendTemplate parameters ---')
  console.log('template_name:', payload.template_name)
  console.log('template_content:', payload.template_content)
  console.log('message.from_email:', payload.message.from_email)
  console.log('message.to:', payload.message.to)
  console.log('message.subject:', payload.message.subject)
  console.log('message.metadata:', payload.message.metadata)
  console.log(
    'message.merge_vars:',
    JSON.stringify(payload.message.merge_vars, null, 2)
  )
  console.log('message.attachments (metadata only):', [
    {
      name: payload.message.attachments[0].name,
      type: payload.message.attachments[0].type,
      contentBytes: pdfBuffer.byteLength,
      contentBase64Length: pdfBase64.length,
    },
  ])
  console.log('----------------------------------------')

  const client = Mailchimp(apiKey)
  const response = await client.messages.sendTemplate(payload)

  console.log('--- Mandrill response ---')
  console.log(JSON.stringify(response, null, 2))

  if (Array.isArray(response) && response[0]?._id) {
    console.log('Mandrill message _id:', response[0]._id)
  }
}

main().catch(error => {
  console.error('Send failed:', error)
  process.exit(1)
})
