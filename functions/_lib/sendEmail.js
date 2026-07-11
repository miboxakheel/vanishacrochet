// Sends transactional email via Cloudflare's native Email Workers "send_email"
// binding (per handoff §6/spec Task 3b: keep this in the Cloudflare ecosystem,
// no third-party transactional provider). Requires a `send_email` binding
// named SEB — see wrangler.toml.
//
// KNOWN CHECKPOINT (flagged in the spec, not solved here): Cloudflare's
// send_email binding is documented against a fixed/verified destination
// address. Sending to Vanisha's own address is straightforward (she can be
// added as a verified destination in Email Routing). Sending to an
// arbitrary customer address has historically been more restricted — this
// needs confirming once a real Cloudflare account + domain exist (go-live
// checklist). A failed send here is caught and logged, not thrown, so one
// bad email can never block an order being marked paid.
import { EmailMessage } from 'cloudflare:email';

function buildRawMime({ fromEmail, fromName, toEmail, toName, subject, html, text }) {
  const boundary = 'vc-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: "${fromName}" <${fromEmail}>`,
    `To: "${toName || toEmail}" <${toEmail}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].join('\r\n');
  const body =
    `--${boundary}\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\n${text}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n${html}\r\n` +
    `--${boundary}--`;
  return `${headers}\r\n\r\n${body}`;
}

export async function sendMail(env, { toEmail, toName, subject, html, text }) {
  if (env.MOCK_MODE === 'true') {
    console.log('[MOCK EMAIL] to=' + toEmail + ' subject="' + subject + '" (not actually sent — MOCK_MODE)');
    return { ok: true, mocked: true };
  }
  const fromEmail = env.ORDERS_FROM_EMAIL || 'orders@vanishacrochet.co.za';
  const fromName = env.STORE_NAME || 'Vanisha Crochet';
  try {
    if (!env.SEB) throw new Error('send_email binding "SEB" is not configured');
    const raw = buildRawMime({ fromEmail, fromName, toEmail, toName, subject, html, text });
    const msg = new EmailMessage(fromEmail, toEmail, raw);
    await env.SEB.send(msg);
    return { ok: true };
  } catch (err) {
    console.error('[email] send to ' + toEmail + ' failed:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}
