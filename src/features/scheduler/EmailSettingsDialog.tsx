import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { emailForget, emailSave, emailSendTest, emailStatus, errorMessage, type EmailStatus, type SmtpSettings } from '../../lib/ipc';

/** The account scripts email you through (`pt.send_email`) and schedules send failure notes from.
 *  Mail goes only to your own address. The password is tried against the server before it is kept,
 *  and is kept in the system's credential store; it never comes back to this window. */

const BLANK: SmtpSettings = { host: '', port: 587, security: 'starttls', username: '', address: '' };

/** Well-known servers, filled in from the address. */
const KNOWN: Record<string, Pick<SmtpSettings, 'host' | 'port' | 'security'>> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  'live.com': { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
  'zoho.com': { host: 'smtp.zoho.com', port: 587, security: 'starttls' },
};

export function EmailSettingsDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [form, setForm] = useState<SmtpSettings>(BLANK);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'forget' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void emailStatus()
      .then((s) => {
        setStatus(s);
        if (s.settings) setForm(s.settings);
      })
      .catch((err) => setNote({ ok: false, text: errorMessage(err) }));
  }, []);

  const set = (patch: Partial<SmtpSettings>) => setForm((f) => ({ ...f, ...patch }));
  const setAddress = (address: string) => {
    const domain = address.split('@')[1]?.trim().toLowerCase() ?? '';
    const known = KNOWN[domain];
    setForm((f) => ({
      ...f,
      address,
      // Filled in only while the user hasn't typed their own.
      username: !f.username || f.username === f.address ? address : f.username,
      ...(known && (!f.host || Object.values(KNOWN).some((k) => k.host === f.host)) ? known : {}),
    }));
  };

  const run = async (what: 'save' | 'test' | 'forget') => {
    setBusy(what);
    setNote(null);
    try {
      if (what === 'save') {
        setStatus(await emailSave({ ...form, port: Number(form.port) }, password || null));
        setPassword('');
        setNote({ ok: true, text: 'Logged in and saved.' });
      } else if (what === 'test') {
        await emailSendTest();
        setNote({ ok: true, text: `A test email is on its way to ${form.address}.` });
      } else {
        setStatus(await emailForget());
        setForm(BLANK);
        setNote({ ok: true, text: 'Email settings forgotten.' });
      }
    } catch (err) {
      setNote({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const saved = status?.settings != null && status.passwordSaved;
  const canSave = form.host.trim() && form.username.trim() && form.address.includes('@') && (password || status?.passwordSaved);

  return (
    <Dialog
      title="Email settings"
      onClose={onClose}
      footer={
        <>
          {saved && (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('forget')}>
              Forget
            </button>
          )}
          {saved && (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('test')}>
              {busy === 'test' ? 'Sending…' : 'Send test email'}
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!canSave || busy !== null} onClick={() => void run('save')}>
            {busy === 'save' ? 'Logging in…' : 'Save'}
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Scripts email you with <code>pt.send_email</code>, and a schedule can email you when a run fails. Mail is sent through your own account and only
        ever to your own address. Gmail and Outlook need an <strong>app password</strong> (made in your account’s security settings), not your usual
        password.
      </p>
      <div className="email-form">
        <label className="study-field">
          <span>Your email address</span>
          <input className="python-input" type="email" autoComplete="off" value={form.address} onChange={(e) => setAddress(e.currentTarget.value)} />
        </label>
        <label className="study-field">
          <span>Mail server (SMTP)</span>
          <input className="python-input" placeholder="smtp.gmail.com" value={form.host} onChange={(e) => set({ host: e.currentTarget.value })} />
        </label>
        <div className="study-row">
          <label className="study-field">
            <span>Security</span>
            <select
              className="python-input"
              value={form.security}
              onChange={(e) => {
                const security = e.currentTarget.value as SmtpSettings['security'];
                set({ security, port: security === 'tls' ? 465 : 587 });
              }}
            >
              <option value="starttls">STARTTLS (port 587)</option>
              <option value="tls">TLS (port 465)</option>
            </select>
          </label>
          <label className="study-field">
            <span>Port</span>
            <input className="python-input" type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: e.currentTarget.valueAsNumber || 0 })} />
          </label>
        </div>
        <label className="study-field">
          <span>User name</span>
          <input className="python-input" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.currentTarget.value })} />
        </label>
        <label className="study-field">
          <span>Password</span>
          <input
            className="python-input"
            type="password"
            autoComplete="off"
            placeholder={status?.passwordSaved ? 'Saved — type to replace' : 'App password'}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
      </div>
      {note && <p className={`small ${note.ok ? 'study-profit' : 'study-problem'}`}>{note.text}</p>}
    </Dialog>
  );
}
