const axios = require("axios");

const TEXT_BASE = "https://text.pollinations.ai";
const IMAGE_BASE = "https://image.pollinations.ai/prompt";

/**
 * Panggil Pollinations Text API (gratis, tanpa API key).
 * @param {string} prompt - teks/pertanyaan pengguna
 * @param {object} opts - { model, system }
 */
async function textGen(prompt, opts = {}) {
  const { model = "openai", system } = opts;
  const params = { model };
  if (system) params.system = system;

  const res = await axios.get(`${TEXT_BASE}/${encodeURIComponent(prompt)}`, {
    params,
    timeout: 45000,
    responseType: "text",
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: () => true
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Pollinations text API balas status ${res.status}`);
  }

  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

/**
 * Ambil buffer gambar dari Pollinations Image API.
 * @param {string} prompt
 * @param {object} opts - { model, width, height }
 */
async function imageGen(prompt, opts = {}) {
  const { model = "flux", width = 1024, height = 1024 } = opts;
  const url = `${IMAGE_BASE}/${encodeURIComponent(prompt)}`;

  const res = await axios.get(url, {
    params: { model, width, height, nologo: "true" },
    responseType: "arraybuffer",
    timeout: 60000,
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: () => true
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Pollinations image API balas status ${res.status}`);
  }

  return Buffer.from(res.data);
}

module.exports = { textGen, imageGen };
