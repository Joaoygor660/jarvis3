// sw.js — service worker do JARVIS.
//
// Existe por dois motivos: permitir instalar o sistema como aplicativo (o
// Android só oferece "Instalar" quando há um service worker ativo) e não deixar
// a tela em branco quando o supervisor está em campo, num posto sem sinal.
//
// A regra mais importante aqui é NÃO servir versão velha do sistema.
// Um service worker mal escrito é pior que nenhum: ele congela o app numa
// versão antiga e o usuário fica sem entender por que a correção não chegou.
// Por isso o HTML é sempre buscado na rede primeiro, e o cache só entra quando
// a rede falha de fato.

const VERSAO = "jarvis-v1";
const ESTATICOS = [
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon-32.png",
  "/site.webmanifest"
];

self.addEventListener("install", e => {
  // Assume o controle já nesta carga, em vez de esperar todas as abas fecharem.
  // Num painel que fica aberto o dia inteiro, esperar significaria nunca.
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSAO).then(c => c.addAll(ESTATICOS)).catch(() => {})
  );
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    // apaga caches de versões anteriores
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN e terceiros passam direto

  // As APIs NUNCA são cacheadas. Presença, chat e planilha precisam ser reais;
  // mostrar resposta antiga aqui seria pior do que mostrar erro.
  if (url.pathname.startsWith("/api/")) return;

  // Navegação (abrir o sistema): rede primeiro, cache só como rede de segurança.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        const c = await caches.open(VERSAO);
        c.put("/index.html", r.clone());
        return r;
      } catch (err) {
        const cache = await caches.match("/index.html");
        return cache || Response.error();
      }
    })());
    return;
  }

  // Ícones e afins: cache primeiro, porque não mudam e são pequenos.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r && r.status === 200 && r.type === "basic") {
        const c = await caches.open(VERSAO);
        c.put(req, r.clone());
      }
      return r;
    } catch (err) {
      return Response.error();
    }
  })());
});
