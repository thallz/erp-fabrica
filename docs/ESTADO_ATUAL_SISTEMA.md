# Estado Atual do Sistema — ERP Fábrica de Salgados Congelados

> Documento de auditoria técnica gerado a partir da leitura completa da estrutura de arquivos, banco de dados, rotas, controllers e telas do projeto em `erp-fabrica/`.

---

## 1. Tecnologias Usadas

### Backend (`backend/`)
- **Runtime e Linguagem:** Node.js (`node:20-alpine` no Docker) com JavaScript (CommonJS).
- **Framework Web:** `express` (`^4.22.2`), servindo a API REST em `http://localhost:3001/api/*` e também os arquivos estáticos de `frontend/` via `express.static`.
- **Middleware CORS:** `cors` (`^2.8.6`).
- **Driver de Banco de Dados:** `pg` (`^8.21.0`) com `Pool` de conexões.
- **Execução de Migrations:** Script próprio em `backend/src/config/migrate.js` (`runMigrations()`) executado automaticamente antes do `app.listen(3001)` em `backend/src/server.js`.

### Banco de Dados e Infraestrutura
- **SGBD:** PostgreSQL (`postgres:15-alpine` no `docker-compose.yml`).
- **Containerização:** `docker-compose.yml` com dois serviços:
  - `banco-dados-erp` (porta `5432`, banco `erp_salgados`, volume persistente `erp-dados`, seed inicial via `backend/init.sql`).
  - `api-erp` (build de `backend/Dockerfile`, porta `3001`).
- **Inicialização local (Windows):** `iniciar-erp.bat` inicia o container Docker `erp-fabrica-banco-dados-erp-1` e sobe `node src/server.js`.
- **Scripts de Reset e Testes Automatizados:**
  - `backend/reset.js` / `backend/reset_db.sql` e `backend/scripts/reset_db.js` (limpeza das tabelas preservando `tipo_intercorrencia`).
  - Testes diretos contra controllers/rotas com `mockRes` em `backend/`: `test_subsistema_estoque.js`, `test_compra_financeiro.js`, `test_orcamentos.js`, `test_contas_receber.js`, `test_fluxo_real.js` (além de testes legados na raiz: `test_api.js`, `test_planejamento.js`, `test_vendas.js`).

### Frontend Web (`frontend/`)
- **Tecnologias:** HTML5, CSS3 (`frontend/css/global.css`) e JavaScript Vanilla (inline em cada arquivo `.html`, consumindo `http://localhost:3001/api` via `fetch`). As pastas `frontend/js/` e `frontend/public/` estão vazias.
- **Bibliotecas externas (CDN):**
  - Fonte `Inter` (Google Fonts).
  - `Chart.js` `4.4.0` (apenas em `frontend/index.html`).
  - `https://tailwindcss.com` referenciado no `<head>` de `frontend/index.html` (embora o layout use classes do `global.css`).

### App Desktop & Coleção de API
- **Desktop (`app-desktop/`):** Electron (`^42.3.3`) em `app-desktop/main.js`, carregando `frontend/index.html` em janela maximizada. Contém também duas telas locais: `app-desktop/calculadora.html` e `app-desktop/index.html` (versão monolítica antiga).
- **Coleção de API (`ERP Fabrica/`):** Arquivos `.yml` do **Bruno / OpenCollection** (`opencollection.yml` e 19 requisições mapeadas).

---

## 2. Módulos e Telas Já Prontos

### 2.1 Telas Principais (conectadas na barra de navegação global)

#### Dashboard (`frontend/index.html`)
- Exibe 4 KPIs no topo ("Vendas Hoje", "Pedidos em Producao", "Contas Vencidas", "Estoque Critico"), gráfico de barras semanal ("Desempenho Semanal de Vendas") e lista resumida da fila de produção (`GET /api/financeiro/resumo` e `GET /api/producao/fila`).
- Possui botões de atalho operacional ("Lancar Pedido", "Novo Cliente", "Gerar OP") e bloco visual de "Relatorios Rapidos". *(Ver pendências na Seção 5: parte dos dados e botões é estática/mock).*

#### Módulo Comercial
- **Vendas / Pedidos B2B (`frontend/vendas.html`):**
  - Lista pedidos (`GET /api/comercial/pedidos`) com busca por cliente/#ID e filtros por status (`CRIADO`, `PRODUZINDO`, `FATURADO`, `ENTREGUE`).
  - Modal de **Novo Pedido**: seleciona cliente, data de entrega, condição/forma de pagamento (`BOLETO|A_PRAZO`, `PIX|A_PRAZO`, `PIX|A_VISTA`, `DINHEIRO|A_VISTA`, `CARTAO|A_VISTA`), vencimento e múltiplos itens com aviso em tempo real de disponibilidade na Câmara Fria vs. geração automática de OP (`POST /api/comercial/pedidos`).
  - Modal de **Detalhes do Pedido**: exibe itens, status financeiro da `conta_receber` vinculada e permite alterar o status (`PUT /api/comercial/pedidos/:id`).
- **Orçamentos Comerciais (`frontend/orcamentos.html`):**
  - Lista cotações (`GET /api/comercial/orcamentos`) com contadores por status (`PENDENTE`, `APROVADO`, `RECUSADO`), aviso de proposta expirada e link para o pedido gerado.
  - Modal de **Novo Orçamento**: monta cotação com cliente, validade, itens e observação (`POST /api/comercial/orcamentos`) sem alterar estoque nem gerar OPs.
  - Ações por orçamento: **Aprovar Pedido** (`POST /api/comercial/orcamentos/:id/aprovar` informando data de entrega), **Recusar** (`PUT /api/comercial/orcamentos/:id/recusar`) e **WhatsApp** (copia texto formatado da proposta e abre `wa.me`).
- **Produtos Finais (`frontend/produtos.html`):**
  - Cards com categoria, preço de venda, custo de produção, margem real (%), pontos de produtividade, composição de receitas e rateio de embalagem (`GET /api/produtos`).
  - Modal de criação/edição (`POST /api/produtos`, `PUT /api/produtos/:id`) com: preço de venda, produtividade (pts), categoria dinâmica (modal ⚙️ ligado a `/api/categorias`), linhas de receitas componentes (em gramas), seleção de embalagem (a partir de `insumo`) + capacidade (unidades) para rateio, e painel dinâmico de resumo financeiro (peso total, custo total, preço sugerido `2.5x`, margem real %). Permite exclusão (`DELETE /api/produtos/:id`).
- **Clientes B2B (`frontend/clientes.html`):**
  - CRUD completo de clientes (`GET/POST/PUT/DELETE /api/comercial/clientes`) em grid de cards com busca por nome/CNPJ/telefone, máscaras de CNPJ e telefone, tipo (`B2B`, `B2C`, `ATACADO`) e endereço de entrega.

#### Módulo Estoque
- **Almoxarifado / Matéria-Prima (`frontend/almoxarifado.html`):**
  - Duas abas: **Saldos Atuais** (cards com saldo, unidade `kg`/`un`, categoria, preço de referência e custo unitário) e **Extrato / Histórico de Movimentações (Kardex)** paginado e filtrável por insumo, tipo e período (`GET /api/estoque/extrato?tipo_estoque=MATERIA_PRIMA`).
  - **Modal de Nota Fiscal Multi-itens (`🧾 Lançar Compra / NF`):** registra entrada de múltiplos insumos, calcula custo unitário por item, atualiza preços/custos em cascata e gera 1 título consolidado no Contas a Pagar (`POST /api/estoque/entrada-nf`).
  - **Modal de Movimentação Avulsa / Balanço:** registra `AJUSTE`, `SAIDA` ou `PERDA` com prévia de saldo e justificativa obrigatória (`POST /api/estoque/movimentacoes`).
  - **Modal de Cadastro/Edição de Insumo:** suporte a medida por `Peso` (kg/g) ou `Unidade` (`un`), cálculo automático de custo por kg/un a partir de preço pago e tamanho da embalagem, gerenciamento de categorias (`INSUMO`) e exclusão (`DELETE /api/insumos/:id`).
- **Câmara Fria / Produto Acabado (`frontend/estoque_produtos.html`):**
  - KPIs de pronta-entrega (total de unidades, itens com saldo, itens zerados/baixo estoque `< 100`).
  - Duas abas: **Saldos da Câmara Fria** (cards com atalhos para Ajuste de Balanço e Descarte) e **Extrato / Histórico** (`GET /api/estoque/extrato?tipo_estoque=PRODUTO_ACABADO`).
  - Modal de Movimentação (`AJUSTE`, `PERDA`, `ENTRADA`, `SAIDA`) com prévia de saldo e gravação no Kardex (`POST /api/estoque/movimentacoes`).

#### Módulo Produção
- **Planejamento Maestro (`frontend/planejamento.html`):**
  - Painel semanal (Segunda a Sexta) exibindo à esquerda as OPs com `status = 'FILA'` sem data ou sem colaborador, e à direita a grade diária por colaborador ativo com barra de progresso em relação à meta diária (`verde`, `amarelo >= 80%`, `vermelho > 100%`).
  - Permite **Dividir OP** (`POST /api/planejamento/split-op`), **Atribuir OP** a dia/colaborador (`POST /api/planejamento/agendar` com disparo da inteligência D-1) e **Desatribuir OP**.
- **Fila de OPs (`frontend/ordens_producao.html`):**
  - Lista OPs separadas em duas abas: `Aguardando Início` (`FILA`) e `Em Execução` (`PRODUZINDO`), com selos de tipo (`PREPARO` vs `MONTAGEM`).
  - Permite **Iniciar Produção** (`PUT /api/producao/op/:id/status`) e **Finalizar e Enviar para Câmara Fria** (`PUT /api/producao/op/:id/finalizar`).
- **Receitas / Pré-Preparos (`frontend/receitas.html`):**
  - Cards com categoria, peso da batelada, custo da batelada, preço por kg e chips de ingredientes.
  - Modal de criação/edição (`POST/PUT /api/receitas`) permitindo adicionar insumos (`materia`) ou sub-receitas (`receita`) em gramas com recálculo em tempo real de peso total, custo total e custo por kg, além de gerenciador de categorias (`RECEITA`).
- **Colaboradores (`frontend/colaboradores.html`):**
  - CRUD completo (`GET/POST/PUT/DELETE /api/colaboradores`) com meta diária individual, status (`Ativo`/`Inativo`) e flag `eh_novato`.

#### Módulo Financeiro
- **Fluxo de Caixa (`frontend/financeiro.html`):**
  - Consome `GET /api/financeiro/resumo` e apresenta 3 KPIs consolidados: Contas a Receber Pendente, Contas a Pagar Pendente e Saldo Líquido Previsto `(recebidos + a_receber_pendente) - (pagos + a_pagar_pendente)`.
- **Contas a Receber (`frontend/contas_receber.html`):**
  - KPIs (Total a Receber Pendente, Títulos Vencidos, Recebidos no Mês), filtros por status (`Todos`, `PENDENTE`, `RECEBIDO`, `VENCIDO`) e busca local.
  - Permite **Confirmar Recebimento** (`PUT /api/financeiro/contas-receber/:id/receber`), criar **Lançamento Avulso** (`POST /api/financeiro/contas-receber`) e **Cobrança via WhatsApp** (copia mensagem pronta e abre `wa.me`).
- **Contas a Pagar (`frontend/contas_pagar.html`):**
  - KPIs (Total a Pagar no Mês, Vencidos, Pagos no Mês), filtros por status (`Todos`, `PENDENTE`, `VENCIDO`, `PAGO`), filtro por mês (`input[type="month"]`) e busca local.
  - Identifica títulos originados do Almoxarifado (NF), permite **Baixar / Pagar** (`PUT /api/financeiro/contas-pagar/:id/pagar`) e criar **Nova Despesa Avulsa** (`POST /api/financeiro/contas-pagar`).

---

### 2.2 Telas Auxiliares, Desktop e Páginas Não Linkadas na Topbar

- **`frontend/ficha_trabalho.html`:** Layout de impressão em papel **A4** para chão de fábrica (`GET /api/planejamento/ficha/:colaborador_id/:data`), segregando blocos de `PREPARO` (mapa de cozinha com bateladas em panelas de 10kg e etiqueta de resfriamento D-1) e `MONTAGEM` (instruções de massa D+0, retirada de recheio D-1 e montagem), além da tabela manual de intercorrências (`M1`, `E1`, `P1`, `O1`) e assinaturas. *Não possui link direto no menu ou no `planejamento.html`.*
- **`frontend/estoque_vendas.html`:** Visão simplificada da Câmara Fria para vendedora (`GET /api/produtos`), destacando produtos abaixo de 100 unidades. *Não possui link na topbar (substituída por `estoque_produtos.html`).*
- **`frontend/financeiro_resumo.html`:** Versão anterior de `financeiro.html` que calculava "Contas a Pagar" multiplicando estoque de insumos pelo preço pago. *Não possui link na topbar.*
- **`frontend/producao.html`:** Arquivo legado contendo uma cópia antiga da tela de Almoxarifado (com dados mock de metalúrgica em fallback offline). *Ainda está linkado no `index.html` em "Ver fila completa" e "Gerar OP".*
- **`app-desktop/calculadora.html`:** Tela desktop para calcular divisão de OPs do dia (`GET /api/producao/programadas-hoje`) em panelas/bateladas usando `ficha_tecnica_insumos` e `ficha_tecnica_embalagens`.
- **`app-desktop/index.html`:** Interface SPA monolítica antiga (Comercial, Produção, Financeiro) anterior à separação modular de `frontend/`.

---

## 3. Estrutura do Banco de Dados (PostgreSQL)

Schema definido em `backend/init.sql` e complementado por `backend/src/config/migrate.js` (executado no boot da API):

### 3.1 Estoque, Insumos, Receitas e Produtos
1. **`insumo`** (Almoxarifado / Matérias-primas e embalagens no modelo novo)
   - `id` (`SERIAL PK`), `nome` (`VARCHAR(100) NOT NULL`), `unidade_medida` (`VARCHAR(10) NOT NULL`), `custo_unitario` (`DECIMAL(10,4) NOT NULL`), `estoque_atual` (`DECIMAL(12,4) DEFAULT 0`), `categoria` (`VARCHAR(50) DEFAULT 'Outros'`), `preco_pago` (`DECIMAL(12,4) DEFAULT 0`), `peso_embalagem` (`DECIMAL(12,4) DEFAULT 1000`), `tipo_medida` (`VARCHAR(20) DEFAULT 'Peso'`).
2. **`embalagem`** *(modelo legado/paralelo presente em `init.sql`)*
   - `id` (`SERIAL PK`), `nome` (`VARCHAR(100) NOT NULL`), `custo_unitario` (`DECIMAL(10,4) NOT NULL`), `estoque_atual` (`INT DEFAULT 0`).
3. **`receita`** (Massas, Recheios, Molhos, Temperos)
   - `id` (`SERIAL PK`), `nome` (`VARCHAR(100) NOT NULL`), `categoria` (`VARCHAR(50) DEFAULT 'Geral'`), `custo_total` (`DECIMAL(12,4) DEFAULT 0`), `peso_total` (`DECIMAL(12,4) DEFAULT 0`), `custo_por_kg` (`DECIMAL(12,4) DEFAULT 0`), `estoque_atual` (`DECIMAL(12,4) DEFAULT 0`), `criado_em` (`TIMESTAMP`).
4. **`receita_item`**
   - `id` (`SERIAL PK`), `receita_id` (`INT FK -> receita.id ON DELETE CASCADE`), `tipo_origem` (`VARCHAR(10)` `'materia' | 'receita'`), `origem_id` (`INT NOT NULL`), `nome` (`VARCHAR(100) NOT NULL`), `quantidade_gramas` (`DECIMAL(12,4) NOT NULL`), `custo_unitario` (`DECIMAL(12,4) DEFAULT 0`), `custo` (`DECIMAL(12,4) DEFAULT 0`).
5. **`produto`** (Produtos Acabados / Câmara Fria)
   - `id` (`SERIAL PK`), `nome` (`VARCHAR(100) NOT NULL`), `preco_venda` (`DECIMAL(10,2) NOT NULL`), `cmv_estimado` (`DECIMAL(10,2)`), `margem_contribuicao` (`DECIMAL(5,2)`), `estoque_atual` (`INT DEFAULT 0`), `peso_produtividade` (`FLOAT DEFAULT 1.0`), `categoria` (`VARCHAR(50) DEFAULT 'Geral'`), `categoria_producao` (`VARCHAR(50) DEFAULT 'Geral'`), `embalagem_id` (`INT FK -> insumo.id ON DELETE SET NULL`), `capacidade_embalagem` (`DECIMAL(12,4) DEFAULT 1`), `rateio_embalagem` (`DECIMAL(12,4) DEFAULT 0`).
6. **`ficha_tecnica_receita`** (Produto × Receita em kg — principal tabela usada na explosão)
   - `produto_id` (`INT FK -> produto.id ON DELETE CASCADE`), `receita_id` (`INT FK -> receita.id ON DELETE RESTRICT`), `quantidade_necessaria` (`DECIMAL(12,4) NOT NULL` — em kg/un), `PK (produto_id, receita_id)`.
7. **`ficha_tecnica_produto`** (Espelho em gramas gravado junto com `ficha_tecnica_receita`)
   - `id` (`SERIAL PK`), `produto_id` (`INT FK -> produto.id ON DELETE CASCADE`), `receita_id` (`INT FK -> receita.id ON DELETE CASCADE`), `quantidade_gramas` (`DECIMAL(10,2) NOT NULL`).
8. **`ficha_tecnica_insumo`**
   - `produto_id` (`INT FK -> produto.id ON DELETE CASCADE`), `insumo_id` (`INT FK -> insumo.id ON DELETE RESTRICT`), `quantidade` (`DECIMAL(10,4) NOT NULL`), `PK (produto_id, insumo_id)`.
9. **`ficha_tecnica_embalagem`** *(vinculada à tabela `embalagem`)*
   - `produto_id` (`INT FK -> produto.id ON DELETE CASCADE`), `embalagem_id` (`INT FK -> embalagem.id ON DELETE RESTRICT`), `quantidade` (`INT NOT NULL`), `PK (produto_id, embalagem_id)`.
10. **`categoria`** (Categorias dinâmicas com `UNIQUE(nome, tipo)`)
    - `id` (`SERIAL PK`), `nome` (`VARCHAR(50) NOT NULL`), `tipo` (`VARCHAR(20)` `'INSUMO' | 'RECEITA' | 'PRODUTO'`).
    - Seeds automáticos para `INSUMO`, `RECEITA` e `PRODUTO`.
11. **`movimentacao_estoque`** (Kardex / Auditoria unificada)
    - `id` (`SERIAL PK`), `tipo_estoque` (`'MATERIA_PRIMA' | 'PRODUTO_ACABADO'`), `insumo_id` (`FK -> insumo.id ON DELETE SET NULL`), `produto_id` (`FK -> produto.id ON DELETE SET NULL`), `tipo_movimento` (`'ENTRADA' | 'SAIDA' | 'AJUSTE' | 'PERDA'`), `motivo` (`VARCHAR(50)`), `quantidade` (`DECIMAL(12,4)`), `unidade_medida` (`VARCHAR(10)`), `custo_unitario_momento` (`DECIMAL(12,4)`), `saldo_anterior` (`DECIMAL(12,4)`), `saldo_posterior` (`DECIMAL(12,4)`), `documento_ref` (`VARCHAR(100)`), `observacao` (`TEXT`), `criado_em` (`TIMESTAMP`).
    - Índices: `idx_mov_estoque_tipo_data`, `idx_mov_estoque_insumo`, `idx_mov_estoque_produto`.

### 3.2 Produção e Equipe
12. **`colaborador`**
    - `id` (`SERIAL PK`), `nome` (`VARCHAR(100) NOT NULL`), `meta_diaria` (`INT DEFAULT 350`), `meta_diaria_individual` (`INT DEFAULT 350`), `eh_novato` (`BOOLEAN DEFAULT FALSE`), `ativo` (`BOOLEAN DEFAULT TRUE`), `status` (`VARCHAR(20) DEFAULT 'Ativo'`), `criado_em` (`TIMESTAMP`).
    - *(Nota: `init.sql` insere 3 colaboradores de exemplo: Maria Silva, João Santos, Ana Costa).*
13. **`ordem_producao`**
    - `id` (`SERIAL PK`), `produto_id` (`INT FK -> produto.id`), `quantidade_planejada` (`INT NOT NULL`), `quantidade_realizada` (`INT DEFAULT 0`), `status` (`VARCHAR(20) DEFAULT 'FILA'`), `data_inicio` (`TIMESTAMP`), `data_fim` (`TIMESTAMP`), `colaborador_id` (`INT FK -> colaborador.id`), `data_programada` (`DATE`), `categoria_producao` (`VARCHAR(50)`), `tipo_op` (`VARCHAR(15) DEFAULT 'MONTAGEM'` `'PREPARO' | 'MONTAGEM'`), `receita_id` (`INT FK -> receita.id ON DELETE SET NULL`), `parent_op_id` (`INT FK -> ordem_producao.id ON DELETE SET NULL`), `criado_em` (`TIMESTAMP`).
14. **`tipo_intercorrencia`**
    - `codigo` (`VARCHAR(2) PK`), `descricao` (`VARCHAR(100) NOT NULL`), `afeta_meta` (`BOOLEAN DEFAULT TRUE`).
    - Populadas as siglas `M1`, `E1`, `P1`, `O1`.
15. **`apontamento_intercorrencia`**
    - `id` (`SERIAL PK`), `ordem_producao_id` (`INT FK -> ordem_producao.id ON DELETE CASCADE`), `codigo_intercorrencia` (`VARCHAR(2) FK -> tipo_intercorrencia.codigo`), `tempo_parada_minutos` (`INT NOT NULL`), `observacao` (`TEXT`), `registrado_em` (`TIMESTAMP`).

### 3.3 Comercial e Financeiro
16. **`cliente`**
    - `id` (`SERIAL PK`), `razao_social` (`VARCHAR(200) NOT NULL`), `cnpj` (`VARCHAR(20) UNIQUE NOT NULL`), `telefone` (`VARCHAR(20)`), `endereco` (`TEXT`), `tipo` (`VARCHAR(20) DEFAULT 'B2B'`), `criado_em` (`TIMESTAMP`).
17. **`pedido`**
    - `id` (`SERIAL PK`), `cliente_id` (`INT FK -> cliente.id ON DELETE RESTRICT`), `data_pedido` (`TIMESTAMP`), `data_entrega` (`DATE`), `status` (`VARCHAR(20) DEFAULT 'CRIADO'`), `valor_total` (`DECIMAL(10,2) DEFAULT 0.00`).
18. **`item_pedido`**
    - `pedido_id` (`INT FK -> pedido.id ON DELETE CASCADE`), `produto_id` (`INT FK -> produto.id ON DELETE RESTRICT`), `quantidade` (`INT NOT NULL`), `preco_unitario` (`DECIMAL(10,2) NOT NULL`), `PK (pedido_id, produto_id)`.
19. **`orcamento` e `item_orcamento`**
    - `orcamento`: `id` (`SERIAL PK`), `cliente_id` (`FK -> cliente.id`), `data_orcamento` (`TIMESTAMP`), `data_validade` (`DATE NOT NULL`), `status` (`'PENDENTE' | 'APROVADO' | 'RECUSADO'`), `valor_total` (`DECIMAL(10,2)`), `observacao` (`TEXT`), `pedido_id` (`FK -> pedido.id ON DELETE SET NULL`), `criado_em` (`TIMESTAMP`).
    - `item_orcamento`: `orcamento_id`, `produto_id`, `quantidade`, `preco_unitario`, `PK (orcamento_id, produto_id)`.
20. **`conta_pagar`**
    - `id` (`SERIAL PK`), `fornecedor` (`VARCHAR(150)`), `descricao` (`VARCHAR(200)`), `valor` (`DECIMAL(12,2)`), `data_emissao` (`DATE`), `data_vencimento` (`DATE`), `data_pagamento` (`DATE NULL`), `status` (`'PENDENTE' | 'PAGO' | 'CANCELADO'`), `forma_pagamento` (`VARCHAR(50) DEFAULT 'BOLETO'`), `documento_ref` (`VARCHAR(100)`), `movimentacao_estoque_id` (`INT FK -> movimentacao_estoque.id ON DELETE SET NULL`), `observacao` (`TEXT`), `criado_em` (`TIMESTAMP`).
21. **`conta_receber`**
    - `id` (`SERIAL PK`), `cliente_id` (`FK -> cliente.id`), `pedido_id` (`FK -> pedido.id ON DELETE CASCADE`), `descricao` (`VARCHAR(200)`), `valor` (`DECIMAL(10,2)`), `data_emissao` (`DATE`), `data_vencimento` (`DATE`), `data_recebimento` (`DATE NULL`), `status` (`'PENDENTE' | 'RECEBIDO' | 'CANCELADO'`), `forma_pagamento` (`VARCHAR(50) DEFAULT 'BOLETO'`), `documento_ref` (`VARCHAR(100)`), `observacao` (`TEXT`), `criado_em` (`TIMESTAMP`).

---

## 4. Regras de Negócio Já Codadas

### 4.1 Custos em Cascata e Margem de Contribuição
- **Custo de Insumo (`insumoController.js`):**
  - Medida `Peso`: `custo_unitario = (preco_pago / peso_embalagem) * 1000` (R$/kg, assumindo `peso_embalagem` em gramas).
  - Medida `Unidade`: `custo_unitario = preco_pago / peso_embalagem` (R$/un).
- **Recálculo em Cascata de Receitas (`backend/src/utils/recalcularCustos.js`):**
  - Ao criar/editar/excluir insumo, registrar entrada de NF ou movimentação com novo preço, ou listar/salvar receitas, `recalcularTodasReceitas()` roda até 10 passadas para resolver sub-receitas aninhadas (`tipo_origem = 'receita'`), recalculando `custo_unitario`, `custo` do item, `custo_total`, `peso_total` e `custo_por_kg` (`(custo_total / peso_total) * 1000`).
- **Custo e Margem de Produto (`produtoController.js` e `produtos.html`):**
  - `custo_ingredientes = SUM(ficha_tecnica_receita.quantidade_necessaria * receita.custo_por_kg)`.
  - `rateio_embalagem = preco_pago_embalagem / capacidade_embalagem`.
  - `custo_producao = custo_ingredientes + rateio_embalagem`.
  - `margem_bruta = preco_venda - custo_producao` e `margem_contribuicao_pct = (margem_bruta / preco_venda) * 100`.
  - Na UI de `produtos.html`, o preço sugerido exibido é `custoTotal * 2.5`.

### 4.2 Fluxo Comercial → Produção → Câmara Fria → Financeiro
- **Orçamentos (`comercialController.criarOrcamento`):**
  - Consolida itens repetidos e grava apenas `orcamento` e `item_orcamento` (`PENDENTE`). **Não** altera `produto.estoque_atual` e **não** gera `ordem_producao`.
- **Lançamento de Pedido ou Aprovação de Orçamento (`processarLancamentoPedidoTransacional` em `comercialController.js`):**
  - Tudo em uma única transação SQL (`BEGIN/COMMIT` com `FOR UPDATE`):
    1. Abate o saldo disponível da Câmara Fria (`produto.estoque_atual`) e registra `SAIDA` (`VENDA_PEDIDO`) no Kardex (`movimentacao_estoque`).
    2. Para a quantidade faltante (`qtdVendida - estoqueAnterior > 0`), cria uma OP de `MONTAGEM` na fila (`status = 'FILA'`).
    3. Explode `ficha_tecnica_receita` via `explodirEPrefabricarOPs`: verifica `receita.estoque_atual`; se faltar massa/recheio, gera OP filha de `PREPARO` (`Math.ceil(pesoFalta)` em kg, vinculada por `parent_op_id`) e zera o estoque da receita; se houver saldo suficiente, apenas deduz `receita.estoque_atual`.
    4. Define o status do pedido como `PRODUZINDO` (se gerou OP) ou `CRIADO` (se 100% atendido pela Câmara Fria).
    5. Gera automaticamente 1 título em `conta_receber`: se `pagamento_tipo === 'A_VISTA'`, nasce `RECEBIDO` com `data_recebimento = CURRENT_DATE`; se `A_PRAZO`, nasce `PENDENTE` com vencimento informado (ou `data_entrega`, ou `CURRENT_DATE + 15 dias`).
- **Atualização de Pedido (`comercialController.atualizarPedido`):**
  - Se alterado para `CANCELADO`, cancela títulos `PENDENTE` vinculados em `conta_receber`.
  - Se alterado para `ENTREGUE`, verifica se houve itens ainda não baixados no Kardex para aquele pedido e efetua a baixa complementar na Câmara Fria.

### 4.3 Almoxarifado, Câmara Fria (Kardex) e Contas a Pagar
- **Entrada Integrada de Nota Fiscal (`estoqueController.registrarEntradaNF`):**
  - Aceita múltiplos itens na mesma NF. Em transação única: atualiza `estoque_atual`, `custo_unitario = valorItemTotal / qtdNum`, `preco_pago` e `peso_embalagem` de cada insumo; grava 1 registro `ENTRADA` (`COMPRA_FORNECEDOR`) no Kardex por item; executa `recalcularTodasReceitas(client)`; e cria **1 único título consolidado** em `conta_pagar` (`PAGO` se `A_VISTA`, `PENDENTE` se `A_PRAZO`).
- **Movimentações Avulsas (`estoqueController.registrarMovimentacao`):**
  - Suporta `MATERIA_PRIMA` e `PRODUTO_ACABADO` com tipos `ENTRADA`, `SAIDA`, `PERDA` e `AJUSTE` (inventário físico que substitui o saldo). Bloqueia `SAIDA`/`PERDA` quando o saldo é insuficiente e registra `saldo_anterior` e `saldo_posterior` em `movimentacao_estoque`.

### 4.4 Planejamento e Execução de Produção
- **Agendamento com Inteligência D-1 (`planejamentoController.agendarOP` e `producaoController.agendarOP`):**
  - Ao agendar uma OP de `MONTAGEM` para uma data `D`, se ainda não existirem OPs filhas de `PREPARO`, cria-as via `explodirEPrefabricarOPs`.
  - Para OPs filhas vinculadas a receitas de categoria `'Recheio'` ou `'Molho'`, programa automaticamente `data_programada = D - 1` (preparo no dia anterior); para `'Massa'` ou outras, agenda para `D`.
- **Divisão de OP (`planejamentoController.splitOP`):**
  - Reduz a OP original e cria uma nova OP mantendo `produto_id`, `tipo_op`, `receita_id` e `parent_op_id`.
- **Finalização de OP (`producaoController.finalizarOP`):**
  - Se `tipo_op === 'PREPARO'`: explode `receita_item` proporcionalmente a `quantidade_planejada / receita.peso_total`, deduz insumos de `insumo.estoque_atual` registrando `SAIDA` (`CONSUMO_PRODUCAO`) no Kardex, deduz sub-receitas de `receita.estoque_atual` e **credita `receita.estoque_atual`** (não entra na Câmara Fria).
  - Se `tipo_op === 'MONTAGEM'`: deduz `receita.estoque_atual` (com `GREATEST(0, ...)`), deduz `ficha_tecnica_insumo` (com Kardex), deduz caixas da embalagem configurada em `produto.embalagem_id` (`Math.ceil(qtdPlanejada / capacidade_embalagem)` com Kardex) e **credita `produto.estoque_atual`** na Câmara Fria registrando `ENTRADA` (`PRODUCAO_CONCLUIDA`) no Kardex.
- **Capacidade e Sugestão Semanal (Backend):**
  - Validação de capacidade em pontos: `SUM(quantidade_planejada * peso_produtividade)` comparado a `colaborador.meta_diaria_individual`.
  - Sugestão semanal (`gerarSugestaoSemanal`): Fermentados na Segunda, Assados divididos 50/50 entre Terça e Quinta, Fritos divididos 50/50 entre Quarta e Sexta, demais no Sábado.
  - Ficha de Trabalho (`obterFichaTrabalho`): divide preparo em panelas de `10 kg`.

---

## 5. Pendências, Inconsistências e Trechos Incompletos Identificados

### 5.1 Bugs e Inconsistências no Backend
1. **Rota de exclusão de OP ausente (`backend/src/routes/producaoRoutes.js` vs `producaoController.js`):**
   - `producaoController.excluirOP` existe (linhas 135–149), assim como a coleção `ERP Fabrica/Excluir OP.yml`, porém nenhuma rota `DELETE /op/:id` está registrada em `producaoRoutes.js`.
2. **Verificação de impedimentos ignora `tipo_op` e `receita_id` (`producaoController.verificarImpedimentosOP`):**
   - A query da linha 177–182 seleciona apenas `op.id, op.produto_id, op.quantidade_planejada, p.nome AS produto_nome`, sem `op.tipo_op` e `op.receita_id`. Logo, `if (opData.tipo_op === 'PREPARO')` (linha 197) nunca é verdadeiro, fazendo OPs de preparo caírem no fluxo de montagem.
3. **Alerta D-1 no Planejamento Semanal nunca dispara (`planejamentoController.obterPlanejamentoSemanal`):**
   - Ao montar `colab.ops.push({...})` (linhas 619–630), o campo `data_programada` não é copiado para o objeto `op`. Em seguida, a linha 640 verifica `if (op.tipo_op === 'MONTAGEM' && op.data_programada)`, que é sempre `undefined`, impedindo que `op.alerta` seja preenchido.
4. **Dois modelos paralelos de Embalagem:**
   - `init.sql`, `producaoController.verificarImpedimentosOP`, `producaoController.necessidadeCompras`, `planejamentoController.obterInsumosSemana` e `planejamentoController.validarEstoqueSemana` consultam as tabelas `embalagem` e `ficha_tecnica_embalagem` (que não possuem tela de cadastro no frontend atual).
   - Já `produtos.html`, `produtoController` e `producaoController.finalizarOP` usam `produto.embalagem_id` apontando para `insumo(id)` + `capacidade_embalagem` + `rateio_embalagem`.
5. **Duas tabelas para ficha técnica de receitas (`ficha_tecnica_receita` vs `ficha_tecnica_produto`):**
   - `produtoController.criar` e `atualizar` gravam nas duas tabelas, mas toda a leitura de produtos, produção e planejamento usa exclusivamente `ficha_tecnica_receita`.
6. **Colunas `produto.cmv_estimado` e `produto.margem_contribuicao` desatualizadas no banco:**
   - `recalcularTodasReceitas()` recalcula `receita` e `receita_item`, mas não atualiza `produto.cmv_estimado` nem `produto.margem_contribuicao`. `produtoController.listar`/`obterPorId` calcula o custo dinamicamente, porém `financeiroController.resumo` ainda lê `AVG(p.cmv_estimado)` direto da tabela `produto`, e o Kardex de produto acabado usa `cmv_estimado` como fallback.
7. **Cancelamento de pedido não estorna Câmara Fria nem OPs (`comercialController.atualizarPedido`):**
   - Alterar pedido para `CANCELADO` cancela apenas `conta_receber` `PENDENTE`, mas não devolve os produtos já baixados em `produto.estoque_atual` nem cancela as OPs geradas automaticamente no lançamento.
8. **Filtro de `gerarSugestaoSemanal` (`planejamentoController.js`):**
   - A query busca apenas `WHERE ped.status = 'CRIADO'`, embora pedidos lançados com falta de estoque sejam gravados com `status = 'PRODUZINDO'`.
9. **Baixa dupla/incompleta na entrega (`comercialController.atualizarPedido`):**
   - Quando um pedido nasce com falta parcial na Câmara Fria e tem OPs concluídas depois, não há reserva vinculada ao pedido ao finalizar a OP; a baixa complementar ocorre apenas ao marcar manualmente o pedido como `ENTREGUE` (se houver saldo na Câmara Fria no momento).

### 5.2 Bugs e Inconsistências no Frontend e Telas Legadas
1. **Dashboard com dados mock e botões inativos (`frontend/index.html`):**
   - Gráfico semanal usa array fixo `[4500, 4800, 4600, 6000, 5800, 3100]`.
   - KPI "Estoque Critico" exibe `'—'` com comentário `mock enquanto endpoint nao existe`.
   - Botões "Imprimir", "Exportar CSV" e "Gerar PDF Diario" não têm ação vinculada.
   - Links "Ver fila completa" e "Gerar OP" apontam para `producao.html` (tela legada quebrada) em vez de `ordens_producao.html` / `planejamento.html`; "Novo Cliente" aponta para `vendas.html` em vez de `clientes.html`.
2. **`frontend/producao.html` é uma tela legada de Almoxarifado:**
   - Apesar do nome do arquivo, exibe título "Almoxarifado" com dados de demonstração de metalúrgica em fallback e ações que apenas alteram o array em memória sem salvar na API.
3. **`frontend/planejamento.html` possui handler inexistente e recursos do backend sem UI:**
   - Os selects `#alocar-dia-select` e `#alocar-colab-select` chamam `onchange="aoMudarDiaOuColab()"`, função não declarada no script (gera erro no console ao mudar os selects).
   - O cálculo de progresso no quadro (`totalAlocado / metaIndiv`) soma unidades brutas (`quantidade_planejada`) em vez de pontos (`quantidade_planejada * peso_produtividade`), diferente do backend (`validarCapacidade` e `obterPlanejamentoSemanal`).
   - Os endpoints existentes no backend de **Sugestão Semanal**, **MRP / Insumos da Semana**, **Validar Estoque da Semana**, **Validar Capacidade** e **Ficha de Trabalho (`ficha_trabalho.html`)** não possuem botões/acesso na interface do `planejamento.html`.
4. **Feedback de finalização e exibição de `PREPARO` em `frontend/ordens_producao.html`:**
   - Após finalizar uma OP, a linha 458 lê `data.produto?.nome` e `data.produto?.estoque_atual`, campos que não são retornados por `producaoController.finalizarOP` (exibe `"produto" atualizado para undefined un`).
   - OPs de `PREPARO` mostram `o.produto` (produto pai) e sufixo `un` no lugar de `o.receita_nome` e `kg`.
5. **Aprovação de orçamento sem escolha de pagamento (`frontend/orcamentos.html`):**
   - O modal de aprovação pede apenas `data_entrega`, não expondo `forma_pagamento`, `pagamento_tipo` (`A_VISTA`/`A_PRAZO`) e `data_vencimento` já suportados pelo endpoint `POST /api/comercial/orcamentos/:id/aprovar`.
6. **Inconsistência de `app-desktop/calculadora.html`:**
   - Lê `ficha_tecnica_insumos` e `ficha_tecnica_embalagens`, enquanto o cadastro atual em `produtos.html` preenche apenas `ficha_tecnica_receitas` e `embalagem_id`.
7. **Funcionalidades de Chão de Fábrica sem tela dedicada no frontend:**
   - `POST /api/producao/intercorrencia` (registro digital de paradas `M1`, `E1`, `P1`, `O1`) existe no backend, mas não possui tela/formulário no frontend (apenas tabela impressa em `ficha_trabalho.html`).
   - `POST /api/receitas/importar` existe no backend, sem botão na tela `receitas.html`.
   - `POST /api/producao/alocar` existe no backend, sem modal de criação manual de OP em `ordens_producao.html` ou `planejamento.html`.
   - Não existe autenticação/controle de usuários (avatar fixo `AD`), nem relatório de **DRE** ou **Apuração Real de CMV por período/venda** (mencionados na visão do `CONTEXTO_ERP.md`).
