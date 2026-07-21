// api/_auth.js — autenticação das APIs por token assinado (HMAC-SHA256).
// Arquivo com prefixo "_" → NÃO vira rota na Vercel; é só importado.
//
// Rollout seguro em 2 etapas (nada quebra ao dar deploy):
//   1) Deploy com AUTH_ENFORCE ausente → modo "graça": ninguém é bloqueado,
//      mas o login já passa a emitir token e o front já o envia.
//   2) Depois de confirmar que todos conseguem entrar, definir na Vercel
//      AUTH_ENFORCE=1 → aí sim as APIs passam a exigir token válido.
// Requer também a env AUTH_SECRET (segredo forte). Sem ela, fica em graça.

const crypto = require("crypto");

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// Emite um token {u: userKey, exp: epoch_ms}. Validade padrão: 12h.
function sign(userKey, secret, horas) {
  const payload = { u: String(userKey), exp: Date.now() + (horas || 12) * 3600000 };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + sig;
}

function verify(token, secret) {
  if (!token || String(token).indexOf(".") < 0) return null;
  const parts = String(token).split(".");
  const body = parts[0], sig = parts[1] || "";
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  // comparação em tempo constante (evita timing attack)
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(unb64url(body).toString("utf8")); } catch (e) { return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return p;
}

function tokenFrom(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  return h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
}

// Guard usado no topo de cada endpoint protegido.
// Retorna { ok:true } quando pode seguir; { ok:false } quando deve bloquear (401).
// Em modo graça (sem AUTH_ENFORCE=1 ou sem AUTH_SECRET) SEMPRE deixa passar.
function requireAuth(req) {
  const secret = process.env.AUTH_SECRET;
  const enforce = process.env.AUTH_ENFORCE === "1";
  if (!enforce || !secret) return { ok: true, user: null, enforced: false };
  const p = verify(tokenFrom(req), secret);
  if (!p) return { ok: false, enforced: true };
  return { ok: true, user: p, enforced: true };
}

module.exports = { sign, verify, tokenFrom, requireAuth };
