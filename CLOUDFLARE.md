# Painel Casa Nissi na Cloudflare

Este repositório contém o painel existente e a adaptação para Workers. O serviço antigo está em `backend/`; a nova entrada está em `cloudflare/worker.mjs`.

## Publicar na sua conta

1. Na Cloudflare, abra **Workers & Pages → Create application → Import a repository** (ou **Continue with GitHub**, conforme a tela).
2. Autorize sua conta GitHub e escolha `Patreck23/painel-mercado-livre`.
3. Use a branch `main`, nome `painel-casa-nissi` e diretório raiz `/`.
4. Deixe o comando de build vazio. Comando de deploy: `npm run deploy`.
5. Publique e copie a URL `https://painel-casa-nissi.<sua-conta>.workers.dev`.

O Wrangler cria o Durable Object e seu armazenamento SQLite automaticamente pela migração declarada. Não é preciso contratar ou configurar um banco externo. O código usa recursos disponíveis no Workers Free; os limites da conta continuam aplicáveis.

## Autorizar as contas

No Worker, abra **Settings → Variables and Secrets** e adicione como **Secret**, conforme o serviço escolhido:

| Nome | Conteúdo |
|---|---|
| `ML_CLIENT_ID` | App ID da aplicação Mercado Livre |
| `ML_CLIENT_SECRET` | Secret Key da aplicação Mercado Livre |
| `BLING_CLIENT_ID` | Client ID do aplicativo Bling |
| `BLING_CLIENT_SECRET` | Client Secret do aplicativo Bling |

As duas integrações são independentes. É possível começar somente com Mercado Livre. Nunca coloque essas chaves no GitHub, em prints ou no chat.

Opcional: `SESSION_SECRET` pode ser uma chave aleatória estável para criptografia. Sem ela, o painel usa o secret do Bling ou do Mercado Livre. Não altere a chave de criptografia após autorizar as contas; se mudar, será necessário autorizar novamente. `APP_BASE_URL` é opcional e fixa a origem canônica quando for usado um domínio próprio; em workers.dev a origem é detectada automaticamente.

Cadastre as URLs de retorno nas respectivas aplicações, substituindo `<URL_DO_WORKER>` pelo endereço real, sem barra final:

- Mercado Livre: `<URL_DO_WORKER>/auth/mercado-livre/callback`
- Bling: `<URL_DO_WORKER>/auth/bling/callback`

No Mercado Livre, use Authorization Code e habilite PKCE. Selecione as permissões funcionais necessárias de leitura e acesso offline. Publicidade, Full e outras APIs podem exigir permissões específicas. Para os status do Bling, a consulta do cadastro de situações exige o escopo de **Gerenciador de transições**; alterar a situação de um pedido é outra permissão.

Depois de salvar os Secrets, abra `/mercado-livre` para autorizar Mercado Livre ou `/` para autorizar Bling.

## O que está implementado

- Adaptação HTTP para Workers com Durable Object SQLite compartilhado pela Casa Nissi.
- Sessões de Bling e Mercado Livre criptografadas no armazenamento persistente.
- Estados OAuth persistentes, uso único e PKCE no Mercado Livre.
- Renovação de tokens; a consulta do Bling tenta uma renovação ao receber HTTP 401.
- Consulta e análise de produtos do Bling: canais, curvas, top 10, preço médio, ABC e cancelamentos.
- Resumo diário no topo das análises e da visão geral.
- Importação em lotes, executada por alarms e retomada após reinícios; indicadores parciais são identificados.
- Acesso por URL, conforme solicitado, sem senha adicional.

A aba Mercado Livre confirma a conta autorizada por `/users/me`. As análises específicas de anúncios, publicidade e Full ainda precisam ser implementadas. Migrar não concede permissões de API nem resolve revogações externas; as contas precisam autorizar as novas URLs.

## Verificar antes de aposentar o Render

1. `/health` deve mostrar `1.0.0-cloudflare`.
2. Confira o apelido da conta após autorizar Mercado Livre.
3. Confira as vendas e cancelados do mesmo período no Bling.
4. Abra o painel em outro navegador para confirmar o acesso compartilhado.
5. Só depois desative o serviço antigo, se desejar. Esta adaptação não o remove.

## Desenvolvimento

Requer Node.js 22 ou posterior.

```sh
npm ci
npm test
npm run check
npm run dev
```

`npm run check` empacota o Worker sem publicar. Para publicar pela CLI já autenticada na sua conta: `npm run deploy`.

Os tokens são criptografados antes de serem gravados. O armazenamento de progresso usa um documento por pedido e não depende da memória do processo. Consultas respeitam uma fila entre chamadas ao Bling. Dados são por empresa, sem presumir códigos de canais ou de cancelamentos. Produtos não são automaticamente agrupados com vendas diretas do Mercado Livre, evitando duplicar vendas que já vieram pelo Bling.

### Mercado Livre product analytics

The Mercado Livre tab now imports real seller orders and listings in durable, bounded alarm batches. Select an inclusive start/end date (up to 150 days) and compare with the preceding equally sized period. Cards aggregate variants by listing ID, show paid item revenue, units, weighted selling price, daily revenue, portfolio-wide ABC, visits when authorized, and current official `/item/{id}/performance` quality/actions. Current metadata/quality are explicitly separated from historical sales. Listing snapshots record observed title/price/status/stock/logistics changes from installation onward; no historical changes are fabricated. The API's unavailable resources are labeled unavailable, not zero.

Orders are normalized without buyer/payment personal details. Catalog metadata is fetched using the current `/items/bulk` endpoint and seller scan pagination. A 30-minute persistent cache serves filters without restarting the import; stale periods preserve loaded data during synchronization. Sales pagination beyond the 10,000 order search cap is marked partial; ABC is provisional until all queries succeed. Gross paid item amounts exclude freight and do not claim net revenue, refunded totals, profit or official conversion. No listing writes are performed.

### Active monitoring and quality-decline research

Active listings are now the default card filter and catalog scan target. Historical order lines for inactive listings remain in the revenue and ABC calculations; their quality/visits enrichment is skipped. Choose All, Paused, or Closed in the situation selector to inspect historical items.

The section below the cards ranks up to 10 active listings with a real decline between the last quality observation in each of the two selected periods. Daily snapshots are timestamped when the API was actually read; an old `calculated_at` is never presented as a historical observation. Missing baseline, no decline, and zero score are distinct states. Ranking is independent of card pagination and text filters.

AI research uses the Cloudflare `AI` binding and `@cf/meta/llama-3.1-8b-instruct`. It queries the current Mercado Livre catalog competition endpoint and separates official new pending actions from generated hypotheses and suggested checks. It does not claim general internet search or invent a historical market/algorithm change. Non-catalog or unauthorized competition is explicitly unavailable. Sources and retrieval dates accompany each report. Inference is limited to ten new reports per Brasília day, maximum 650 output tokens per call, and cached per evidence signature for 24 hours. Invalid AI responses and missing bindings remain visible as unavailable, never templated text labeled as completed AI. No changes are made to listings. No buyer details, tokens, or secrets are sent to the model.
