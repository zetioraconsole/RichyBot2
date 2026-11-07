import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRIDGE_URL = process.env.BRIDGE_URL; // Mf: https://ocuzmnxjroygluizppfa.supabase.co/functions/v1/whatsapp-bridge
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map(); // seller_id -> { sock, status, starting }

// Msaidizi wa kupiga Edge Function ya Zetiora
async function callBridge(action, payload = {}) {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    return await res.json();
  } catch (err) {
    logger.error({ err: err.message, action }, 'Failed to call Zetiora bridge');
    return null;
  }
}

// Kuanzisha muunganisho wa muuzaji (Session)
async function startSession(sessionInfo) {
  const { seller_id, pair_method, pair_phone } = sessionInfo;

  if (sessions.has(seller_id)) {
    const existing = sessions.get(seller_id);
    if (existing.starting || existing.status === 'connected') return;
  }

  sessions.set(seller_id, { status: 'starting', starting: true });
  const sessionPath = path.join(SESSIONS_DIR, seller_id);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ seller_id, method: pair_method }, 'Starting Baileys session...');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Zetiora AI', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: true,
  });

  sessions.set(seller_id, { sock, status: 'starting', starting: false });

  // 1. Kama muuzaji amechagua Pairing Code na hajasajiliwa bado
  if (pair_method === 'code' && !sock.authState.creds.registered && pair_phone) {
    setTimeout(async () => {
      try {
        await delay(2000);
        // Safisha namba (e.g. 255712345678)
        const cleanPhone = pair_phone.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanPhone);
        logger.info({ seller_id, code }, 'Generated Pairing Code successfully');
        
        // Tuma pairing code kwenye Zetiora frontend
        await callBridge('qr', { seller_id, pair_code: code });
      } catch (err) {
        logger.error({ seller_id, err: err.message }, 'Failed to request pairing code');
        await callBridge('status', { seller_id, status: 'error', error: 'Imeshindwa kutoa code: ' + err.message });
      }
    }, 3000);
  }

  // 2. Kusikiliza mabadiliko ya muunganisho (QR, Open, Close)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // A. Mfumo ukitoa QR Code (kwa aliyetaka QR)
    if (qr && pair_method !== 'code') {
      logger.info({ seller_id }, 'Got QR code for shop');
      await callBridge('qr', { seller_id, qr });
    }

    // B. Muunganisho umefanikiwa (WhatsApp imeunganishwa)
    if (connection === 'open') {
      const myJid = sock.user?.id || '';
      const phoneNumber = myJid.split(':')[0].split('@')[0];
      logger.info({ seller_id, phoneNumber }, 'WhatsApp connected successfully! 🎉');

      sessions.set(seller_id, { sock, status: 'connected', starting: false });
      await callBridge('status', {
        seller_id,
        status: 'connected',
        phone_number: phoneNumber,
      });
    }

    // C. Muunganisho umekatika au umefungwa
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ seller_id, statusCode, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        sessions.delete(seller_id);
        setTimeout(() => startSession(sessionInfo), 4000);
      } else {
        // Logged out
        logger.info({ seller_id }, 'Device logged out, removing credentials');
        sessions.delete(seller_id);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        await callBridge('status', { seller_id, status: 'disconnected' });
      }
    }
  });

  // Hifadhi tokens za session zikisasishwa
  sock.ev.on('creds.update', saveCreds);

  // 3. Wateja wakituma ujumbe kwa namba ya muuzaji
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue; // Usijibu ujumbe wako mwenyewe
      const from = msg.key.remoteJid;
      if (!from || from.includes('@g.us') || from === 'status@broadcast') continue; // Hakuna magroup au status

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      logger.info({ seller_id, from, text }, 'Incoming customer message');

      // Tuma ujumbe kwa Zet AI Edge function
      const resp = await callBridge('message', {
        seller_id,
        from,
        text,
      });

      if (!resp) continue;

      // Zet akitoa jibu, Baileys inamrudishia mteja
      if (resp.reply) {
        await sock.sendMessage(from, { text: resp.reply });
      }

      // Kama kuna taarifa ya oda kwa muuzaji
      if (resp.notify?.text) {
        const ownerJid = sock.user?.id;
        if (ownerJid) {
          const formattedOwner = ownerJid.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(formattedOwner, { text: resp.notify.text });
        }
      }
    }
  });
}

// 4. Seva inakagua mara kwa mara maduka yanayosubiri kuunganishwa
async function pollSessions() {
  try {
    const data = await callBridge('sessions');
    if (data && Array.isArray(data.sessions)) {
      for (const s of data.sessions) {
        // Maduka yaliyo "pending" au yaliyounganishwa lakini session haijaanza kwenye RAM
        if (s.status === 'pending' || (s.status === 'connected' && !sessions.has(s.seller_id))) {
          startSession(s);
        }
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'Poll sessions error');
  }
}

// Anza polling kila sekunde 5
setInterval(pollSessions, 5000);
pollSessions();

// Health check endpoint kwa ajili ya Railway
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    active_sessions: sessions.size,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  logger.info(`Zetiora Baileys Bridge listening on port ${PORT}`);
});
