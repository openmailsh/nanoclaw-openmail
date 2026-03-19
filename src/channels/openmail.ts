import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

const POLL_INTERVAL_MS = 60_000;
const JID_PREFIX = 'openmail:';

// fromAddr is stored as a raw RFC 5322 "From" header value,
// e.g. "Alice <alice@example.com>" or bare "alice@example.com".
const RFC5322_RE = /^(?:"?([^"<>]*?)"?\s*)?<([^>]+)>\s*$|^([^\s@]+@[^\s@]+)$/;

function parseFrom(fromAddr: string): { email: string; name: string | null } {
  const m = fromAddr.trim().match(RFC5322_RE);
  if (!m) return { email: fromAddr.trim(), name: null };
  if (m[3]) return { email: m[3], name: null };
  return { email: m[2], name: m[1]?.trim() || null };
}

interface OpenMailMessage {
  id: string;
  inboxId: string;
  threadId: string;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  direction: 'inbound' | 'outbound';
  createdAt: string;
}

interface OpenMailListResponse {
  data: OpenMailMessage[];
}

interface SenderContext {
  email: string;
  threadId: string;
  subject: string;
}

function apiGet<T>(apiKey: string, apiBase: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiBase}${path}`);
    const isHttps = url.protocol === 'https:';
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer | string) => (raw += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(`OpenMail API ${res.statusCode}: ${raw.slice(0, 200)}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(
            new Error(`Non-JSON OpenMail response: ${raw.slice(0, 100)}`),
          );
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(
  apiKey: string,
  apiBase: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiBase}${path}`);
    const isHttps = url.protocol === 'https:';
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        'Idempotency-Key': crypto.randomUUID(),
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer | string) => (raw += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `OpenMail send failed ${res.statusCode}: ${raw.slice(0, 200)}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

class OpenMailChannel implements Channel {
  name = 'openmail';

  private opts: ChannelOpts;
  private connected = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seenIds = new Set<string>();
  private sinceDate: string;

  private senderContext = new Map<string, SenderContext>();

  private apiKey: string;
  private inboxId: string;
  private inboxAddress: string;
  private apiBase: string;
  private mode: 'channel' | 'notify';
  private notifyJid: string | null;

  constructor(
    opts: ChannelOpts,
    apiKey: string,
    inboxId: string,
    inboxAddress: string,
    apiBase: string,
    mode: 'channel' | 'notify' = 'channel',
    notifyJid: string | null = null,
  ) {
    this.opts = opts;
    this.apiKey = apiKey;
    this.inboxId = inboxId;
    this.inboxAddress = inboxAddress;
    this.apiBase = apiBase;
    this.mode = mode;
    this.notifyJid = notifyJid;
    this.sinceDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info(
      { inbox: this.inboxAddress, mode: this.mode },
      'OpenMail channel connected',
    );
    this.schedulePoll(0);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info('OpenMail channel disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (this.mode === 'notify') {
      logger.debug({ jid }, 'OpenMail notify mode: outbound send ignored');
      return;
    }

    const ctx = this.senderContext.get(jid);
    if (!ctx) {
      logger.warn({ jid }, 'OpenMail: no sender context for reply, dropping');
      return;
    }

    await apiPost(
      this.apiKey,
      this.apiBase,
      `/v1/inboxes/${this.inboxId}/send`,
      {
        to: ctx.email,
        subject: `Re: ${ctx.subject}`,
        body: text,
        threadId: ctx.threadId,
      },
    );

    logger.info(
      { to: ctx.email, threadId: ctx.threadId },
      'OpenMail message sent',
    );
  }

  private schedulePoll(delayMs: number): void {
    if (!this.connected) return;
    this.timer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.warn({ err }, 'OpenMail poll error'))
        .finally(() => this.schedulePoll(POLL_INTERVAL_MS));
    }, delayMs);
  }

  private async poll(): Promise<void> {
    const result = await apiGet<OpenMailListResponse>(
      this.apiKey,
      this.apiBase,
      `/v1/inboxes/${this.inboxId}/messages?direction=inbound&limit=50`,
    );

    const messages = (result.data ?? [])
      .filter((m) => !this.seenIds.has(m.id) && m.createdAt > this.sinceDate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const m of messages) {
      this.seenIds.add(m.id);

      const { email, name } = parseFrom(m.fromAddr);
      const chatJid = `${JID_PREFIX}${this.inboxId}`;
      const senderLabel = name ? `${name} <${email}>` : email;
      const subject = m.subject ?? '(no subject)';
      const body = (m.bodyText ?? m.bodyHtml ?? '').trim();

      if (this.mode === 'notify') {
        if (!this.notifyJid || !this.opts.registeredGroups()[this.notifyJid]) continue;

        const preview = body.length > 200 ? body.slice(0, 200) + '…' : body;
        const notification: NewMessage = {
          id: `notify-${m.id}`,
          chat_jid: this.notifyJid,
          sender: `${JID_PREFIX}notify`,
          sender_name: 'OpenMail',
          content: [
            `[New email from ${senderLabel}]`,
            `Subject: ${subject}`,
            ``,
            preview,
          ].join('\n'),
          timestamp: m.createdAt,
          is_from_me: false,
        };

        this.opts.onMessage(this.notifyJid, notification);
        logger.debug(
          { from: email, subject, notifyJid: this.notifyJid },
          'OpenMail notification sent',
        );
        continue;
      }

      this.senderContext.set(chatJid, {
        email,
        threadId: m.threadId,
        subject,
      });

      const msg: NewMessage = {
        id: m.id,
        chat_jid: chatJid,
        sender: `${JID_PREFIX}${email}`,
        sender_name: name ?? email,
        content: [
          `[Email from ${senderLabel}]`,
          `Subject: ${subject}`,
          ``,
          `--- BEGIN UNTRUSTED EMAIL CONTENT ---`,
          body,
          `--- END UNTRUSTED EMAIL CONTENT ---`,
        ].join('\n'),
        timestamp: m.createdAt,
        is_from_me: false,
      };

      this.opts.onChatMetadata(
        chatJid,
        m.createdAt,
        this.inboxAddress,
        'openmail',
        false,
      );

      if (!this.opts.registeredGroups()[chatJid]) {
        logger.debug(
          { chatJid, from: email },
          'Message from unregistered OpenMail inbox',
        );
        continue;
      }

      this.opts.onMessage(chatJid, msg);

      logger.debug(
        { from: email, subject, threadId: m.threadId },
        'OpenMail message received',
      );
    }

    if (messages.length > 0) {
      this.sinceDate = messages[messages.length - 1].createdAt;
    }
  }
}

registerChannel('openmail', (opts) => {
  const env = readEnvFile([
    'OPENMAIL_API_KEY',
    'OPENMAIL_INBOX_ID',
    'OPENMAIL_ADDRESS',
    'OPENMAIL_API_URL',
    'OPENMAIL_MODE',
    'OPENMAIL_NOTIFY_JID',
  ]);
  const apiKey = process.env.OPENMAIL_API_KEY || env.OPENMAIL_API_KEY;
  const inboxId = process.env.OPENMAIL_INBOX_ID || env.OPENMAIL_INBOX_ID;
  if (!apiKey || !inboxId) return null;

  const mode = (process.env.OPENMAIL_MODE || env.OPENMAIL_MODE || 'channel') as 'channel' | 'notify';
  const notifyJid = process.env.OPENMAIL_NOTIFY_JID || env.OPENMAIL_NOTIFY_JID || null;

  if (mode === 'notify' && !notifyJid) {
    logger.warn('OpenMail notify mode requires OPENMAIL_NOTIFY_JID — falling back to channel mode');
  }

  return new OpenMailChannel(
    opts,
    apiKey,
    inboxId,
    process.env.OPENMAIL_ADDRESS || env.OPENMAIL_ADDRESS || '',
    process.env.OPENMAIL_API_URL ||
      env.OPENMAIL_API_URL ||
      'https://api.openmail.sh',
    mode,
    notifyJid,
  );
});
