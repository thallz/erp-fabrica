# Plano Técnico — Simplificação do Planejamento de Produção e Pop-up de Impressão A4

**Módulo:** Produção (Ajustes de UX no Planejamento + Pop-up de Impressão Desktop A4)  
**Alvo de Execução:** `/dev docs/PLANO_AJUSTES_PLANEJAMENTO_IMPRESSAO.md`  
**🤖 Modelo de IA Recomendado para o `/dev`:** `Claude Sonnet 5.5 (Medium)` / `Claude Opus 5.5 (Medium)` ou `Gemini 4 Hydrogen (High)` *(refinamento focado em `planejamento.html`, `@media print` estilo pop-up desktop e endpoints de impressão/atribuição no `planejamentoController.js`)*

---

## 1. Visão Geral e Regras de Negócio Aprovadas

Este plano corrige os pontos de confusão identificados após o uso real da tela de **Planejamento de Produção**:

1. **Remoção de `Iniciar` e `Agrupar` (Fluxo Direto e Sem Poluição):**
   - **Sem botão `▶ Iniciar`:** Na fila e nos cards do quadro semanal, o fluxo passa a ser direto: a OP nasce `⏳ Aguardando` e é concluída em um único clique em **`✓ Concluir`** (com confirmação), que dá baixa nos insumos no Almoxarifado (Kardex) + embalagem e credita os salgados na Câmara Fria.
   - **Fila esquerda (`OPs Sem Programação`) enxuta:** Remove `▶ Iniciar`, `✓ Finalizar` e o botão `🔗 Agrupar` (e corrigir o `splitOP` para não duplicar origens antigas ao dividir). Cada card na fila exibe apenas: `#OP`, nome do produto, quantidade (`un`), origem (cliente/pedido/entrega ou `🧊 Estoque`), checkbox de seleção para atribuição, e apenas **3 botões**: `📅 Atribuir`, `✂️ Dividir` e `🗑`.
   - **Soma automática na impressão:** Mesmo existindo 2 ou mais OPs do mesmo produto para o mesmo colaborador no mesmo dia, a impressão soma automaticamente as quantidades daquele produto na folha do colaborador, dispensando agrupamento manual.

2. **Atribuição Flexível no `+ Atribuir OP` do Colaborador:**
   - Se o usuário **já tiver marcado** uma ou mais OPs nos checkboxes da coluna esquerda e clicar em `+ Atribuir OP` no card de um colaborador/dia, todas as OPs marcadas são atribuídas diretamente para aquele colaborador naquela data.
   - Se **nenhuma OP estiver marcada**, clicar em `+ Atribuir OP` no colaborador abre o modal listando todas as OPs disponíveis na fila para que o usuário **escolha** qual(is) deseja atribuir (nunca selecionando a primeira OP automaticamente à força).

3. **Remoção das 27 Impressoras dos Cards:**
   - Remover todos os botões `🖨️ Cozinha` dos cabeçalhos dos dias e todos os botões `🖨️ Dia` / `🖨️ Semana` dos cards de colaboradores.
   - Manter **apenas 3 botões limpos no topo** (barra da semana, à direita):
     - **`🖨️ Massas`**
     - **`🖨️ Recheios`**
     - **`🖨️ Colaboradores`**

4. **Pop-up Modal de Impressão Estilo Desktop (Sem Abrir Novas Guias/Janelas):**
   - Nunca usar `window.open(..., '_blank')` — compatível com App Desktop (Electron) e navegador sem gerar múltiplas guias/janelas.
   - Ao clicar em qualquer um dos 3 botões de impressão, abre um **Pop-up Modal de Pré-visualização de Impressão** sobre a própria tela com:
     - Barra/painel de configuração ao vivo (seleção de dias, colaborador, etc.).
     - Área de pré-visualização A4 exatamente como será impresso.
     - Botões **`Cancelar`** (fecha o modal e mantém o usuário na mesma tela/posição) e **`🖨️ Imprimir`** (dispara `window.print()` com `@media print` ocultando todo o ERP e imprimindo apenas as folhas A4 do pop-up).

5. **Conteúdo Exato de Cada Impressão A4:**
   - **`🖨️ Massas`:**
     - Seletor de dias com checkboxes (`Todos os dias` ou marcar individualmente `Seg`, `Ter`, `Qua`, `Qui`, `Sex`).
     - Exibe **somente Massas** necessárias para as OPs planejadas nos dias marcados, com peso total (`kg`), divisão em panelas de `10 kg` e tabela de ingredientes em `kg`/`g` com quadrinho de pesagem.
     - **Sem** Recheios, **sem** resumo consolidado de Almoxarifado e **sem** lista de pedidos/clientes.
   - **`🖨️ Recheios`:**
     - Mesmo seletor de dias (`Todos os dias` ou `Seg`..`Sex`).
     - Exibe **somente Recheios** (e Molhos/Temperos, tudo que não for Massa) necessários para as OPs nos dias marcados, com indicação de preparo `D-1 (Véspera)` quando aplicável, peso total (`kg`), panelas de `10 kg` e ingredientes em `kg`/`g`.
     - **Sem** Massas, **sem** resumo consolidado de Almoxarifado e **sem** pedidos/clientes.
   - **`🖨️ Colaboradores`:**
     - Configurador no pop-up: escolher **Colaborador** (`Todos os colaboradores (folhas separadas)` ou um colaborador específico) e **Modo** (`Semana inteira dividida por dias Seg–Sex` ou `Dia específico`).
     - Quando selecionar **Todos os colaboradores**, gera **uma folha A4 separada para cada colaborador** (com quebra de página `@media print { page-break-after: always; }`), garantindo que ninguém receba a folha de outro colega.
     - Conteúdo enxuto da folha do colaborador: Nome, Dia/Semana, Meta Diária, tabela com **Salgado/Produto** e **Quantidade (un)** (somando produtos iguais no mesmo dia) + colunas `Realizado` e `Perdas`, **Campo de Observações** (linhas pautadas) e **Assinatura**.
     - **Sem** pedidos/clientes, **sem** referência de peso de massa/recheio e **sem** tabela de intercorrências (`M1/E1/P1/O1`).

---

## 2. Alterações no Backend e Regras de Cálculo

### 2.1 `backend/src/controllers/planejamentoController.js`
1. **Endpoint `GET /api/planejamento/mapa-preparo`:**
   - Passar a aceitar parâmetro opcional `datas` (lista separada por vírgula, ex.: `datas=2026-11-23,2026-11-25`) além de `data_inicio` e `data_fim`.
   - Filtrar OPs planejadas (`colaborador_id IS NOT NULL`, `status IN ('FILA', 'PRODUZINDO')`) apenas nas datas solicitadas.
   - Retornar arrays claramente separados:
     - `massas`: receitas cuja categoria normalizada contenha `'massa'` (ex.: `Massa`).
     - `recheios`: receitas cuja categoria não seja `'massa'` (ex.: `Recheio`, `Molho`, `Tempero`, etc.).
   - Manter para cada preparo: `receita_id`, `nome`, `categoria`, `peso_total_kg`, `instrucao_batelada` (panelas de `10 kg`), e `ingredientes` consolidados (`nome`, `qtd_kg`, `exibicao` em `g` ou `kg`).
   - Remover necessidade de `insumos_consolidados` na impressão (ou manter no JSON sem exibir na folha).

2. **Endpoint `GET /api/planejamento/fichas-colaboradores` (novo) + ajuste em `obterFichaTrabalho` e `obterFichaTrabalhoSemana`:**
   - Aceitar `data_inicio`, `data_fim`, `datas` (opcional, para 1 dia ou dias específicos) e `colaborador_id` (opcional; se omitido ou `'TODOS'`, retorna lista de todos os colaboradores ativos que possuem OPs alocadas no período — ou todos os ativos se solicitado).
   - **Consolidação automática por produto no dia:** Para cada dia (`Seg`..`Sex`) de um colaborador, agrupar/somar OPs do mesmo `produto_id` somando `quantidade_planejada` (ex.: 2 OPs de Coxinha de `100` e `150` viram `{ produto_id, produto_nome, quantidade_total: 250 }`), sem incluir dados de pedido/cliente ou referência de massa/recheio.
   - Excluir OPs com `status = 'CONCLUIDA'` ou manter flag? *Padrão:* incluir OPs `FILA` e `PRODUZINDO` do dia/semana (e se o dia só tiver `CONCLUIDA`, não reimprimir como pendente — ou filtrar `status IN ('FILA', 'PRODUZINDO')`).

3. **Endpoint `POST /api/planejamento/agendar-lote` (novo, ou estender `agendar`):**
   - Permitir atribuir múltiplas OPs de uma vez (`{ ops_ids: [1, 2], data_programada, colaborador_id }`) em uma única transação SQL, facilitando quando o usuário marca várias OPs na coluna da esquerda e clica em `+ Atribuir OP` no card do colaborador.

4. **Correção de `splitOP` (`POST /api/planejamento/split-op`):**
   - Quando uma OP com registros em `ordem_producao_origem` for dividida (`qtd1` fica na original, `qtd2` vai para a nova), não clonar quantidades antigas em dobro:
     - Se houver apenas 1 origem, ajustar a quantidade da origem original para `qtd1` e inserir na nova OP com `qtd2`.
     - Se houver múltiplas origens (legado de agrupamento), ratear ou manter na nova OP apenas uma referência descritiva sem somar valores maiores que `qtd1`/`qtd2`.

### 2.2 `backend/src/routes/planejamentoRoutes.js`
- Registrar `router.post('/agendar-lote', planejamentoController.agendarLote);`
- Registrar `router.get('/fichas-colaboradores', planejamentoController.obterFichasColaboradores);`

---

## 3. Alterações no Frontend (`frontend/planejamento.html` e `frontend/ficha_trabalho.html`)

### 3.1 `frontend/planejamento.html`
1. **Barra superior (`semana-toolbar`):**
   - Lado esquerdo: `◀ Semana Anterior`, `📅 Semana DD/MM a DD/MM`, `Próxima Semana ▶`.
   - Lado direito: apenas 3 botões:
     - `🖨️ Massas` → `abrirPopupImpressao('massas')`
     - `🖨️ Recheios` → `abrirPopupImpressao('recheios')`
     - `🖨️ Colaboradores` → `abrirPopupImpressao('colaboradores')`

2. **Coluna Esquerda (`OPs Sem Programação`):**
   - Remover botão `🔗 Agrupar (...)`.
   - Manter checkboxes nos cards apenas para seleção múltipla de atribuição (com indicador opcional discreto ou texto *"Marque OPs e clique em + Atribuir OP no colaborador"*).
   - Remover botões `▶ Iniciar` e `✓ Finalizar` dos cards da fila esquerda. Deixar apenas:
     - `📅 Atribuir`
     - `✂️ Dividir`
     - `🗑` (com `confirm(...)` antes de excluir).

3. **Quadro Semanal (Seg–Sex):**
   - Remover `🖨️ Cozinha` dos cabeçalhos de dia.
   - Remover `🖨️ Dia` e `🖨️ Semana` dos cards de colaborador.
   - Nos cards das OPs atribuídas ao colaborador:
     - Remover botão `▶ Iniciar`.
     - Se `status !== 'CONCLUIDA'`, exibir: `✓ Concluir` (com `confirm(...)` antes de baixar estoque e creditar Câmara Fria), `✂️`, `↩` (devolver p/ fila) e `🗑` (com `confirm(...)`).
     - Se `status === 'CONCLUIDA'`, exibir apenas o selo verde `🟢 Concluída`.
   - No botão `+ Atribuir OP` do card do colaborador:
     - Se `opsSelecionadasSet.size > 0`: atribuir diretamente as OPs selecionadas para aquele `colaborador_id` e `dataStr` (via `POST /api/planejamento/agendar-lote`) e limpar seleção.
     - Se `opsSelecionadasSet.size === 0`: abrir o Modal de Atribuição no modo *"Escolher OP(s) da Fila para [Colaborador] em [Dia]"*, listando as OPs não programadas com checkboxes para o usuário marcar e confirmar (sem pré-selecionar a primeira automaticamente).

4. **Pop-up Modal de Impressão Estilo Desktop (em `planejamento.html`):**
   - Estrutura do Modal (`#print-modal-overlay`):
     - **Cabeçalho:** Título dinâmico (`Impressão de Massas`, `Impressão de Recheios` ou `Impressão de Colaboradores`) + botão `✕`.
     - **Painel de Opções (Lateral esquerda ou barra superior dentro do pop-up):**
       - Se `massas` ou `recheios`: checkboxes `[x] Todos os dias` e `[x] Seg`, `[x] Ter`, `[x] Qua`, `[x] Qui`, `[x] Sex` — ao alterar qualquer checkbox, recarrega `GET /api/planejamento/mapa-preparo?datas=...` e atualiza a pré-visualização A4 instantaneamente.
       - Se `colaboradores`:
         - Select de Colaborador (`Todos os colaboradores (1 folha cada)` ou colaborador individual).
         - Select/radio de Período: `Semana inteira (dividida por dias Seg–Sex)` ou `Dia específico` (mostra select dos 5 dias da semana).
         - Recarrega `GET /api/planejamento/fichas-colaboradores?...` e atualiza a pré-visualização A4 na hora.
     - **Área de Pré-visualização A4:** Container scrollável com fundo cinza (`#e5e7eb`) exibindo a(s) folha(s) A4 brancas com sombra.
     - **Rodapé:** Botão `Cancelar` (fecha o pop-up sem sair da tela) e `🖨️ Imprimir` (`window.print()`).
   - **Regras `@media print` em `planejamento.html`:**
     - Quando o pop-up de impressão estiver aberto, `@media print` oculta `.erp-shell` e todas as barras do modal, imprimindo **apenas** `#print-preview-sheets` em tamanho A4 (`@page { size: A4; margin: 12mm; }`), com `.sheet-page { page-break-after: always; }` (exceto a última folha) para que cada colaborador saia em folha separada.

---

## 4. Checklist de Execução (Para o `/dev`)

- [x] **Etapa 1 — Backend: Endpoints de Impressão Separada, Lote e Correção de Split**
  - [x] Atualizar `GET /api/planejamento/mapa-preparo` em `planejamentoController.js` para aceitar `datas=...` (dias específicos ou intervalo) e retornar `massas` e `recheios` separados.
  - [x] Criar `GET /api/planejamento/fichas-colaboradores` em `planejamentoController.js` e `planejamentoRoutes.js` retornando fichas individuais por colaborador (1 dia ou semana dividida por dias Seg–Sex), somando quantidades de produtos iguais no mesmo dia e omitindo pedidos/clientes e pesos de receita.
  - [x] Criar `POST /api/planejamento/agendar-lote` em `planejamentoController.js` e `planejamentoRoutes.js` para atribuir 1 ou mais OPs selecionadas a um colaborador/data em transação.
  - [x] Corrigir `splitOP` em `planejamentoController.js` para não clonar quantidades antigas em duplicidade na `ordem_producao_origem`.

- [x] **Etapa 2 — Frontend: Limpeza da Tela `planejamento.html`**
  - [x] Remover os 5 botões `🖨️ Cozinha` dos cabeçalhos dos dias e os 20 botões `🖨️ Dia`/`🖨️ Semana` dos cards de colaboradores.
  - [x] Deixar na barra do topo apenas os 3 botões de impressão: `🖨️ Massas`, `🖨️ Recheios`, `🖨️ Colaboradores`.
  - [x] Remover botão `🔗 Agrupar` da barra da fila esquerda, e remover `▶ Iniciar` e `✓ Finalizar` dos cards da fila esquerda (deixando apenas `Atribuir`, `Dividir`, `🗑` com confirmação).
  - [x] Remover `▶ Iniciar` dos cards atribuídos no quadro semanal, deixando `✓ Concluir` (com confirmação antes de baixar estoque), `✂️`, `↩` e `🗑` (com confirmação).
  - [x] Atualizar `+ Atribuir OP` do card do colaborador para: atribuir direto se houver OPs marcadas nos checkboxes da esquerda, ou abrir modal com lista de OPs da fila para seleção manual quando nada estiver marcado.

- [x] **Etapa 3 — Frontend: Pop-up Modal de Pré-visualização e Impressão A4**
  - [x] Remover todas as chamadas `window.open(..., '_blank')` de `planejamento.html`.
  - [x] Implementar o modal pop-up `#print-modal-overlay` com painel de opções ao vivo:
    - Massas: seleção `Todos os dias` ou checkboxes `Seg–Sex` → folha A4 só de Massas (sem resumo de almoxarifado).
    - Recheios: seleção `Todos os dias` ou checkboxes `Seg–Sex` → folha A4 só de Recheios (sem resumo de almoxarifado).
    - Colaboradores: seleção de colaborador (`Todos` ou específico) + `Semana (dividida por dias)` ou `Dia específico` → folhas A4 separadas por colaborador (`page-break-after: always`) contendo só Salgados, Quantidade, Realizado/Perdas, Observação pautada e Assinatura (sem pedidos, sem peso, sem tabela `M1/E1/P1/O1`).
  - [x] Configurar `@media print` em `planejamento.html` para imprimir exclusivamente o conteúdo de pré-visualização em papel A4 sem abrir novas guias/janelas.
  - [x] Limpar/manter `ficha_trabalho.html` coerente caso seja acessada diretamente (sem botões que criem guias extras).

- [x] **Etapa 4 — Validação Completa**
  - [x] Testar atribuição via checkbox + `+ Atribuir OP` e via seleção no modal.
  - [x] Testar `✓ Concluir` com confirmação verificando baixa no Almoxarifado e entrada na Câmara Fria.
  - [x] Testar os 3 pop-ups de impressão (`Massas`, `Recheios`, `Colaboradores` — individual e todos os colaboradores) validando pré-visualização, quebra de página A4 por colaborador e fechamento limpo sem abrir nenhuma guia nova.
