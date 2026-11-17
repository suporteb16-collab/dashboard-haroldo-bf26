/**
 * Cloudflare Worker — dados da Black Friday 26 do Haroldo Lourenço
 * Agência B16
 *
 * Lê a planilha "[HAROLDO] [BF26]" pela Google Sheets API (service account) e
 * devolve UM JSON com as duas abas que o dashboard usa — investimento e vendas —
 * já recortadas e sem dado pessoal.
 *
 * Por que o recorte de coluna mora AQUI e não é um parâmetro vindo do navegador:
 * a aba `vendas` é o dump do webhook da Voomp e traz nome, e-mail, telefone, CPF
 * e a chave PIX de cada comprador. Este endpoint é público (o dashboard no Pages
 * é um site estático, não tem como esconder a URL). Se o navegador pudesse pedir
 * `cols=AB,AC`, qualquer pessoa com o link levaria a base de clientes do Haroldo.
 * Quem decide o que sai é o servidor, e o que sai não tem PII.
 *
 * E-mail e telefone saem só como HMAC-SHA256 truncado (`p_email`, `p_fone`).
 * Serve para contar compradores distintos — o mesmo CPF aparece em 3 linhas
 * (duas tentativas recusadas e a aprovada) — e não volta para o e-mail sem a
 * chave PII_SALT.
 *
 * SECRETS (Settings > Variables and Secrets, tipo "Secret"):
 *   SHEET_ID      → 19Hy4_moTCcC5WbawDb-QEft4643npAw7-tIypccBSWA
 *   GOOGLE_SA_KEY → JSON completo da service account
 *   PII_SALT      → texto longo e aleatório (chave do HMAC). Trocar depois não
 *                   quebra o dashboard, só muda os códigos.
 *
 * A planilha já está compartilhada com a service account
 * teste-763@genuine-sector-390922.iam.gserviceaccount.com (a mesma dos outros
 * dashboards da B16). Ela NÃO precisa — nem deve — ficar pública.
 *
 * USO:  GET /            → JSON das duas abas (cache de 2 min no edge)
 *       GET /?fresh=1    → ignora o cache
 */

const CACHE_TTL = 120; // segundos

/* ------------------------------------------------------------------
   Recorte por aba. `col` é o nome do cabeçalho na planilha.
   Tipos: txt (padrão) · num · data · hash (sai como HMAC, nunca o valor).
   ------------------------------------------------------------------ */
const ABAS = {
  /* Export do Stract da conta de anúncios. Mesmo layout de colunas do CW26. */
  meta_ads: [
    { as: 'dia',           col: 'Date', tipo: 'data' },
    { as: 'campanha',      col: 'Campaign Name' },
    { as: 'conjunto',      col: 'Adset Name' },
    { as: 'anuncio',       col: 'Ad Name' },
    { as: 'gasto',         col: 'Spend (Cost, Amount Spent)', tipo: 'num' },
    { as: 'impressoes',    col: 'Impressions', tipo: 'num' },
    { as: 'cliques',       col: 'Action Link Clicks', tipo: 'num' },
    { as: 'checkouts',     col: 'Action FB Pixel Initiate Checkout (Offsite Conversion)', tipo: 'num' },
    { as: 'compras_pixel', col: 'Action FB Pixel Purchase (Offsite Conversion)', tipo: 'num' },
    { as: 'leads_pixel',   col: 'Action FB Pixel Lead (Offsite Conversion)', tipo: 'num' },
    { as: 'criativo',      col: 'Adcreative Name' },
    { as: 'thumb',         col: 'Thumbnail URL' },
  ],

  /* Log de webhook da Voomp: UMA LINHA POR EVENTO, não por venda. A mesma
     `sale_id` volta quando o status muda (waiting → paid, paid → refunded) e
     tentativas recusadas do mesmo comprador geram `sale_id` diferentes. Quem
     consolida é o dashboard — aqui só sai o dado cru recortado.

     Das 82 colunas da planilha, 60 não entram: ou são PII (nome, e-mail, CPF,
     telefone, endereço, chave PIX, boleto), ou são o cadastro do produto
     repetido em toda linha (descrição, garantia, formas de pagamento), ou vêm
     sempre vazias (coSeller, contract). */
  vendas: [
    { as: 'recebido_em',   col: 'timestamp_incoming_webhook', tipo: 'data' },
    { as: 'tipo',          col: 'type' },              // sale · lead
    { as: 'gatilho',       col: 'trigger' },           // salePaid · saleRefused · checkoutAbandoned …
    { as: 'status_antigo', col: 'oldStatus' },
    { as: 'status_atual',  col: 'currentStatus' },
    { as: 'venda_id',      col: 'sale_id' },
    { as: 'status',        col: 'sale_status' },
    { as: 'metodo',        col: 'sale_method' },        // PIX · CREDIT_CARD · BOLETO
    { as: 'parcelas',      col: 'sale_installments', tipo: 'num' },
    { as: 'valor',         col: 'sale_amount', tipo: 'num' },        // preço cheio (faturamento bruto)
    { as: 'taxa',          col: 'sale_fee', tipo: 'num' },
    { as: 'com_afiliado',  col: 'sale_affiliate', tipo: 'num' },
    { as: 'liquido',       col: 'sale_seller_balance', tipo: 'num' }, // o que sobra pro produtor
    { as: 'pago_em',       col: 'sale_paid_at', tipo: 'data' },
    { as: 'criado_em',     col: 'sale_created_at', tipo: 'data' },
    { as: 'cupom',         col: 'sale_coupon' },
    { as: 'motivo_recusa', col: 'sale_refused_reason' },
    { as: 'p_email',       col: 'client_email', tipo: 'hash' },
    { as: 'p_fone',        col: 'client_cellphone', tipo: 'hash' },
    { as: 'uf',            col: 'client_uf' },          // região não identifica ninguém
    { as: 'produto',       col: 'product_name' },
    { as: 'oferta',        col: 'product_offer_name' },
    { as: 'preco_oferta',  col: 'product_offer_price', tipo: 'num' },
    { as: 'afiliado',      col: 'affiliate_name' },     // nome comercial do parceiro, não de cliente
  ],
};
const ABAS_LIDAS = ['meta_ads', 'vendas'];

/* ---------------------------- CORS ---------------------------- */
/* Liberado para qualquer origem: o que sai daqui já é público por desenho (sem
   dado pessoal), e quem quiser ler o JSON lê direto pela URL de qualquer jeito.
   Restringir a origem só criaria um jeito de o dashboard quebrar ao trocar de
   conta no GitHub. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/* ------------------------ Google auth ------------------------- */
let tokenCache = { valor: null, expira: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken(saRaw) {
  if (tokenCache.valor && Date.now() < tokenCache.expira) return tokenCache.valor;
  const sa = JSON.parse(saRaw);
  const agora = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const entrada = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: agora + 3600, iat: agora,
  })}`;
  const pem = sa.private_key.replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const chave = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(entrada)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${entrada}.${b64url(assinatura)}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha ao obter access_token: ' + JSON.stringify(d));
  tokenCache = { valor: d.access_token, expira: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

/* ------------------------- conversões ------------------------- */
const pad = n => String(n).padStart(2, '0');

/* Datas chegam como número de série (dateTimeRenderOption=SERIAL_NUMBER) quando a
   célula é data de verdade, e como texto quando é fórmula/colagem. Saem sempre
   como "AAAA-MM-DD HH:MM:SS" no horário da planilha — sem fuso, para o dashboard
   cortar o dia com `slice(0,10)` sem trocar a data.

   Esta planilha usa os três formatos: `Date` da meta_ads é ISO puro
   ("2026-11-16"), `timestamp_incoming_webhook` é BR ("06/11/2026 18:58:47") e
   `sale_paid_at` é ISO com fuso ("2026-11-06T18:58:40.000000-03:00"). O offset
   é descartado de propósito: tudo na planilha já está em -03:00, e converter
   para UTC jogaria as vendas da noite para o dia seguinte. */
function paraData(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
         + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])} ${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`;
  return null;
}

/* Número em formato BR ("1.234,56") ou US ("1,234.56") — o separador que vier por
   último é o decimal. A coluna de gasto da meta_ads vem em BR ("27,7"). */
function paraNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[R$\s%]/g, '');
  const ultVirg = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
  if (ultVirg > ultPonto) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function normalizaContato(v, ehFone) {
  if (v === null || v === undefined || v === '') return '';
  if (ehFone) {
    let d = String(typeof v === 'number' ? Math.round(v) : v).replace(/\D/g, '');
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    return d.length >= 10 ? d : '';
  }
  const e = String(v).trim().toLowerCase();
  return e.includes('@') ? e : '';
}

async function hmac(chave, texto) {
  if (!texto) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto)));
  return [...sig.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* --------------------------- Sheets --------------------------- */
async function lerAba(sheetId, aba, token) {
  const range = encodeURIComponent(`'${aba}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
            + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Sheets ${r.status} na aba "${aba}": ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).values || [];
}

async function recortar(linhas, receita, chaveHmac) {
  if (!linhas.length) return [];
  const cab = linhas[0].map(h => String(h).trim());
  const idx = receita.map(c => cab.indexOf(c.col));
  const faltando = receita.filter((c, k) => idx[k] < 0).map(c => c.col);
  const out = [];
  for (const l of linhas.slice(1)) {
    if (!l.some(v => v !== '' && v !== null && v !== undefined)) continue;
    const o = {};
    for (let k = 0; k < receita.length; k++) {
      const c = receita[k], i = idx[k];
      const v = i >= 0 ? l[i] : undefined;
      if (c.tipo === 'hash') o[c.as] = await hmac(chaveHmac, normalizaContato(v, /fone/.test(c.as)));
      else if (c.tipo === 'num') o[c.as] = paraNum(v);
      else if (c.tipo === 'data') o[c.as] = paraData(v);
      else o[c.as] = (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
    }
    out.push(o);
  }
  return { linhas: out, faltando };
}

async function montar(env) {
  const saRaw = typeof env.GOOGLE_SA_KEY === 'string' ? env.GOOGLE_SA_KEY : JSON.stringify(env.GOOGLE_SA_KEY);
  const token = await accessToken(saRaw);
  const chaveHmac = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(env.PII_SALT || env.SHEET_ID),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  const lidas = await Promise.allSettled(ABAS_LIDAS.map(a => lerAba(env.SHEET_ID, a, token)));
  const abas = {}, erros = {}, colunas_faltando = {};
  for (let i = 0; i < ABAS_LIDAS.length; i++) {
    const nome = ABAS_LIDAS[i], res = lidas[i];
    if (res.status === 'rejected') { erros[nome] = res.reason.message; abas[nome] = []; continue; }
    const { linhas, faltando } = await recortar(res.value, ABAS[nome], chaveHmac);
    abas[nome] = linhas;
    /* Cabeçalho que mudou de nome vira coluna toda nula em silêncio — e um KPI
       zerado sem erro na tela. Melhor o dashboard poder avisar. */
    if (faltando.length) colunas_faltando[nome] = faltando;
  }
  return { gerado_em: new Date().toISOString(), abas, erros, colunas_faltando };
}

/* ---------------------------- entrada ---------------------------- */
export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Método não permitido', { status: 405, headers: cors });

    const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });

    if (!env.SHEET_ID || !env.GOOGLE_SA_KEY)
      return json({ error: 'Faltam os secrets SHEET_ID e/ou GOOGLE_SA_KEY no Worker.' }, 500);

    const url = new URL(request.url);
    const chaveCache = new Request(url.origin + '/__bf26', { method: 'GET' });
    const cache = caches.default;

    if (url.searchParams.get('fresh') !== '1') {
      const hit = await cache.match(chaveCache);
      if (hit) {
        const corpo = await hit.text();
        return new Response(corpo, { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });
      }
    }

    try {
      const dados = await montar(env);
      const corpo = JSON.stringify(dados);
      ctx.waitUntil(cache.put(chaveCache, new Response(corpo, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` } })));
      return new Response(corpo, { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
    } catch (err) {
      console.error('[BF26]', err.message);
      return json({ error: err.message }, 500);
    }
  },
};
