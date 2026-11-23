# Plano Técnico — Fluxo Integrado Vendas ↔ Produção ↔ Entrega ↔ Faturamento

**Módulo:** Comercial (Vendas/Orçamentos) + Produção + Câmara Fria + Contas a Receber  
**Alvo de Execução:** `/dev docs/PLANO_VENDAS_PRODUCAO_FATURAMENTO.md`  
**🤖 Modelo de IA Recomendado para o `/dev`:** `Gemini 4 Hydrogen (High)` ou `Claude Opus 5.5 (Medium)` *(envolve migração de banco, regras matemáticas de balanço global de estoque, integração entre 4 controllers e reestruturação completa da tela `vendas.html`)*

---

## 1. Visão Geral e Regras de Negócio Aprovadas

Este plano conecta de ponta a ponta os módulos **Comercial**, **Produção (Planejamento)**, **Câmara Fria (Kardex)** e **Financeiro (Contas a Receber)**, além de incluir o ajuste de contexto no `+ Atribuir OP` do Planejamento:

1. **Separação Real de Etapas (Comercial → Produção → Expedição/NF-e → Financeiro):**
   - **Criar Pedido:** Registra cliente, itens, data de entrega e tipo (`ENTREGA` ou `RETIRADA`). **Não** dá baixa na Câmara Fria e **não** gera cobrança no Financeiro nesse momento.
   - **Geração de OPs sem travar entregas urgentes:**
     - **`ENTREGA` (Entrega Programada):** Usa o **Balanço Global** (`Estoque Físico + OPs abertas - Demanda de Pedidos abertos`) para gerar OP apenas do que falta produzir na carteira. Assim, um pedido futuro (ex.: Sexta) **não** prende fisicamente o estoque para um pedido mais urgente (ex.: Quarta).
     - **`RETIRADA` (Retirada Imediata / Balcão):** **Nunca** gera OP — valida na hora se há saldo físico livre na Câmara Fria e bloqueia o lançamento se não houver.
   - **Prioridade Visual por Data de Entrega:** Na listagem de Vendas, os pedidos abertos disputam o saldo físico da Câmara Fria ordenados por `data_entrega ASC` (e `RETIRADA` primeiro):
     - Se 100% dos itens estão disponíveis na Câmara Fria → **`🔵 Pronto p/ Entrega`** (pronto para montar rota).
     - Se falta algum item → **`🟡 Aguardando Produção`** (mostrando exatamente o que falta).
   - **Entregar (`🚚 Entregar` — Expedição / futura NF-e):** Só permite clicar quando 100% dos itens estiverem fisicamente na Câmara Fria. Ao confirmar, realiza a **baixa definitiva** na Câmara Fria com registro no Kardex (`VENDA_PEDIDO`).
   - **Faturar (`💰 Faturar` — Financeiro):** Liberado após a entrega (`ENTREGUE`). Permite lançar **À Vista** (`PIX`/`DINHEIRO`/`CARTAO` → cria título já `RECEBIDO`) ou **A Prazo** (`BOLETO`/`PIX` com vencimento → cria título `PENDENTE` em Contas a Receber).
   - **Concluído (`🟢 Concluído`):** O pedido **só** assume status `CONCLUIDO` automaticamente quando as duas pontas estiverem OK: **Entrega realizada (`estoque_baixado = TRUE`) E Pagamento confirmado (`conta_receber.status = 'RECEBIDO'`)**.

2. **Travas de Segurança e Edição:**
   - **Exclusão de OP vinculada a Pedido:** **Bloqueada** no Planejamento. OPs geradas por pedido só saem da fila se o pedido for cancelado (ou editado antes da programação).
   - **Edição de Pedido (`✏️ Editar`):**
     - **Bloqueada** se alguma OP do pedido já estiver **programada no Planejamento** (`colaborador_id IS NOT NULL AND data_programada IS NOT NULL` e `status !== 'CONCLUIDA'`), para não bagunçar a produção.
     - **Bloqueada** após o pedido ser **Entregue** ou **Faturado**.
     - **Liberada** enquanto a OP ainda está na fila sem programar **ou** após todas as OPs terem sido concluídas: ao reduzir/remover um item já produzido, o salgado permanece livre na Câmara Fria; ao adicionar/aumentar quantidade após produção concluída, valida se há saldo disponível para entrega.
   - **Cancelamento (`❌ Cancelar`) antes da Entrega:** Remove OPs ainda não concluídas vinculadas exclusivamente ao pedido; se alguma OP já tiver sido concluída, os salgados ficam livres na Câmara Fria; cancela eventual título pendente.

3. **Ocorrência / Devolução Pós-Entrega (`↩️ Ocorrência / Devolução`) e Carteira de Crédito:**
   - Para casos em que o pedido já saiu (`ENTREGUE`/`CONCLUIDO`), mas parte das unidades voltou boa ou estragou no transporte:
     - **Condição física:** `Voltou boa (Retorna para Câmara Fria)` (credita estoque + Kardex `ENTRADA` / `DEVOLUCAO_VENDA`) **ou** `Estragou no transporte (Perda)` (não retorna ao estoque bom; registra ocorrência de perda).
     - **Ação financeira/reposição:**
       - **`Abater do valor / Gerar Crédito`:**
         - Se o pedido **ainda não foi faturado**: abate direto no `valor_total` líquido do pedido (para já faturar no valor certo).
         - Se **já foi faturado no `BOLETO` ou já foi `RECEBIDO` (pago)**: **mantém o valor cheio do boleto/título** (não altera nem cancela boleto bancário já emitido!) e gera **Crédito para o Cliente** (`saldo_credito`) no valor abatido, para ser descontado no próximo pedido.
         - Se **já foi faturado em `PIX` / `DINHEIRO` / `CARTAO` ainda `PENDENTE`**: permite escolher entre **Abater direto no título pendente** ou **Manter cheio e gerar Crédito para o próximo pedido**.
       - **`Gerar reposição`:** mantém valor cheio do pedido e gera OP de reposição na fila.
     - **Uso do Crédito no Próximo Faturamento (`💰 Faturar`):** Se o cliente possuir `saldo_credito > 0`, o modal de faturamento exibe o saldo disponível com opção `[x] Abater crédito neste faturamento`, descontando do título gerado em `conta_receber` (sem duplicar entrada no caixa).

4. **Ajuste no Planejamento (`+ Atribuir OP` contextual):**
   - Ao clicar em `+ Atribuir OP` dentro do card de um colaborador/dia (ex.: *João na Terça*), o pop-up exibe **fixo** o colaborador e o dia clicados (sem repetir os dois selects), mostrando apenas a escolha da(s) OP(s) da fila.

---

## 2. Estrutura do Banco de Dados (`migrate.js` e `init.sql`)

### 2.1 Alterações na tabela `pedido`
| Coluna | Tipo | Default / Regra | Finalidade |
| :--- | :--- | :--- | :--- |
| `tipo_pedido` | `VARCHAR(20)` | `DEFAULT 'ENTREGA' CHECK (tipo_pedido IN ('ENTREGA', 'RETIRADA'))` | Diferencia pedido com produção/entrega vs. retirada imediata |
| `estoque_baixado` | `BOOLEAN` | `DEFAULT FALSE` | Controla se a baixa física na Câmara Fria já ocorreu na entrega |
| `data_entrega_efetiva` | `TIMESTAMP` | `NULL` | Data/hora real em que `🚚 Entregar` foi confirmado |
| `faturado` | `BOOLEAN` | `DEFAULT FALSE` | Indica se o título financeiro (`💰 Faturar`) já foi lançado |
| `observacao` | `TEXT` | `NULL` | Observações comerciais/logísticas do pedido |

> **Valores de `pedido.status`:** `'ABERTO'`, `'ENTREGUE'`, `'CONCLUIDO'`, `'CANCELADO'`, `'DEVOLVIDO'` (mantendo compatibilidade retroativa na migração convertendo `'CRIADO'`/`'PRODUZINDO'` legados sem baixa para `'ABERTO'` e `'FATURADO'` legado para `'ENTREGUE'`).

### 2.2 Alterações na tabela `item_pedido`
| Coluna | Tipo | Default | Finalidade |
| :--- | :--- | :--- | :--- |
| `quantidade_avariada` | `INT` | `DEFAULT 0` | Registra total de unidades com ocorrência de avaria/devolução |

### 2.3 Nova tabela `ocorrencia_entrega`
| Coluna | Tipo | Restrição | Finalidade |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Identificador da ocorrência |
| `pedido_id` | `INT` | `NOT NULL REFERENCES pedido(id) ON DELETE CASCADE` | Pedido afetado |
| `produto_id` | `INT` | `NOT NULL REFERENCES produto(id) ON DELETE RESTRICT` | Produto afetado |
| `quantidade` | `INT` | `NOT NULL CHECK (quantidade > 0)` | Quantidade devolvida ou avariada |
| `condicao_produto` | `VARCHAR(20)` | `NOT NULL CHECK (condicao_produto IN ('BOM', 'AVARIADO'))` | Volta p/ Câmara Fria (`BOM`) ou perda no transporte (`AVARIADO`) |
| `acao_financeira` | `VARCHAR(20)` | `NOT NULL CHECK (acao_financeira IN ('ABATER_VALOR', 'GERAR_CREDITO', 'REPOR_PRODUTO'))` | Abate direto, gera crédito ao cliente (padrão p/ Boleto/Pago) ou gera OP de reposição |
| `valor_abatido` | `DECIMAL(10, 2)` | `DEFAULT 0.00` | Valor abatido ou convertido em crédito quando `ABATER_VALOR`/`GERAR_CREDITO` |
| `op_reposicao_id` | `INT` | `REFERENCES ordem_producao(id) ON DELETE SET NULL` | OP gerada quando `REPOR_PRODUTO` |
| `observacao` | `TEXT` | `NULL` | Motivo/detalhe da ocorrência |
| `criado_em` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Carimbo de data/hora |

### 2.4 Carteira de Crédito do Cliente (`cliente.saldo_credito`, `conta_receber.credito_utilizado` e `credito_cliente_mov`)
- Na tabela `cliente`: adicionar `saldo_credito DECIMAL(10, 2) DEFAULT 0.00`.
- Na tabela `conta_receber`: adicionar `credito_utilizado DECIMAL(10, 2) DEFAULT 0.00` (valor abatido por crédito no faturamento).
- Nova tabela **`credito_cliente_mov`**:

| Coluna | Tipo | Restrição | Finalidade |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Identificador do movimento de crédito |
| `cliente_id` | `INT` | `NOT NULL REFERENCES cliente(id) ON DELETE CASCADE` | Cliente dono do crédito |
| `pedido_id` | `INT` | `REFERENCES pedido(id) ON DELETE SET NULL` | Pedido que originou ou consumiu o crédito |
| `ocorrencia_id` | `INT` | `REFERENCES ocorrencia_entrega(id) ON DELETE SET NULL` | Ocorrência de origem (quando `CREDITO`) |
| `tipo` | `VARCHAR(10)` | `NOT NULL CHECK (tipo IN ('CREDITO', 'USO'))` | Entrada de crédito ou utilização em faturamento |
| `valor` | `DECIMAL(10, 2)` | `NOT NULL CHECK (valor > 0)` | Valor movimentado |
| `saldo_anterior` | `DECIMAL(10, 2)` | `NOT NULL` | Saldo antes da operação |
| `saldo_posterior` | `DECIMAL(10, 2)` | `NOT NULL` | Saldo após a operação |
| `observacao` | `TEXT` | `NULL` | Detalhe auditável |
| `criado_em` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Carimbo de data/hora |

---

## 3. Regras de Cálculo, Validações e Endpoints

### 3.1 Lançamento de Pedido (`POST /api/comercial/pedidos` e `POST /api/comercial/orcamentos/:id/aprovar`)
- **Não** altera `produto.estoque_atual` nem insere em `conta_receber`.
- Insere `pedido` com `status = 'ABERTO'`, `estoque_baixado = FALSE`, `faturado = FALSE`.
- **Para `tipo_pedido = 'RETIRADA'`:**
  - Calcula `reservadoRetirada = SUM(ip.quantidade)` de pedidos `'RETIRADA'` com `status = 'ABERTO'` e `estoque_baixado = FALSE`.
  - Se `(produto.estoque_atual - reservadoRetirada) < item.quantidade`, faz `ROLLBACK` e retorna `400` informando saldo disponível insuficiente para retirada imediata.
- **Para `tipo_pedido = 'ENTREGA'`:**
  - Calcula para cada produto (com `FOR UPDATE` em `produto`):
    - `estoqueFisico = produto.estoque_atual`
    - `opsAbertas = SUM(quantidade_planejada)` em `ordem_producao` onde `produto_id = item.produto_id AND status IN ('FILA', 'PRODUZINDO')`
    - `demandaAbertos = SUM(ip.quantidade)` em `item_pedido` + `pedido` onde `pedido.status = 'ABERTO' AND pedido.estoque_baixado = FALSE` (já incluindo ou somando antes de inserir o novo item)
    - `cobertura = estoqueFisico + opsAbertas - demandaAbertos`
    - `faltaProduzir = Math.max(0, item.quantidade - Math.max(0, cobertura))`
  - Se `faltaProduzir > 0`: insere 1 OP (`MONTAGEM`, `FILA`, `pedido_id`) e vincula em `ordem_producao_origem`.

### 3.2 Listagem e Cálculo Dinâmico de Status (`GET /api/comercial/pedidos` e `GET /api/comercial/pedidos/:id`)
- Busca todos os pedidos e calcula em memória (a partir dos saldos atuais da Câmara Fria):
  - Simula alocação do estoque físico `saldoSimulado[produto_id] = produto.estoque_atual` percorrendo os pedidos `status = 'ABERTO'` ordenados por: `CASE WHEN tipo_pedido = 'RETIRADA' THEN 0 ELSE 1 END ASC`, `COALESCE(data_entrega, '9999-12-31') ASC`, `id ASC`.
  - Se todos os itens do pedido cabem em `saldoSimulado`: `status_fluxo = 'PRONTO_ENTREGA'` (e abate de `saldoSimulado`).
  - Caso contrário: `status_fluxo = 'AGUARDANDO_PRODUCAO'` e popula `itens_faltantes` com `{ produto_id, produto_nome, pedido_qtd, disponivel_fisico, falta }`.
  - Para `status = 'ENTREGUE'`:
    - Se `!faturado`: `status_fluxo = 'ENTREGUE_AGUARDANDO_FATURAMENTO'`
    - Se `faturado` e título `conta_receber.status !== 'RECEBIDO'`: `status_fluxo = 'ENTREGUE_AGUARDANDO_PAGAMENTO'`
  - Para `status = 'CONCLUIDO'`: `status_fluxo = 'CONCLUIDO'`.
  - Retorna também `pode_editar` (`boolean`) e `motivo_bloqueio_edicao` (`string | null`), verificando se existe OP vinculada programada no Planejamento (`colaborador_id IS NOT NULL AND data_programada IS NOT NULL AND status <> 'CONCLUIDA'`).

### 3.3 Edição de Pedido (`PUT /api/comercial/pedidos/:id`)
- Bloqueia (`400`) se `status !== 'ABERTO'` ou `estoque_baixado` ou `faturado`.
- Bloqueia (`400`) se existir OP vinculada já programada no Planejamento (`colaborador_id IS NOT NULL AND data_programada IS NOT NULL AND status <> 'CONCLUIDA'`).
- Se havia OPs vinculadas ainda não programadas (`FILA` e `data_programada IS NULL`): remove/recalcula as OPs pendentes desse pedido de acordo com a nova lista de itens e o balanço global atualizado.
- Se todas as OPs do pedido já estavam `CONCLUIDA`: ao adicionar/aumentar um item, valida se existe saldo físico disponível na Câmara Fria (`faltaProduzir === 0` ou `estoqueFisico >= aumento`); ao diminuir/remover um item, apenas atualiza `item_pedido` e `valor_total` (os salgados já produzidos permanecem livres na Câmara Fria).

### 3.4 Trava de Exclusão de OP de Venda (`producaoController.excluirOP`)
- Antes de deletar em `DELETE /api/producao/op/:id`, verifica se `ordem_producao.pedido_id` ou `ordem_producao_origem` aponta para algum pedido com `status NOT IN ('CANCELADO', 'DEVOLVIDO')`.
- Se apontar, retorna `400`: *"Esta OP está vinculada ao(s) Pedido(s) #X. Para cancelá-la, cancele ou edite o Pedido em Vendas."*

### 3.5 Entrega do Pedido (`POST /api/comercial/pedidos/:id/entregar`)
- Em transação (`BEGIN/COMMIT` com `FOR UPDATE`):
  - Valida `pedido.status === 'ABERTO'` e `estoque_baixado === FALSE`.
  - Valida para **todos** os itens: `produto.estoque_atual >= item.quantidade`. Se faltar qualquer unidade, faz `ROLLBACK` e retorna `400` listando o que falta na Câmara Fria.
  - Deduz `item.quantidade` de `produto.estoque_atual` e registra `SAIDA` (`VENDA_PEDIDO`) no Kardex (`movimentacao_estoque`, `documento_ref = 'Pedido #ID'`).
  - Atualiza `pedido`: `status = 'ENTREGUE'`, `estoque_baixado = TRUE`, `data_entrega_efetiva = CURRENT_TIMESTAMP`.

### 3.6 Faturamento (`POST /api/comercial/pedidos/:id/faturar`) e Baixa Automática (`financeiroController.receberConta`)
- **`POST /api/comercial/pedidos/:id/faturar`:**
  - Valida `pedido.status === 'ENTREGUE'` e `pedido.faturado === FALSE`.
  - Aceita `usar_credito` (`boolean`, opcional). Se `usar_credito === true`, bloqueia `cliente` com `FOR UPDATE`, calcula `creditoAplicado = Math.min(cliente.saldo_credito, pedido.valor_total)`:
    - Deduz `creditoAplicado` de `cliente.saldo_credito` e registra `USO` em `credito_cliente_mov`.
    - `valorCobrar = Number((pedido.valor_total - creditoAplicado).toFixed(2))`.
  - Se `valorCobrar === 0` (100% coberto pelo crédito): marca `pedido.faturado = TRUE` e `pedido.status = 'CONCLUIDO'` (sem gerar título aberto no banco; opcionalmente grava `conta_receber` quitada de R$ 0,00 ou apenas registra o `USO` + `observacao`).
  - Se `valorCobrar > 0`: gera 1 título em `conta_receber` no valor de `valorCobrar` (gravando `credito_utilizado = creditoAplicado`):
    - `A_VISTA` (`PIX`, `DINHEIRO`, `CARTAO`): `conta_receber.status = 'RECEBIDO'`, `data_recebimento = CURRENT_DATE`; atualiza `pedido.faturado = TRUE` e `pedido.status = 'CONCLUIDO'`.
    - `A_PRAZO` (`BOLETO`, `PIX`): exige `data_vencimento`; `conta_receber.status = 'PENDENTE'`; atualiza `pedido.faturado = TRUE` (mantém `pedido.status = 'ENTREGUE'`).
- **`financeiroController.receberConta` (`PUT /api/financeiro/contas-receber/:id/receber`):**
  - Ao baixar um título para `RECEBIDO`, se `conta_receber.pedido_id` estiver preenchido e o pedido tiver `estoque_baixado = TRUE`, atualiza automaticamente `pedido.status = 'CONCLUIDO'`.
- **`financeiroController.resumo`:**
  - Atualizar consulta de resumo para considerar os novos status (`ABERTO`, `ENTREGUE`, `CONCLUIDO`, `CANCELADO`, `DEVOLVIDO`) além dos dados de `conta_receber` e `conta_pagar`.

### 3.7 Cancelamento (`POST /api/comercial/pedidos/:id/cancelar`) e Ocorrência Pós-Entrega (`POST /api/comercial/pedidos/:id/ocorrencia`)
- **`POST /api/comercial/pedidos/:id/cancelar`:**
  - Permitido apenas se `estoque_baixado === FALSE` e `status === 'ABERTO'`.
  - Deleta OPs vinculadas com `status <> 'CONCLUIDA'` (e limpa `ordem_producao_origem`); OPs já `CONCLUIDA` permanecem intactas e os salgados continuam livres na Câmara Fria.
  - Cancela eventual `conta_receber` `PENDENTE` e marca `pedido.status = 'CANCELADO'`.
- **`POST /api/comercial/pedidos/:id/ocorrencia`:**
  - Permitido apenas se `estoque_baixado === TRUE` (`ENTREGUE` ou `CONCLUIDO`).
  - Valida `quantidade > 0` e `quantidade <= (item.quantidade - item.quantidade_avariada)`.
  - Se `condicao_produto === 'BOM'`: soma `+quantidade` em `produto.estoque_atual` e insere `ENTRADA` (`DEVOLUCAO_VENDA`) no Kardex.
  - Se `condicao_produto === 'AVARIADO'`: não altera Câmara Fria (já saiu na entrega; registra observação de perda no transporte).
  - Calcula `valorOcorrencia = Number((quantidade * item.preco_unitario).toFixed(2))`.
  - Regra financeira conforme `acao_financeira` e estado do título:
    - **Se `acao_financeira === 'REPOR_PRODUTO'`:** mantém `valor_total` do pedido e título intactos; cria OP de reposição na fila (`MONTAGEM`, `pedido_id`) vinculada em `ocorrencia_entrega.op_reposicao_id`.
    - **Se `acao_financeira === 'ABATER_VALOR'` ou `'GERAR_CREDITO'`:** atualiza `item_pedido.quantidade_avariada += quantidade`.
      - Se `!pedido.faturado`: abate `valorOcorrencia` direto de `pedido.valor_total` (se zerar, marca `pedido.status = 'DEVOLVIDO'`).
      - Se `pedido.faturado`: busca `conta_receber` do pedido.
        - Se o título for **`BOLETO`** ou já estiver **`RECEBIDO`**: **força/aplica `'GERAR_CREDITO'`** (mantém valor do boleto/título cheio sem cancelar nem alterar!) e credita `+valorOcorrencia` em `cliente.saldo_credito` + `credito_cliente_mov` (`CREDITO`).
        - Se o título estiver **`PENDENTE`** em **`PIX` / `DINHEIRO` / `CARTAO`**: respeita a escolha do usuário: se `'ABATER_VALOR'`, deduz `valorOcorrencia` de `conta_receber.valor` e de `pedido.valor_total` (cancelando o título se zerar); se `'GERAR_CREDITO'`, mantém título cheio e credita `+valorOcorrencia` em `cliente.saldo_credito` + `credito_cliente_mov`.

---

## 4. Checklist de Execução (Para o `/dev`)

- [x] **Etapa 1 — Banco de Dados (`migrate.js` e `init.sql`)**
  - [x] Adicionar `tipo_pedido`, `estoque_baixado`, `data_entrega_efetiva`, `faturado` e `observacao` na tabela `pedido`.
  - [x] Adicionar `quantidade_avariada` na tabela `item_pedido`.
  - [x] Adicionar `saldo_credito` em `cliente` e `credito_utilizado` em `conta_receber`.
  - [x] Criar tabelas `ocorrencia_entrega` e `credito_cliente_mov` com índices por `pedido_id` e `cliente_id`.
  - [x] Migrar eventuais pedidos legados (`CRIADO`/`PRODUZINDO` -> `ABERTO`, `FATURADO` -> `ENTREGUE`) de forma idempotente.

- [x] **Etapa 2 — Backend: Regras de Vendas, Estoque, OPs, Crédito e Financeiro**
  - [x] Refatorar `comercialController.processarLancamentoPedidoTransacional` para **não** baixar Câmara Fria nem criar `conta_receber` na criação, aplicando Balanço Global (`ENTREGA`) vs. saldo físico livre (`RETIRADA`).
  - [x] Implementar cálculo de disponibilidade por prioridade de `data_entrega ASC` em `listarPedidos` e `obterPedido` (`AGUARDANDO_PRODUCAO` vs. `PRONTO_ENTREGA`, mais `pode_editar` e `saldo_credito` do cliente).
  - [x] Implementar trava de exclusão de OP vinculada a pedido ativo em `producaoController.excluirOP`.
  - [x] Implementar `PUT /api/comercial/pedidos/:id` (edição com trava durante OP programada no Planejamento e liberação pós-conclusão).
  - [x] Implementar `POST /api/comercial/pedidos/:id/entregar` (validação estrita de estoque físico + baixa definitiva no Kardex).
  - [x] Implementar `POST /api/comercial/pedidos/:id/faturar` (com opção de abater `saldo_credito` do cliente) e atualizar `financeiroController.receberConta` para marcar pedido como `CONCLUIDO` quando entrega e pagamento estiverem OK.
  - [x] Implementar `POST /api/comercial/pedidos/:id/cancelar` e `POST /api/comercial/pedidos/:id/ocorrencia` (devolução boa/avariada + manutenção do valor cheio do Boleto/Pago gerando Crédito ao cliente vs. abatimento direto vs. reposição).
  - [x] Atualizar `comercialRoutes.js` e `financeiroController.resumo`.

- [x] **Etapa 3 — Validação do Backend**
  - [x] Criar/rodar script de teste automatizado cobrindo: cenário 50/100/50 (Quarta vs. Sexta), venda `RETIRADA` bloqueando sem estoque, trava de exclusão de OP de pedido, trava de edição durante OP programada, entrega bloqueando sem estoque e baixando Câmara Fria, faturamento À Vista (`CONCLUIDO` imediato) e A Prazo (`ENTREGUE` -> baixa em Contas a Receber -> `CONCLUIDO`), cancelamento, ocorrência mantendo Boleto cheio + gerando Crédito ao cliente, e uso desse Crédito no faturamento do pedido seguinte.

- [x] **Etapa 4 — Frontend: `vendas.html`, `orcamentos.html`, `clientes.html` e Ajuste Contextual em `planejamento.html`**
  - [x] Atualizar `frontend/vendas.html`:
    - Novo Pedido com seleção `Entrega / Produção` vs `Retirada Imediata` (sem bloco financeiro na criação).
    - Substituir filtro recolhível para os novos status (`Todos`, `Aguardando Produção`, `Pronto p/ Entrega`, `Entregue (A Fat.)`, `Entregue (A Pag.)`, `Concluído`, `Cancelado/Devolvido`).
    - Substituir dropdown solto de status por botões de ação reais por status (`✏️ Editar`, `🚚 Entregar`, `💰 Faturar`, `❌ Cancelar`, `↩️ Ocorrência / Devolução`).
    - Modais de **Faturar** (exibindo crédito disponível do cliente com opção de desconto), **Editar Pedido** e **Ocorrência / Devolução** (orientando crédito automático quando for Boleto ou título já Pago).
  - [x] Atualizar `frontend/clientes.html` para exibir badge discreto de `🎁 Crédito disponível` quando `saldo_credito > 0`.
  - [x] Atualizar `frontend/orcamentos.html` (aprovação gera pedido no novo fluxo sem exigir financeiro antecipado).
  - [x] Atualizar `frontend/planejamento.html` no `+ Atribuir OP` do card do colaborador/dia para fixar o dia e colaborador clicados (mostrando apenas a seleção das OPs quando nenhuma estiver marcada na esquerda).

- [x] **Etapa 5 — Validação Ponta a Ponta**
  - [x] Testar todo o ciclo no navegador (`vendas.html` ↔ `planejamento.html` ↔ `estoque_produtos.html` ↔ `contas_receber.html`) confirmando que nenhum passo permite inconsistência de estoque ou financeiro.
