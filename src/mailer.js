import nodemailer from 'nodemailer'

/** Gmail SMTP with an app password (SMTP_USER / SMTP_PASS in the environment file). */
export const createMailer = ({ smtp, log }) => {
  const configured = Boolean(smtp.user && smtp.pass)
  const transport = configured
    ? nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass } })
    : null
  if (!configured) log?.warn('mailer: SMTP_USER/SMTP_PASS not set — OTP login and email alerts are disabled')
  return {
    configured,
    send: async ({ to, subject, text }) => {
      if (!transport) throw new Error('SMTP is not configured')
      await transport.sendMail({ from: smtp.from, to, subject, text })
    }
  }
}
