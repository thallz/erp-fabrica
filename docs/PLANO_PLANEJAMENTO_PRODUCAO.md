# Plano Técnico — Unificação do Planejamento de Produção, Menus e Filtros Recolhíveis

**Módulo:** Produção (Planejamento Unificado + Impressões), Navegação Global e Padrão de Filtros  
**Alvo de Execução:** `/dev docs/PLANO_PLANEJAMENTO_PRODUCAO.md`  
**🤖 Modelo de IA Recomendado para o `/dev`:** `Gemini 4 Hydrogen (High)`, `Claude Sonnet 5.5 (Medium)` / `Claude Opus 5.5 (Medium)` ou `Orchestrator` *(mudança envolve migração de banco, regras em múltiplos controllers e atualização de ~18 telas HTML — evitar modelos Flash/leves)*

---

## 1. Visão Geral e Regras de Negócio Aprovadas

Este plano resolve a duplicidade e perda de visibilidade entre as telas `Fila de OPs` e `Painel do Maestro`, reorganiza o menu para proteger informações de custo/margem, padroniza os filtros recolhíveis em todo o ERP e implementa o fluxo de impressão para Cozinha (Massas/Recheios) e Produção (Colaborador):

1. **Reorganização do Menu Superior (Topbar Global):**
   - Mover **Produtos Finais** (`produtos.html`) da aba `📊 COMERCIAL` para `🏭 PRODUÇÃO` (protegendo fichas técnicas, custos e margens).
   - Manter em `📊 COMERCIAL`: *Vendas* (`vendas.html`), *Orçamentos* (`orcamentos.html`), *Clientes* (`clientes.html`) e *Estoque Pronta-Entrega* (`estoque_vendas.html` — consulta rápida da Câmara Fria sem custos/margens).
   - Em `🏭 PRODUÇÃO`: *Planejamento de Produção* (`planejamento.html` — tela única substituindo *Planejamento Maestro* e *Fila de OPs*), *Produtos Finais* (`produtos.html`), *Receitas (Preparos)* (`receitas.html`) e *Colaboradores* (`colaboradores.html`).
   - Atualizar atalhos do Dashboard (`index.html`): *"Ver fila completa"* e *"Gerar OP"* apontam para `planejamento.html`; *"Novo Cliente"* aponta para `clientes.html`.
   - Transformar `ordens_producao.html` em redirecionamento automático para `planejamento.html` (evita erro 404 caso algum link externo/favorito aponte para ela).

2. **Tela Única — Planejamento de Produção (`frontend/planejamento.html`):**
   - **Visão apenas de Produtos Finais (Opção A):** A fila e o quadro semanal passam a exibir **apenas as OPs de Produto Final (`MONTAGEM`)**, sem poluir a fila com sub-OPs automáticas de Massa e Recheio.
   - **Origem da OP (Cliente / Pedido / Data de Entrega):** Toda OP gerada a partir de venda carrega `pedido_id` (e detalhamento em `ordem_producao_origem`), exibindo no card: cliente, nº do pedido e data de entrega. OPs manuais exibem `🧊 Estoque / Pronta-Entrega`.
   - **Agrupamento Manual de OPs:** Usuário pode selecionar 2 ou mais OPs não programadas do **mesmo produto** e clicar em **Agrupar**, somando a `quantidade_planejada` em um único card de produção e preservando internamente a lista de clientes/pedidos/entregas de origem.
   - **Sem "sumiço" de OPs:** A coluna da esquerda (`OPs Sem Programação`) mostra **todas** as OPs sem `data_programada` ou sem `colaborador_id` com status `FILA` **ou** `PRODUZINDO`.
   - **Ações completas direto na OP:** No card (tanto na fila quanto alocado no colaborador) o usuário pode **Atribuir**, **Dividir**, **Iniciar Produção**, **Finalizar (enviar para Câmara Fria)**, **Devolver para a fila (`↩`)** e **Excluir (`🗑`)**.
   - **OPs Concluídas visíveis:** OPs finalizadas permanecem no quadro semanal com selo verde `🟢 Concluída` (somente leitura, sem botões de devolução/exclusão).
   - **Nova OP Manual:** Botão `+ Nova OP` na coluna da esquerda para criar OP avulsa para estoque.

3. **Semanas Úteis (Seg–Sex) com Virada Automática no Sábado:**
   - Quadro semanal exibe 5 colunas (**Segunda a Sexta**).
   - Setas no topo: `◀ Semana Anterior`, botão `Semana Atual` (exibindo intervalo `DD/MM a DD/MM`) e `Próxima Semana ▶`.
   - **Regra de virada automática:** De Segunda a Sexta, abre na semana corrente; ao chegar **Sábado ou Domingo**, abre automaticamente na **próxima semana útil** (próxima Segunda a Sexta).
   - Cálculos de data devem operar em calendário local (`YYYY-MM-DD`) sem deslocamento por conversão UTC (`toISOString()`).

4. **Meta do Colaborador em Unidades Simples:**
   - A barra de progresso diária e a validação de capacidade passam a contar **unidades simples** (`SUM(quantidade_planejada)`), comparadas diretamente com `colaborador.meta_diaria_individual` (removendo a multiplicação por `peso_produtividade`).
   - Faixas visuais da barra: verde (`< 80%`), amarelo (`80% a 100%`), vermelho (`> 100%`).

5. **Impressões A4 (Cozinha/Massas/Recheios e Produção/Colaborador):**
   - **Ficha de Massas e Recheios (Cozinha):** A partir das OPs de salgados planejadas no dia ou na semana, o sistema explode automaticamente `ficha_tecnica_receita` + `receita_item` (incluindo sub-receitas em cascata) e gera folha A4 separando:
     - **Recheios e Molhos (Preparo D-1 / Véspera)** e **Massas (Preparo D+0 / Dia da Montagem)**,
     - Peso total necessário de cada preparo (`kg`), divisão sugerida em panelas de `10 kg`, e lista consolidada de ingredientes em `kg`/`g` para pesagem.
     - Disponível nos modos **Do Dia** e **Da Semana**.
   - **Ficha de Produção (Colaborador):** Impressão A4 **do Dia** (no card do colaborador/dia) e **da Semana (Seg–Sex)** por colaborador, listando os salgados alocados (com origem/cliente), referência de massa/recheio necessário, campos manuais de *Produção Realizada* e *Perdas*, e tabela de intercorrências (`M1`, `E1`, `P1`, `O1`).

6. **Baixa Integrada ao Finalizar OP:**
   - Como não há sub-OPs automáticas de `PREPARO` na fila, ao finalizar a OP do salgado (`PUT /api/producao/op/:id/finalizar`), o backend explode as receitas da ficha técnica até os insumos base, dá baixa no Almoxarifado (`insumo.estoque_atual`) com Kardex (`SAIDA` / `CONSUMO_PRODUCAO`), dá baixa na embalagem (`produto.embalagem_id`) com Kardex e credita o produto acabado na Câmara Fria (`produto.estoque_atual`) com Kardex (`ENTRADA` / `PRODUCAO_CONCLUIDA`).

7. **Filtro Recolhível (`Todos ▾`) em Todo o Sistema:**
   - Substituir as pílulas estáticas abertas por um componente dropdown compacto (`Todos ▾` / exibe o filtro selecionado) em: `planejamento.html`, `vendas.html`, `orcamentos.html`, `contas_receber.html` e `contas_pagar.html`.

---

## 2. Alterações no Banco de Dados (Tabelas e Colunas)

Atualizar `backend/src/config/migrate.js` (e espelhar em `backend/init.sql`):

### 2.1 Alterações na tabela `ordem_producao`
| Coluna | Tipo | Regra / Default | Finalidade |
| :--- | :--- | :--- | :--- |
| `pedido_id` | `INT REFERENCES pedido(id) ON DELETE SET NULL` | `NULL` | Identifica o pedido de venda que originou a OP (`NULL` se avulsa ou agrupada) |
| `agrupada` | `BOOLEAN` | `DEFAULT FALSE` | Indica se a OP consolidou múltiplas OPs de origem |

### 2.2 Nova tabela `ordem_producao_origem`
Rastreia exatamente quais clientes/pedidos compõem uma OP (seja ela única ou agrupada manualmente):

| Coluna | Tipo | Restrição | Finalidade |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Identificador do vínculo |
| `ordem_producao_id` | `INT` | `NOT NULL REFERENCES ordem_producao(id) ON DELETE CASCADE` | OP dona do lote |
| `pedido_id` | `INT` | `REFERENCES pedido(id) ON DELETE SET NULL` | Pedido B2B de origem (`NULL` se estoque) |
| `cliente_id` | `INT` | `REFERENCES cliente(id) ON DELETE SET NULL` | Cliente do pedido (`NULL` se estoque) |
| `quantidade` | `INT` | `NOT NULL` | Quantidade daquele cliente/pedido dentro do lote |
| `data_entrega` | `DATE` | `NULL` | Data de entrega do pedido para referência no card |

---

## 3. Regras de Cálculo, Validações e Endpoints

### 3.1 Cálculo de Semana Útil (Seg–Sex com virada no Sábado)
- Função utilitária compartilhada (`calcularSemanaUtil(dataRef)`):
  - Se `diaSemana === 6` (Sábado): soma `+2` dias para apontar para a próxima Segunda.
  - Se `diaSemana === 0` (Domingo): soma `+1` dia para apontar para a próxima Segunda.
  - Se `diaSemana` de `1` a `5` (Seg–Sex): subtrai `(diaSemana - 1)` dias para achar a Segunda da semana atual.
  - `data_fim` = `data_inicio + 4` dias (Sexta-feira).
  - Formatar sempre manualmente `YYYY-MM-DD` usando `getFullYear()`, `getMonth() + 1`, `getDate()` (nunca `toISOString()`).

### 3.2 Geração e Vínculo de OPs (`comercialController.js` e `producaoController.js`)
- **`comercialController.processarLancamentoPedidoTransacional`:**
  - Remover chamada a `explodirEPrefabricarOPs` (não gerar OPs de `PREPARO`).
  - Inserir OP de `MONTAGEM` após criar o `pedido` (ou atualizar `pedido_id` da OP recém-criada logo após o `INSERT INTO pedido`) e inserir registro correspondente em `ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)`.
- **`producaoController.alocar` (`POST /api/producao/alocar`):**
  - Validar `produto_id` e `quantidade_planejada > 0` e presença de ficha técnica.
  - Inserir OP com `tipo_op = 'MONTAGEM'`, `status = 'FILA'`, `pedido_id = NULL`, `categoria_producao` vinda do produto.
- **`producaoController.listarFila` (`GET /api/producao/fila`):**
  - Retornar também `op.pedido_id`, `op.agrupada`, `ped.data_entrega`, `cli.razao_social AS cliente_nome` e `origens` (agregado JSON de `ordem_producao_origem` com `pedido_id`, `cliente_id`, `razao_social`, `quantidade`, `data_entrega`).
- **`producaoController.excluirOP` + rota `DELETE /api/producao/op/:id`:**
  - Registrar `router.delete('/op/:id', producaoController.excluirOP)` em `producaoRoutes.js`.
  - Se `status === 'CONCLUIDA'`, retornar `400` impedindo exclusão (estoque já creditado/baixado). Caso contrário, deletar a OP (`CASCADE` limpa `ordem_producao_origem`).

### 3.3 Agrupamento de OPs (`POST /api/planejamento/agrupar-ops`)
- Entrada: `{ ops_ids: [id1, id2, ...] }`.
- Validações (em transação `BEGIN/COMMIT` com `FOR UPDATE`):
  - Pelo menos 2 IDs válidos.
  - Todas as OPs devem existir, ter `status = 'FILA'`, e possuir o **mesmo `produto_id`**.
- Execução:
  - Soma `quantidade_planejada` total.
  - Mantém a primeira OP (ou cria nova OP consolidada) com `agrupada = TRUE`, `pedido_id = NULL`, `quantidade_planejada = soma`.
  - Para cada OP absorvida: se já tinha linhas em `ordem_producao_origem`, move `ordem_producao_id` para a OP consolidada; se não tinha (ex.: OP avulsa de estoque), insere `{ ordem_producao_id, pedido_id: op.pedido_id, cliente_id: null, quantidade: op.quantidade_planejada }`.
  - Exclui as demais OPs absorvidas.

### 3.4 Planejamento Semanal e Meta em Unidades (`planejamentoController.js`)
- **`planejamentoController.validarCapacidade` e `producaoController.planejarProducao`:**
  - Somar `SUM(op.quantidade_planejada)` (sem multiplicar por `peso_produtividade`) e comparar com `colaborador.meta_diaria_individual`.
- **`planejamentoController.obterPlanejamentoSemanal` (`GET /api/planejamento/semanal`):**
  - Usar `calcularSemanaUtil` quando `data_inicio`/`data_fim` não forem enviados.
  - Buscar OPs com `op.status IN ('FILA', 'PRODUZINDO', 'CONCLUIDA')` e retornar `status`, `data_programada`, `pedido_id`, `agrupada`, `cliente_nome`, `data_entrega` e `origens` no objeto de cada OP.
  - `total_unidades` = soma de `quantidade_planejada` das OPs alocadas ao colaborador no dia.
- **`planejamentoController.agendarOP` e `producaoController.agendarOP`:**
  - Apenas atualizar `data_programada` e `colaborador_id` na OP (remover geração de sub-OPs de `PREPARO`).
  - Se `colaborador_id` e `data_programada` forem enviados, opcionalmente retornar aviso caso a soma de unidades no dia ultrapasse `meta_diaria_individual` (sem bloquear o agendamento).

### 3.5 Baixa de Estoque ao Finalizar OP (`producaoController.finalizarOP`)
- Manter execução transacional (`BEGIN/COMMIT` com `FOR UPDATE`):
  - Para cada receita em `ficha_tecnica_receita` do `produto_id`, calcular `pesoReceitaKg = quantidade_necessaria * qtdPlanejada` e explodir recursivamente `receita_item` até chegar nos insumos (`tipo_origem = 'materia'`), acumulando o total de cada `insumo_id` em kg.
  - Deduzir os insumos acumulados de `insumo.estoque_atual` (registrando `SAIDA` / `CONSUMO_PRODUCAO` em `movimentacao_estoque`).
  - Deduzir insumos diretos de `ficha_tecnica_insumo` (se houver) e embalagem de `produto.embalagem_id` (`Math.ceil(qtdPlanejada / capacidade_embalagem)`) com Kardex.
  - Creditar `produto.estoque_atual` na Câmara Fria com Kardex (`ENTRADA` / `PRODUCAO_CONCLUIDA`).
  - Atualizar OP para `status = 'CONCLUIDA'`, `data_fim = CURRENT_TIMESTAMP`, `quantidade_realizada = qtdPlanejada`.
  - Retornar no JSON: `{ status: 'sucesso', mensagem: '...', op: updatedOp.rows[0], produto: { id, nome, estoque_atual: saldoPostProd } }`.

### 3.6 Endpoints de Impressão (Cozinha & Colaborador)
- **`GET /api/planejamento/mapa-preparo?data_inicio=YYYY-MM-DD&data_fim=YYYY-MM-DD`:**
  - Busca OPs planejadas no período (`data_programada BETWEEN data_inicio AND data_fim`, `status IN ('FILA', 'PRODUZINDO')`, `colaborador_id IS NOT NULL`).
  - Explode `ficha_tecnica_receita` de cada OP e consolida por `receita_id`:
    - `receita_id`, `nome`, `categoria` (`Recheio`, `Molho`, `Massa`, etc.),
    - `turno_sugerido`: `'D-1 (Véspera)'` se `Recheio`/`Molho`, ou `'D+0 (Dia da Montagem)'` para `Massa`/demais,
    - `peso_total_kg`, `instrucao_batelada` (panelas de `10 kg`),
    - `ingredientes`: lista consolidada de insumos diretos/sub-receitas em `kg` (e `g` quando `< 1 kg`),
    - `produtos_vinculados`: resumo de quais salgados/datas usam aquele preparo.
- **`GET /api/planejamento/ficha/:colaborador_id/:data` (Diária) e `GET /api/planejamento/ficha-semana/:colaborador_id?data_inicio=...&data_fim=...` (Semanal):**
  - Retorna dados do colaborador (`nome`, `meta_diaria_individual`), período, e OPs alocadas por dia com: `op_id`, `produto_nome`, `quantidade_total` (`un`), `status`, `origens` (cliente/pedido), e `receitas_requeridas` (`Massa` e `Recheio`/`Molho` em `kg` apenas para referência de bancada).

---

## 4. Checklist de Execução (Para o `/dev`)

- [x] **Etapa 1 — Banco de Dados (`migrate.js` e `init.sql`)**
  - [x] Adicionar colunas `pedido_id` e `agrupada` na tabela `ordem_producao`.
  - [x] Criar tabela `ordem_producao_origem` com índices por `ordem_producao_id` e `pedido_id`.
  - [x] Garantir que `runMigrations()` rode de forma idempotente ao subir o servidor.

- [x] **Etapa 2 — Backend: Rotas e Controllers de Produção, Comercial e Planejamento**
  - [x] Adicionar `router.delete('/op/:id', producaoController.excluirOP)` em `backend/src/routes/producaoRoutes.js` e impedir exclusão de OP `CONCLUIDA` em `producaoController.excluirOP`.
  - [x] Atualizar `comercialController.js` (`processarLancamentoPedidoTransacional`) para **não** chamar `explodirEPrefabricarOPs`, vincular `pedido_id` à OP criada e gravar `ordem_producao_origem`.
  - [x] Atualizar `producaoController.listarFila` para incluir `pedido_id`, `agrupada`, `data_entrega`, `cliente_nome` e `origens`.
  - [x] Atualizar `producaoController.finalizarOP` para explodir receitas em cascata deduzindo insumos direto do Almoxarifado (Kardex), deduzir embalagem, creditar Câmara Fria e retornar `produto: { id, nome, estoque_atual }`.
  - [x] Atualizar `planejamentoController.js`: helper de semana útil (virada no Sábado), meta em unidades simples (sem `peso_produtividade`), remoção de criação de sub-OPs de `PREPARO` em `agendarOP`/`aplicarSugestao`, `obterPlanejamentoSemanal` trazendo `FILA`, `PRODUZINDO` e `CONCLUIDA` com `origens`.
  - [x] Implementar `POST /api/planejamento/agrupar-ops` em `planejamentoRoutes.js` e `planejamentoController.js`.
  - [x] Implementar `GET /api/planejamento/mapa-preparo` e `GET /api/planejamento/ficha-semana/:colaborador_id` (e ajustar `obterFichaTrabalho` diária) em `planejamentoRoutes.js` e `planejamentoController.js`.

- [x] **Etapa 3 — Validação do Backend**
  - [x] Subir/testar API e validar via script de teste (criação de pedido -> OP única com cliente; criação de OP manual; agrupamento de 2 OPs mantendo clientes de origem; agendamento Seg–Sex + virada de Sábado; finalização baixando insumos no Almoxarifado e creditando Câmara Fria; endpoints de `mapa-preparo`, `ficha` e `ficha-semana`; exclusão de OP).
  - [x] Rodar os testes existentes em `backend/test_*.js` (ajustando eventual asserção que esperava sub-OP de `PREPARO` automática, se aplicável, documentando o ajuste).

- [x] **Etapa 4 — Menus Globais, Dashboard e Filtro Recolhível (`global.css` + HTMLs)**
  - [x] Criar estilos padronizados do filtro dropdown recolhível (`Todos ▾`) em `frontend/css/global.css`.
  - [x] Atualizar a topbar em **todas** as páginas de `frontend/` (incluindo `estoque_vendas.html`):
    - `📊 COMERCIAL`: Vendas, Orçamentos, Clientes, Estoque Pronta-Entrega (`estoque_vendas.html`).
    - `🏭 PRODUÇÃO`: Planejamento de Produção (`planejamento.html`), Produtos Finais (`produtos.html`), Receitas (`receitas.html`), Colaboradores (`colaboradores.html`).
  - [x] Atualizar atalhos de `frontend/index.html` (`planejamento.html` e `clientes.html`).
  - [x] Atualizar `frontend/ordens_producao.html` para redirecionar imediatamente para `planejamento.html`.
  - [x] Aplicar o componente de filtro recolhível (`Todos ▾`) em `vendas.html`, `orcamentos.html`, `contas_receber.html` e `contas_pagar.html`.

- [x] **Etapa 5 — Tela Unificada `frontend/planejamento.html` e Impressões A4**
  - [x] Implementar barra de navegação semanal no topo (`◀ Semana Anterior` | `Semana DD/MM a DD/MM` | `Próxima Semana ▶`) com virada automática no Sábado/Domingo e sem bug de UTC.
  - [x] Implementar coluna esquerda `OPs Sem Programação` exibindo `FILA` e `PRODUZINDO`, com filtro recolhível `Todos ▾`, botão `+ Nova OP` (modal), checkboxes + botão `🔗 Agrupar` (mesmo produto), exibição de Cliente/Pedido/Entrega (ou lista agrupada / `🧊 Estoque`) e botões `Atribuir`, `Dividir`, `Iniciar`/`Finalizar` e `Excluir`.
  - [x] Implementar quadro Seg–Sex por colaborador com barra de meta em unidades simples, selo de status (`Aguardando`, `Produzindo`, `Concluída`), ações inline (`Iniciar`, `Finalizar`, `↩ Devolver`, `🗑 Excluir`), e botão `🖨️ Dia` por colaborador/dia + botão `🖨️ Semana` por colaborador.
  - [x] Adicionar botões no topo para `🖨️ Massas & Recheios (Semana)` e `🖨️ Massas & Recheios (Dia)`.
  - [x] Atualizar `frontend/ficha_trabalho.html` (e/ou criar modo `?modo=preparo` / `?modo=semana`) para renderizar em A4 limpo: (a) Ficha Diária do Colaborador, (b) Ficha Semanal do Colaborador, e (c) Mapa de Massas e Recheios (D-1 e D+0) para a Cozinha.
  - [x] Remover a chamada quebrada `aoMudarDiaOuColab()` ou substituí-la por prévia real de capacidade em unidades no modal de atribuição.

- [x] **Etapa 6 — Validação Ponta a Ponta**
  - [x] Testar fluxo completo no navegador (`http://localhost:3001/planejamento.html`): criar OP manual e por venda, agrupar OPs de clientes diferentes, atribuir no quadro, navegar semanas, iniciar, devolver para fila, excluir, finalizar OP verificando baixa no Kardex do Almoxarifado e entrada na Câmara Fria, e testar as 3 impressões A4 + filtros `Todos ▾` em todas as telas + links do menu.
