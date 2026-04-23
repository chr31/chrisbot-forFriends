const axios = require('axios');
const FormData = require('form-data');

function getTelegramApiBaseUrl(token) {
  const normalizedToken = String(token || '').trim();
  return normalizedToken ? `https://api.telegram.org/bot${normalizedToken}` : null;
}

function normalizeMultipartValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function postTelegramMethod(token, method, payload = {}) {
  const apiBaseUrl = getTelegramApiBaseUrl(token);
  if (!apiBaseUrl) throw new Error('Telegram bot token non configurato');

  const response = await axios.post(`${apiBaseUrl}/${method}`, payload, {
    timeout: 30000,
    maxBodyLength: Infinity,
  });
  if (!response.data?.ok) {
    throw new Error(response.data?.description || `Telegram API error on ${method}`);
  }
  return response.data.result;
}

async function postTelegramMultipart(token, method, payload = {}, fileField) {
  const apiBaseUrl = getTelegramApiBaseUrl(token);
  if (!apiBaseUrl) throw new Error('Telegram bot token non configurato');

  const form = new FormData();
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === fileField) continue;
    const normalized = normalizeMultipartValue(value);
    if (normalized !== null) {
      form.append(key, normalized);
    }
  }

  const file = payload?.[fileField];
  if (!file?.buffer) {
    throw new Error(`File multipart mancante: ${fileField}`);
  }
  form.append(fileField, file.buffer, {
    filename: file.filename || `${fileField}.bin`,
    contentType: file.contentType || 'application/octet-stream',
  });

  const response = await axios.post(`${apiBaseUrl}/${method}`, form, {
    headers: form.getHeaders(),
    timeout: 30000,
    maxBodyLength: Infinity,
  });
  if (!response.data?.ok) {
    throw new Error(response.data?.description || `Telegram API error on ${method}`);
  }
  return response.data.result;
}

async function sendTelegramDelivery(token, delivery = {}) {
  if (delivery.method === 'sendPhoto') {
    return postTelegramMultipart(token, 'sendPhoto', delivery.payload, 'photo');
  }
  return postTelegramMethod(token, delivery.method || 'sendMessage', delivery.payload || {});
}

module.exports = {
  getTelegramApiBaseUrl,
  postTelegramMethod,
  sendTelegramDelivery,
};
