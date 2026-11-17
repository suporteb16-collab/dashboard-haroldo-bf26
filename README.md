# Dashboard — Black Friday 26 · Haroldo Lourenço

Dashboard da **Black Friday 2026** de Haroldo Lourenço. Construído pela **Agência B16**.

- **Produto:** Prática na Advocacia Imobiliária 3.0
- **Oferta da campanha:** `Black Novembro - 2026` (R$ 1.497) · hash `FgaDRT`
- **Plataforma de venda:** Voomp · **Mídia:** Meta Ads
- **Planilha:** `[HAROLDO] [BF26]` — abas `meta_ads` e `vendas`

---

## Arquitetura

```
Planilha "[HAROLDO] [BF26]" (Google Sheets, PRIVADA)
   abas: meta_ads · vendas
        │  Sheets API, com service account (só leitura)
        ▼
Cloudflare Worker  (worker.js)
   · escolhe as colunas no servidor — o navegador não pede coluna nenhuma
   · e-mail/telefone saem como HMAC (código), nunca o valor
   · devolve UM JSON com as duas abas · cache de 2 min no edge
        │
        ▼
index.html  (GitHub Pages, público)
```

A aba `vendas` é o dump do webhook da Voomp e traz **nome, e-mail, telefone, CPF,
endereço e a chave PIX** de cada comprador. Por isso a planilha **não pode ficar
pública**: quem lê é a service account, e só o que o Worker recorta chega ao navegador.
Das 82 colunas da aba, o Worker entrega 24 — nenhuma identifica o comprador.

### O que o Worker entrega

| Aba | Campos |
|---|---|
| `meta_ads` | dia, campanha, conjunto, anúncio, gasto, impressões, cliques no link, checkouts, compras e leads do pixel, criativo, thumbnail |
| `vendas` | datas (recebido/criado/pago), tipo, gatilho, status, `sale_id`, método, parcelas, valor, taxa, comissão de afiliado, líquido, cupom, motivo da recusa, `p_email`/`p_fone` (HMAC), UF, produto, oferta, preço, afiliado |

---

## Regras de cálculo

**Venda = `sale_id` consolidado, não linha da planilha.** A Voomp grava **uma linha por
evento** do webhook: um PIX gera `waiting_payment` e depois `paid`, no mesmo `sale_id`.
Contar linhas dobraria essa venda. O dashboard agrupa por `sale_id` e decide o status
final: **estorno ganha de pago, pago ganha do resto** — o que importa é onde o pedido
parou, não por onde passou.

> ⚠️ **Tentativa recusada tem `sale_id` próprio.** Não é o mesmo pedido tentando de novo:
> o Marco Antônio aparece em 3 `sale_id` (limite insuficiente → suspeita de fraude →
> aprovada). Por isso **pedidos > compradores**. A contagem de venda usa `sale_id`; o
> comprador único usa o HMAC do e-mail.

**Faturamento = `sale_amount`** (preço cheio, R$ 1.497), o bruto da oferta — padrão dos
outros dashboards da B16. O `sale_seller_balance` (o que sobra depois da taxa da Voomp e
da comissão do afiliado) aparece como **Líquido do produtor** na seção de Vendas.

**O dia da venda é o dia do PAGAMENTO** (`sale_paid_at`), não o da criação. Um boleto
criado no dia 10 e pago no 13 é faturamento do 13. Sem `paid_at`, cai para a criação.

**Investimento = campanhas com `[BLACK FRIDAY 26]` no nome.** Linha da `meta_ads` sem a
tag fica fora e é avisada em banner.

**Venda da BF = oferta `Black Novembro - 2026`**, não o produto. O "Prática na Advocacia
Imobiliária 3.0" é vendido o ano todo em outras ofertas; casar pelo produto contaria
venda de outra campanha. O filtro aceita `black novembro|black friday|black november`
porque as duas grafias convivem no cadastro da Voomp.

**Checkout abandonado** (`type=lead`, sem `sale_id`) não é pedido — fica fora da
consolidação e é contado à parte. A Voomp não data essas linhas, então esse KPI **não
segue o filtro de período**.

**A janela de período considera mídia E venda.** Olhando só a mídia, o filtro travaria em
13/11 e esconderia as vendas de 06/11 e 09/11, anteriores ao primeiro anúncio.

---

## Achados na planilha (16/11/2026)

1. 🔴 **O pixel da Meta não está registrando compra.** `Action FB Pixel Purchase` = **0**
   em todas as 16 linhas, com vendas pagas confirmadas na Voomp. A campanha está
   otimizando **cega para conversão**. Vale revisar o pixel/CAPI no checkout da Voomp —
   é o achado de maior impacto aqui.
2. 🟡 **Vendas antes do primeiro dia de mídia.** A mídia começou em **13/11**; há venda
   paga em **06/11** e **09/11**. Vieram de lista, orgânico ou afiliado. No filtro "Tudo"
   elas entram no ROAS, mas **não foram geradas pelos anúncios** — o dashboard avisa em
   banner para a leitura não ficar otimista demais.
3. 🟡 **A Voomp não grava UTM nesta planilha.** Não há `utm_source`/`utm_campaign` entre
   as 82 colunas, então **não existe atribuição de venda por criativo ou conjunto**. O
   cruzamento possível é no tempo (faturamento do dia × gasto do dia) e o funil de
   criativo para no checkout do pixel. Para ter atribuição real seria preciso incluir as
   UTMs no webhook da Voomp.
4. ℹ️ **Uma só campanha e um só conjunto** no ar (`[QUENTE] - Envolvimento 180D
   fragmentado`), com 4 criativos. A tabela de conjuntos fica com uma linha só até subir
   público frio.
5. ℹ️ Sobrou uma aba **`Tabela dinâmica 1`** na planilha. O Worker não a lê — pode apagar.

---

## Arquivos

| | |
|---|---|
| `index.html` | o dashboard (HTML/CSS/JS puro, Chart.js 4, sem build) |
| `worker.js` | o Cloudflare Worker — sem segredo no código; tudo vai nos Secrets |
| `amostra.json` | amostra no formato do Worker, para testar sem ele no ar |

Para testar sem o Worker: servir a pasta em `localhost` e abrir
`http://localhost:8000/?fonte=amostra.json`. O parâmetro `fonte` **só funciona em
localhost** — no endereço público ninguém troca a fonte por um link.

Visual: paleta clássica B16 (`#f4f4f2` / `#d4a800` / `#111`, Bebas Neue + DM Sans), tema
claro e escuro, mesmos padrões dos dashboards AAEMCWEB e CW26 (funil em trapézio, rótulo
direto em toda barra, 2 slots categóricos).

---

## Atualização dos dados

O dashboard lê a planilha **ao vivo** a cada carregamento, com cache de 2 minutos no edge
da Cloudflare. Não há hora marcada — o botão **↻ Atualizar** fura o cache.

A frescura do dado depende de quem alimenta a planilha:

| Aba | Quem alimenta | Frequência |
|---|---|---|
| `meta_ads` | Stract | extração de madrugada — o dia corrente costuma estar parcial |
| `vendas` | webhook da Voomp | tempo real, a cada evento de venda |

O dashboard avisa em banner quando a mídia está atrasada em relação a hoje.

---

## Deploy

### 1. Service account (já resolvido)

A planilha **já está compartilhada** com
`teste-763@genuine-sector-390922.iam.gserviceaccount.com`, a mesma service account dos
outros dashboards da B16 — não é preciso compartilhar nada de novo. A chave JSON dela
está nos Secrets dos Workers existentes (`cw26-dados`, `aaemcweb-dados`).

### 2. Cloudflare Worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create →
   Start with Hello World** → nome **`bf26-dados`** → **Deploy**.
2. **Edit code** → apagar tudo → colar o `worker.js` → **Deploy**.
3. **Settings → Variables and Secrets → Add**, tipo **Secret**:

   | Nome | Valor |
   |---|---|
   | `SHEET_ID` | `19Hy4_moTCcC5WbawDb-QEft4643npAw7-tIypccBSWA` |
   | `GOOGLE_SA_KEY` | o JSON completo da service account (copiar do Worker `cw26-dados`) |
   | `PII_SALT` | texto longo e aleatório (chave do HMAC) |

4. Abrir `https://bf26-dados.<subdominio>.workers.dev/` → tem que aparecer um JSON com
   `"abas"`.

### 3. GitHub Pages

1. Conferir a constante `WORKER_URL` no `index.html` (linha ~440) — tem que bater com a
   URL do Worker publicado.
2. **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.**

---

**Agência B16** — Henrique Cardoso, Business Intelligence · 16/11/2026.
