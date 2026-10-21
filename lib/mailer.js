// Sends account emails (verification and password reset) through Resend's HTTP API when
// RESEND_API_KEY is set. Without a key, links are written to the server log instead, which is
// handy locally and lets a host's log viewer stand in for an inbox on a small private install.
const API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'Shelfspace <onboarding@resend.dev>';

const enabled = Boolean(API_KEY);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function layout({ heading, body, action, link, footnote }) {
  return `<!doctype html><html><body style="margin:0;background:#f7f5f0;font-family:Arial,sans-serif;color:#252921">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="font-size:18px;font-weight:bold;margin:0 0 28px"><span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:6px;background:#536b52;color:#fff;font-family:Georgia,serif;margin-right:8px">S</span>Shelfspace</p>
    <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:normal;margin:0 0 14px">${escapeHtml(heading)}</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 26px">${escapeHtml(body)}</p>
    <p style="margin:0 0 26px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 22px;border-radius:7px;background:#536b52;color:#fff;text-decoration:none;font-weight:bold">${escapeHtml(action)}</a></p>
    <p style="font-size:12px;line-height:1.6;color:#828477;margin:0">${escapeHtml(footnote)}<br>If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
  </div></body></html>`;
}

async function send({ to, subject, text, html }) {
  if (!enabled) {
    console.log(`[mail] Email sending is not configured. Message for ${to}: ${subject}\n${text}`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 200)}`);
  }
}

function sendVerification(user, link) {
  return send({
    to: user.email,
    subject: 'Confirm your Shelfspace email',
    text: `Hi ${user.name},\n\nConfirm your email to start adding books:\n${link}\n\nThis link works for 24 hours. If you did not create a Shelfspace account, you can ignore this email.`,
    html: layout({
      heading: `Welcome, ${user.name}.`,
      body: 'Confirm your email address and your shelf is ready for its first book.',
      action: 'Confirm my email', link,
      footnote: 'This link works for 24 hours. If you did not create a Shelfspace account, you can ignore this email.'
    })
  });
}

function sendPasswordReset(user, link) {
  return send({
    to: user.email,
    subject: 'Reset your Shelfspace password',
    text: `Hi ${user.name},\n\nChoose a new password here:\n${link}\n\nThis link works for 1 hour and can be used once. If you did not ask for a reset, you can ignore this email; your password has not changed.`,
    html: layout({
      heading: 'Choose a new password.',
      body: 'Someone (hopefully you) asked to reset the password for your Shelfspace account.',
      action: 'Reset my password', link,
      footnote: 'This link works for 1 hour and can be used once. If you did not ask for a reset, ignore this email: your password has not changed.'
    })
  });
}

module.exports = { enabled, sendVerification, sendPasswordReset };
