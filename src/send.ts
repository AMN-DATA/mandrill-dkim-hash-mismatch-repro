import Mailchimp, { ApiClient, MergeVar, MessagesSendResponse, type TemplateContent } from '@mailchimp/mailchimp_transactional'
import { AxiosError } from 'axios'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { type Readable } from 'node:stream'

/**
 * Mirrors our S3 based `convertStreamToBase64`
 * 
 * so the attachment bytes take the same Buffer-chunks -> Buffer.concat -> base64
 * path as real S3 downloads.
 */
function convertStreamToBase64(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    stream.on('error', reject)
  })
}

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

export interface ConfigMandrill {
  apiKey: string
  templates: {
    [MandrillTemplates.DOCUMENT_FORWARD]: string
    [MandrillTemplates.DOCUMENT_FORWARD_FAILURE]: string
    [MandrillTemplates.INTEGRATIONS_DOCUMENT_FORWARD]: string
  }
}

function isAxiosError<T>(result: AxiosError | T): result is AxiosError {
  return result instanceof AxiosError
}

interface Attachment {
  /**
   * base64 encoded content of the attachment.
   */
  content: string
  contentType?: string
  filename: string
}

/**
 * Wrapped mailchimp transactional client interface
 */
export class MandrillClient {
  private client: ApiClient

  constructor(private options: ConfigMandrill) {
    this.client = Mailchimp(options.apiKey)
  }

  /**
   * Send an email using a Mandrill template to a single recipient.
   *
   * @see https://mailchimp.com/developer/transactional/api/messages/send-using-message-template/
   */
  async sendEmail({
    attachments,
    environment,
    fromEmail,
    mergeVars,
    metadata,
    subject,
    templateName,
    toEmail,
  }: {
    attachments?: Attachment[]
    environment: string
    fromEmail: string
    mergeVars: MergeVar[]
    metadata?: Record<string, string>
    subject: string
    templateName: MandrillTemplates
    toEmail: string
  }): Promise<MessagesSendResponse> {
    const result = await this.client.messages.sendTemplate({
      message: {
        attachments: attachments?.map(attachment => ({
          content: attachment.content,
          name: attachment.filename,
          type: attachment.contentType ?? 'application/pdf',
        })),
        from_email: fromEmail,
        merge_vars: [
          {
            rcpt: toEmail,
            vars: mergeVars,
          },
        ],
        metadata: {
          ...metadata,
          environment,
          website: 'https://www.caya.com',
        },
        subject,
        to: [
          {
            email: toEmail,
          },
        ],
      },
      template_content: [],
      template_name: this.options.templates[templateName],
    })

    if (isAxiosError(result)) {
      throw result
    }

    return result?.[0]
  }
}

async function main() {
  const apiKey = requireEnv('MANDRILL_API_KEY')
  const toEmail = requireEnv('TO_EMAIL')
  const fromEmail = requireEnv('FROM_EMAIL')
  const filename = process.env['FILE_NAME'] ?? 'sample.pdf'

  const client = new MandrillClient({
    apiKey,
    templates: MandrillTemplateDefaults,
  })

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

  const pdfPath = resolve(__dirname, '..', 'sample.pdf')
  const stream = createReadStream(pdfPath)
  
  const pdfBase64Raw = await convertStreamToBase64(stream)
  const pdfBase64 = pdfBase64Raw.match(/.{1,76}/g)!.join('\r\n')

  const response = await client.sendEmail({
    attachments: [
      {
        content: pdfBase64,
        filename,
      },
    ],
    environment: 'production',
    fromEmail,
    mergeVars,
    metadata: {
      attemptId: 'repro',
    },
    subject: `Mandrill PDF repro - ${Date.now()}`,
    templateName: MandrillTemplates.DOCUMENT_FORWARD,
    toEmail,
  })

  console.log('--- Mandrill response ---')
  console.log(JSON.stringify(response, null, 2))
}

main().catch(error => {
  console.error('Send failed:', error)
  process.exit(1)
})
