/**
 * TESTES AUTOMATIZADOS — FLUXO INTEGRADO VENDAS -> PRODUÇÃO -> ENTREGA -> FATURAMENTO & CRÉDITO
 * Execução: node backend/test_vendas_producao_faturamento.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');
const { runMigrations } = require('./src/config/migrate');

const insumoController = require('./src/controllers/insumoController');
const receitaController = require('./src/controllers/receitaController');
const produtoController = require('./src/controllers/produtoController');
const comercialController = require('./src/controllers/comercialController');
const producaoController = require('./src/controllers/producaoController');
const planejamentoController = require('./src/controllers/planejamentoController');
const financeiroController = require('./src/controllers/financeiroController');

let totalChecks = 0;
let totalFalhas = 0;

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

function verificar(descricao, condicao, valorObtido, valorEsperado) {
    totalChecks++;
    if (condicao) {
        console.log(`   ✅ [PASS] ${descricao} -> Obtido: ${valorObtido} | Esperado: ${valorEsperado}`);
    } else {
        totalFalhas++;
        console.error(`   ❌ [FAIL] ${descricao} -> Obtido: ${valorObtido} | Esperado: ${valorEsperado}`);
    }
}

function aproxIgual(a, b, tol = 0.01) {
    return Math.abs(Number(a) - Number(b)) <= tol;
}

async function executarTestesFluxoIntegrado() {
    console.log('\n================================================================================');
    console.log('🧪 TESTES AUTOMATIZADOS — VENDAS -> PRODUÇÃO -> ENTREGA -> FATURAMENTO & CRÉDITO');
    console.log('================================================================================\n');

    try {
        await runMigrations();
        await pool.query(fs.readFileSync(path.join(__dirname, 'reset_db.sql'), 'utf8'));

        // Setup base: Colaborador, Insumos, Receita, Produto (50 un em estoque inicial) e 2 Clientes
        const colabId = (await pool.query(
            `INSERT INTO colaborador (nome, meta_diaria, meta_diaria_individual, eh_novato, ativo, status)
             VALUES ('Maria Produção', 350, 350, FALSE, TRUE, 'Ativo') RETURNING id`
        )).rows[0].id;

        const rIns = mockRes();
        await insumoController.criar({
            body: { nome: 'Farinha Especial', categoria: 'Farináceo', tipo_medida: 'Peso', unidade_medida: 'kg', preco_pago: 5.0, peso_embalagem: 1000, estoque_atual: 100 }
        }, rIns);
        const farinhaId = rIns.body.id;

        const rRec = mockRes();
        await receitaController.criar({
            body: { nome: 'Massa Padrão', categoria: 'Massa', itens: [{ tipoOrigem: 'materia', idOrigem: farinhaId, nome: 'Farinha Especial', g: 1000 }] }
        }, rRec);
        const massaId = rRec.body.id;

        const rProd = mockRes();
        await produtoController.criar({
            body: {
                nome: 'Coxinha Tradicional',
                preco_venda: 5.00,
                categoria: 'Frito',
                categoria_producao: 'Frito',
                ficha_tecnica_receitas: [{ receita_id: massaId, quantidade_gramas: 100 }]
            }
        }, rProd);
        const coxinhaId = rProd.body.produto_id;
        await pool.query('UPDATE produto SET estoque_atual = 50 WHERE id = $1', [coxinhaId]);

        const cliAlfa = (await pool.query(
            `INSERT INTO cliente (razao_social, cnpj, telefone, tipo) VALUES ('Padaria Alfa', '11111111000101', '11999990001', 'B2B') RETURNING id`
        )).rows[0].id;
        const cliBeta = (await pool.query(
            `INSERT INTO cliente (razao_social, cnpj, telefone, tipo) VALUES ('Buffet Beta', '22222222000102', '11999990002', 'B2B') RETURNING id`
        )).rows[0].id;

        // =========================================================================
        // 1. CENÁRIO 50 / 100 / 50 (QUARTA VS SEXTA) + SEM BAIXA/COBRANÇA NA CRIAÇÃO
        // =========================================================================
        console.log('⚖️ 1. Testando Balanço Global (Cenário 50/100/50) e Prioridade por Data de Entrega...');

        // Pedido 1: Entrega Sexta (2026-11-27) de 100 un (Estoque=50 -> gera OP de 50 un)
        const resPedSexta = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cliAlfa,
                tipo_pedido: 'ENTREGA',
                data_entrega: '2026-11-27',
                itens: [{ produto_id: coxinhaId, quantidade: 100, preco_unitario: 5.0 }]
            }
        }, resPedSexta);
        const pedSextaId = resPedSexta.body.pedido_id;

        const estAposPed1 = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0].estoque_atual;
        const crsAposPed1 = (await pool.query('SELECT COUNT(*)::int AS c FROM conta_receber')).rows[0].c;

        verificar(
            'Criar Pedido 1 (100 un, estoque 50) gera OP de 50 un, NÃO baixa Câmara Fria e NÃO gera Conta a Receber',
            resPedSexta.statusCode === 201 &&
            resPedSexta.body?.ops_geradas?.[0]?.quantidade_planejada === 50 &&
            estAposPed1 === 50 &&
            crsAposPed1 === 0,
            `op_qtd=${resPedSexta.body?.ops_geradas?.[0]?.quantidade_planejada}, estoque=${estAposPed1}, cr=${crsAposPed1}`,
            'op_qtd=50, estoque=50, cr=0'
        );

        // Pedido 2: Entrega Quarta (2026-11-25 — mais urgente!) de 50 un -> Balanço Global = 50 + 50 - 100 = 0 -> gera OP de 50 un
        const resPedQuarta = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cliBeta,
                tipo_pedido: 'ENTREGA',
                data_entrega: '2026-11-25',
                itens: [{ produto_id: coxinhaId, quantidade: 50, preco_unitario: 5.0 }]
            }
        }, resPedQuarta);
        const pedQuartaId = resPedQuarta.body.pedido_id;

        verificar(
            'Criar Pedido 2 (50 un p/ Quarta) usa Balanço Global (50+50-100=0) e gera OP de 50 un',
            resPedQuarta.statusCode === 201 && resPedQuarta.body?.ops_geradas?.[0]?.quantidade_planejada === 50,
            `op_qtd=${resPedQuarta.body?.ops_geradas?.[0]?.quantidade_planejada}`,
            'op_qtd=50'
        );

        // Verificar prioridade visual na listagem: Quarta (50 un) usa os 50 un da Câmara Fria -> PRONTO_ENTREGA! Sexta (100 un) -> AGUARDANDO_PRODUCAO!
        const resLista1 = mockRes();
        await comercialController.listarPedidos({}, resLista1);
        const pedQuartaLista = resLista1.body.find(p => p.id === pedQuartaId);
        const pedSextaLista  = resLista1.body.find(p => p.id === pedSextaId);

        verificar(
            'Prioridade dinâmica por data_entrega: Quarta (25/11) é PRONTO_ENTREGA e Sexta (27/11) é AGUARDANDO_PRODUCAO',
            pedQuartaLista?.status_fluxo === 'PRONTO_ENTREGA' && pedSextaLista?.status_fluxo === 'AGUARDANDO_PRODUCAO',
            `quarta=${pedQuartaLista?.status_fluxo}, sexta=${pedSextaLista?.status_fluxo}`,
            'quarta=PRONTO_ENTREGA, sexta=AGUARDANDO_PRODUCAO'
        );

        // =========================================================================
        // 2. RETIRADA IMEDIATA (BLOQUEIA SEM ESTOQUE LIVRE) + ENTREGA BLOQUEADA SEM ESTOQUE
        // =========================================================================
        console.log('\n🏪 2. Testando Retirada Imediata e Travas de Entrega sem Estoque...');

        const resRetiradaSemSaldo = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cliAlfa,
                tipo_pedido: 'RETIRADA',
                data_entrega: '2026-11-23',
                itens: [{ produto_id: coxinhaId, quantidade: 60, preco_unitario: 5.0 }]
            }
        }, resRetiradaSemSaldo);
        verificar(
            'Bloqueia RETIRADA de 60 un quando Câmara Fria só tem 50 un (HTTP 400)',
            resRetiradaSemSaldo.statusCode === 400,
            `HTTP ${resRetiradaSemSaldo.statusCode}`,
            'HTTP 400'
        );

        const resEntregaSemSaldo = mockRes();
        await comercialController.entregarPedido({ params: { id: pedSextaId } }, resEntregaSemSaldo);
        verificar(
            'Bloqueia entrega do Pedido de Sexta (100 un) quando Câmara Fria só tem 50 un (HTTP 400)',
            resEntregaSemSaldo.statusCode === 400,
            `HTTP ${resEntregaSemSaldo.statusCode}`,
            'HTTP 400'
        );

        // =========================================================================
        // 3. TRAVA DE EXCLUSÃO DE OP DE PEDIDO E TRAVA DE EDIÇÃO DURANTE PROGRAMAÇÃO
        // =========================================================================
        console.log('\n🔒 3. Testando Trava de Exclusão de OP de Pedido e Edição de Pedido...');

        const opSextaId = resPedSexta.body.ops_geradas[0].op_id;
        const opQuartaId = resPedQuarta.body.ops_geradas[0].op_id;

        const resDelOpPedido = mockRes();
        await producaoController.excluirOP({ params: { id: opSextaId } }, resDelOpPedido);
        verificar(
            'Bloqueia exclusão direta da OP vinculada ao Pedido em Produção (HTTP 400)',
            resDelOpPedido.statusCode === 400,
            `HTTP ${resDelOpPedido.statusCode} (${resDelOpPedido.body?.erro})`,
            'HTTP 400'
        );

        // Programar OP de Sexta no Planejamento (Maria na Segunda 2026-11-23) -> deve bloquear edição do Pedido de Sexta!
        const resProg = mockRes();
        await planejamentoController.agendarOP({
            params: { id: opSextaId },
            body: { colaborador_id: colabId, data_programada: '2026-11-23' }
        }, resProg);

        const resEditBloq = mockRes();
        await comercialController.editarPedido({
            params: { id: pedSextaId },
            body: { data_entrega: '2026-11-28', itens: [{ produto_id: coxinhaId, quantidade: 110, preco_unitario: 5.0 }] }
        }, resEditBloq);
        verificar(
            'Bloqueia edição do Pedido enquanto sua OP está programada no Planejamento (HTTP 400)',
            resEditBloq.statusCode === 400,
            `HTTP ${resEditBloq.statusCode}`,
            'HTTP 400'
        );

        // Pedido de Quarta ainda NÃO tem OP programada -> edição permitida (alterando 50 -> 40 un e recalculando OP de 50 -> 40 un)
        const resEditOk = mockRes();
        await comercialController.editarPedido({
            params: { id: pedQuartaId },
            body: { data_entrega: '2026-11-25', itens: [{ produto_id: coxinhaId, quantidade: 40, preco_unitario: 5.0 }] }
        }, resEditOk);
        const opQuartaRecalc = (await pool.query('SELECT quantidade_planejada FROM ordem_producao WHERE pedido_id = $1', [pedQuartaId])).rows[0];
        verificar(
            'Permite editar Pedido com OP não programada e recalcula OP na fila (50 -> 40 un)',
            resEditOk.statusCode === 200 && opQuartaRecalc?.quantidade_planejada === 40,
            `HTTP ${resEditOk.statusCode}, nova_op_qtd=${opQuartaRecalc?.quantidade_planejada}`,
            'HTTP 200, nova_op_qtd=40'
        );

        // Concluir OP de Sexta (50 un) -> Estoque Câmara Fria sobe de 50 -> 100 un!
        await producaoController.finalizarOP({ params: { id: opSextaId } }, mockRes());

        // Agora todas as OPs do Pedido de Sexta estão CONCLUIDAS -> pode editar para reduzir (100 -> 90), mantendo sobra livre
        const resEditPosConc = mockRes();
        await comercialController.editarPedido({
            params: { id: pedSextaId },
            body: { data_entrega: '2026-11-27', itens: [{ produto_id: coxinhaId, quantidade: 90, preco_unitario: 5.0 }] }
        }, resEditPosConc);
        verificar(
            'Libera edição do Pedido após OPs concluídas (reduzindo 100 -> 90 un, R$ 450,00)',
            resEditPosConc.statusCode === 200 && aproxIgual(resEditPosConc.body?.pedido?.valor_total, 450),
            `HTTP ${resEditPosConc.statusCode}, valor=R$ ${resEditPosConc.body?.pedido?.valor_total}`,
            'HTTP 200, valor=R$ 450'
        );

        // =========================================================================
        // 4. ENTREGA DEFINITIVA + FATURAMENTO À VISTA E A PRAZO (CONCLUÍDO)
        // =========================================================================
        console.log('\n🚚 4. Testando Entrega (baixa Câmara Fria) e Faturamento (À Vista e A Prazo -> Concluído)...');

        // Entregar Pedido de Quarta (40 un -> R$ 200,00). Estoque Câmara Fria: 100 -> 60 un.
        const resEntQuarta = mockRes();
        await comercialController.entregarPedido({ params: { id: pedQuartaId } }, resEntQuarta);
        const estAposEntQuarta = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0].estoque_atual;
        verificar(
            'Entregar Pedido Quarta (40 un) baixa Câmara Fria (100 -> 60 un) e muda status para ENTREGUE',
            resEntQuarta.statusCode === 200 && estAposEntQuarta === 60 && resEntQuarta.body?.pedido?.status === 'ENTREGUE',
            `status=${resEntQuarta.body?.pedido?.status}, estoque=${estAposEntQuarta}`,
            'status=ENTREGUE, estoque=60'
        );

        // Faturar Pedido Quarta À Vista (PIX) -> cria conta_receber RECEBIDO e Pedido vira CONCLUIDO imediato!
        const resFatQuarta = mockRes();
        await comercialController.faturarPedido({
            params: { id: pedQuartaId },
            body: { forma_pagamento: 'PIX', pagamento_tipo: 'A_VISTA' }
        }, resFatQuarta);
        verificar(
            'Faturar À Vista gera título RECEBIDO e conclui Pedido imediatamente (status=CONCLUIDO)',
            resFatQuarta.statusCode === 200 &&
            resFatQuarta.body?.conta_receber?.status === 'RECEBIDO' &&
            resFatQuarta.body?.pedido?.status === 'CONCLUIDO',
            `cr=${resFatQuarta.body?.conta_receber?.status}, ped=${resFatQuarta.body?.pedido?.status}`,
            'cr=RECEBIDO, ped=CONCLUIDO'
        );

        // Concluir OP de Quarta (40 un) para liberar estoque suficiente (60 + 40 = 100) e entregar Pedido Sexta (90 un -> R$ 450,00)
        const opQuartaIdAtual = (await pool.query('SELECT id FROM ordem_producao WHERE pedido_id = $1', [pedQuartaId])).rows[0].id;
        await producaoController.finalizarOP({ params: { id: opQuartaIdAtual } }, mockRes());

        const resEntSexta = mockRes();
        await comercialController.entregarPedido({ params: { id: pedSextaId } }, resEntSexta);

        // Faturar Pedido Sexta A Prazo (BOLETO, R$ 450,00) -> título PENDENTE, pedido permanece ENTREGUE
        const resFatSexta = mockRes();
        await comercialController.faturarPedido({
            params: { id: pedSextaId },
            body: { forma_pagamento: 'BOLETO', pagamento_tipo: 'A_PRAZO', data_vencimento: '2026-12-10' }
        }, resFatSexta);
        const boletoSextaId = resFatSexta.body?.conta_receber?.id;

        verificar(
            'Faturar A Prazo (BOLETO) cria título PENDENTE e mantém Pedido como ENTREGUE até pagamento',
            resFatSexta.statusCode === 200 &&
            resFatSexta.body?.conta_receber?.status === 'PENDENTE' &&
            resFatSexta.body?.pedido?.status === 'ENTREGUE',
            `cr=${resFatSexta.body?.conta_receber?.status}, ped=${resFatSexta.body?.pedido?.status}`,
            'cr=PENDENTE, ped=ENTREGUE'
        );

        // =========================================================================
        // 5. OCORRÊNCIA PÓS-ENTREGA COM BOLETO EMITIDO -> MANTÉM BOLETO CHEIO + GERA CRÉDITO
        // =========================================================================
        console.log('\n↩️ 5. Testando Ocorrência Pós-Entrega (Boleto cheio + Crédito ao Cliente) e Uso no Próximo Pedido...');

        // 10 coxinhas voltaram BOAS no Pedido Sexta (faturado no BOLETO R$ 450,00):
        // Deve retornar +10 un na Câmara Fria (10 -> 20 un), manter Boleto em R$ 450,00 e gerar Crédito de R$ 50,00 para Padaria Alfa!
        const estAntesOcor = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0].estoque_atual;
        const resOcorBoleto = mockRes();
        await comercialController.registrarOcorrencia({
            params: { id: pedSextaId },
            body: {
                produto_id: coxinhaId,
                quantidade: 10,
                condicao_produto: 'BOM',
                acao_financeira: 'ABATER_VALOR',
                observacao: 'Cliente devolveu 10 unidades intactas'
            }
        }, resOcorBoleto);

        const boletoAposOcor = (await pool.query('SELECT valor FROM conta_receber WHERE id = $1', [boletoSextaId])).rows[0];
        const alfaSaldoCred = (await pool.query('SELECT saldo_credito FROM cliente WHERE id = $1', [cliAlfa])).rows[0];
        const estAposOcor = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0].estoque_atual;

        verificar(
            'Ocorrência em Pedido com BOLETO devolve 10 un boas p/ Câmara Fria, mantém Boleto cheio (R$ 450) e gera Crédito (R$ 50)',
            resOcorBoleto.statusCode === 201 &&
            resOcorBoleto.body?.acao_efetiva === 'GERAR_CREDITO' &&
            aproxIgual(boletoAposOcor.valor, 450) &&
            aproxIgual(alfaSaldoCred.saldo_credito, 50) &&
            estAposOcor === estAntesOcor + 10,
            `acao=${resOcorBoleto.body?.acao_efetiva}, boleto=R$ ${boletoAposOcor.valor}, credito=R$ ${alfaSaldoCred.saldo_credito}, estoque=${estAntesOcor}->${estAposOcor}`,
            'acao=GERAR_CREDITO, boleto=R$ 450, credito=R$ 50, estoque=+10'
        );

        // Baixar Boleto de R$ 450 em Contas a Receber -> Pedido Sexta deve virar CONCLUIDO automaticamente!
        const resBaixaBoleto = mockRes();
        await financeiroController.receberConta({ params: { id: String(boletoSextaId) }, body: {} }, resBaixaBoleto);
        const pedSextaPosBaixa = (await pool.query('SELECT status FROM pedido WHERE id = $1', [pedSextaId])).rows[0];
        verificar(
            'Baixar título em Contas a Receber muda Pedido entregue para CONCLUIDO automaticamente',
            resBaixaBoleto.statusCode === 200 && pedSextaPosBaixa.status === 'CONCLUIDO',
            `status=${pedSextaPosBaixa.status}`,
            'status=CONCLUIDO'
        );

        // Novo pedido de RETIRADA para Padaria Alfa (20 un = R$ 100,00) usando os R$ 50,00 de Crédito no Faturamento!
        const resPedCred = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cliAlfa,
                tipo_pedido: 'RETIRADA',
                data_entrega: '2026-11-28',
                itens: [{ produto_id: coxinhaId, quantidade: 20, preco_unitario: 5.0 }]
            }
        }, resPedCred);
        const pedCredId = resPedCred.body.pedido_id;

        await comercialController.entregarPedido({ params: { id: pedCredId } }, mockRes());

        const resFatComCredito = mockRes();
        await comercialController.faturarPedido({
            params: { id: pedCredId },
            body: { forma_pagamento: 'PIX', pagamento_tipo: 'A_VISTA', usar_credito: true }
        }, resFatComCredito);

        const alfaSaldoFinal = (await pool.query('SELECT saldo_credito FROM cliente WHERE id = $1', [cliAlfa])).rows[0].saldo_credito;
        verificar(
            'Faturamento usando crédito desconta R$ 50,00 (cobra R$ 50,00) e zera saldo_credito do cliente',
            resFatComCredito.statusCode === 200 &&
            aproxIgual(resFatComCredito.body?.credito_utilizado, 50) &&
            aproxIgual(resFatComCredito.body?.valor_cobrado, 50) &&
            aproxIgual(resFatComCredito.body?.conta_receber?.valor, 50) &&
            aproxIgual(alfaSaldoFinal, 0),
            `cred_usado=R$ ${resFatComCredito.body?.credito_utilizado}, cobrado=R$ ${resFatComCredito.body?.valor_cobrado}, saldo_rest=R$ ${alfaSaldoFinal}`,
            'cred_usado=R$ 50, cobrado=R$ 50, saldo_rest=R$ 0'
        );

        // =========================================================================
        // 6. CANCELAMENTO DE PEDIDO EM ABERTO REMOVENDO OP NÃO CONCLUÍDA
        // =========================================================================
        console.log('\n❌ 6. Testando Cancelamento de Pedido antes da Entrega...');

        const resPedCanc = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cliBeta,
                tipo_pedido: 'ENTREGA',
                data_entrega: '2026-11-30',
                itens: [{ produto_id: coxinhaId, quantidade: 30, preco_unitario: 5.0 }]
            }
        }, resPedCanc);
        const pedCancId = resPedCanc.body.pedido_id;
        const opCancId = resPedCanc.body.ops_geradas[0].op_id;

        const resCancelar = mockRes();
        await comercialController.cancelarPedido({ params: { id: pedCancId } }, resCancelar);
        const opRestante = (await pool.query('SELECT * FROM ordem_producao WHERE id = $1', [opCancId])).rows;
        const pedCancDb = (await pool.query('SELECT status FROM pedido WHERE id = $1', [pedCancId])).rows[0];

        verificar(
            'Cancelar Pedido em aberto marca status=CANCELADO e remove OP vinculada não concluída da fila',
            resCancelar.statusCode === 200 && pedCancDb.status === 'CANCELADO' && opRestante.length === 0,
            `ped_status=${pedCancDb.status}, ops_restantes=${opRestante.length}`,
            'ped_status=CANCELADO, ops_restantes=0'
        );

        console.log('\n================================================================================');
        console.log(`📊 RESUMO DE VERIFICAÇÕES: ${totalChecks - totalFalhas}/${totalChecks} aprovadas`);
        if (totalFalhas === 0) {
            console.log('🎉 FLUXO INTEGRADO VENDAS -> PRODUÇÃO -> ENTREGA -> FATURAMENTO: 100% APROVADO');
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 TESTES REPROVADOS COM ${totalFalhas} FALHA(S).`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (err) {
        console.error('\n❌ ERRO FATAL:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarTestesFluxoIntegrado();
