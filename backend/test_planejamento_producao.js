/**
 * TESTES AUTOMATIZADOS — PLANEJAMENTO UNIFICADO DE PRODUÇÃO, AGRUPAMENTO, SEMANA ÚTIL,
 * BAIXA INTEGRADA EM CASCATA E IMPRESSÕES (COZINHA E COLABORADOR)
 * Execução: node backend/test_planejamento_producao.js
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

function aproxIgual(a, b, tol = 0.001) {
    return Math.abs(Number(a) - Number(b)) <= tol;
}

async function executarTestesPlanejamento() {
    console.log('\n================================================================================');
    console.log('🧪 INICIANDO TESTES AUTOMATIZADOS — PLANEJAMENTO DE PRODUÇÃO & REGRAS DE NEGÓCIO');
    console.log('================================================================================\n');

    try {
        await runMigrations();

        // 0. Reset do banco de dados
        const sqlReset = fs.readFileSync(path.join(__dirname, 'reset_db.sql'), 'utf8');
        await pool.query(sqlReset);

        // =========================================================================
        // 1. TESTES UNITÁRIOS DE SEMANA ÚTIL (SEG-SEX COM VIRADA NO SÁBADO)
        // =========================================================================
        console.log('📅 1. Testando regra de cálculo de Semana Útil (Seg-Sex + Virada no Sábado/Domingo)...');

        // Quarta-feira 2026-11-18 -> Seg 2026-11-16 a Sex 2026-11-20
        const semQuarta = planejamentoController.calcularSemanaUtil('2026-11-18');
        verificar(
            'Quarta-feira (2026-11-18) permanece na semana corrente (16/11 a 20/11)',
            semQuarta.data_inicio === '2026-11-16' && semQuarta.data_fim === '2026-11-20' && semQuarta.datas.length === 5,
            `${semQuarta.data_inicio} a ${semQuarta.data_fim} (${semQuarta.datas.length} dias)`,
            '2026-11-16 a 2026-11-20 (5 dias)'
        );

        // Sábado 2026-11-21 -> vira automaticamente para próxima Segunda 2026-11-23 a Sexta 2026-11-27
        const semSabado = planejamentoController.calcularSemanaUtil('2026-11-21');
        verificar(
            'Sábado (2026-11-21) vira automaticamente para próxima semana útil (23/11 a 27/11)',
            semSabado.data_inicio === '2026-11-23' && semSabado.data_fim === '2026-11-27',
            `${semSabado.data_inicio} a ${semSabado.data_fim}`,
            '2026-11-23 a 2026-11-27'
        );

        // Domingo 2026-11-22 -> vira automaticamente para próxima Segunda 2026-11-23 a Sexta 2026-11-27
        const semDomingo = planejamentoController.calcularSemanaUtil('2026-11-22');
        verificar(
            'Domingo (2026-11-22) vira automaticamente para próxima semana útil (23/11 a 27/11)',
            semDomingo.data_inicio === '2026-11-23' && semDomingo.data_fim === '2026-11-27',
            `${semDomingo.data_inicio} a ${semDomingo.data_fim}`,
            '2026-11-23 a 2026-11-27'
        );

        // =========================================================================
        // 2. PREPARAÇÃO DE DADOS (INSUMOS, RECEITAS EM CASCATA, PRODUTOS E COLABORADOR)
        // =========================================================================
        console.log('\n🥣 2. Cadastrando insumos, receitas (Massa D+0 e Recheio D-1), produtos e colaborador...');

        const colabInsert = await pool.query(
            `INSERT INTO colaborador (nome, meta_diaria, meta_diaria_individual, eh_novato, ativo, status)
             VALUES ('Maria Salgadeira', 350, 350, FALSE, TRUE, 'Ativo') RETURNING id`
        );
        const colabId = colabInsert.rows[0].id;

        const resFarinha = mockRes();
        await insumoController.criar({
            body: { nome: 'Farinha Especial', categoria: 'Farináceo', tipo_medida: 'Peso', unidade_medida: 'kg', preco_pago: 5.0, peso_embalagem: 1000, estoque_atual: 50 }
        }, resFarinha);
        const farinhaId = resFarinha.body.id;

        const resFrango = mockRes();
        await insumoController.criar({
            body: { nome: 'Peito de Frango', categoria: 'Proteína', tipo_medida: 'Peso', unidade_medida: 'kg', preco_pago: 18.0, peso_embalagem: 1000, estoque_atual: 30 }
        }, resFrango);
        const frangoId = resFrango.body.id;

        const resEmb = mockRes();
        await insumoController.criar({
            body: { nome: 'Bandeja 50 un', categoria: 'Embalagem', tipo_medida: 'Unidade', unidade_medida: 'un', preco_pago: 2.0, peso_embalagem: 1, estoque_atual: 20 }
        }, resEmb);
        const embId = resEmb.body.id;

        // Receita de Massa (1000g Farinha)
        const resMassa = mockRes();
        await receitaController.criar({
            body: {
                nome: 'Massa Base Salgados',
                categoria: 'Massa',
                itens: [{ tipoOrigem: 'materia', idOrigem: farinhaId, nome: 'Farinha Especial', g: 1000 }]
            }
        }, resMassa);
        const massaId = resMassa.body.id;

        // Receita de Recheio (1000g Frango)
        const resRecheio = mockRes();
        await receitaController.criar({
            body: {
                nome: 'Recheio de Frango Desfiado',
                categoria: 'Recheio',
                itens: [{ tipoOrigem: 'materia', idOrigem: frangoId, nome: 'Peito de Frango', g: 1000 }]
            }
        }, resRecheio);
        const recheioId = resRecheio.body.id;

        // Produto 1: Coxinha (60g Massa + 40g Recheio, peso_produtividade = 2.0 para provar que meta usa unidades simples!)
        const resProd1 = mockRes();
        await produtoController.criar({
            body: {
                nome: 'Coxinha Gourmet',
                preco_venda: 6.00,
                categoria: 'Frito',
                categoria_producao: 'Frito',
                peso_produtividade: 2.0,
                embalagem_id: embId,
                capacidade_embalagem: 50,
                ficha_tecnica_receitas: [
                    { receita_id: massaId, quantidade_gramas: 60 },
                    { receita_id: recheioId, quantidade_gramas: 40 }
                ]
            }
        }, resProd1);
        const coxinhaId = resProd1.body.produto_id;

        // Produto 2: Empada (sem ficha técnica para testar erro e um com ficha para testar erro de agrupamento diferente)
        const prodSemFichaRes = await pool.query(
            `INSERT INTO produto (nome, preco_venda, categoria, estoque_atual) VALUES ('Produto Sem Ficha', 4.0, 'Assado', 0) RETURNING id`
        );
        const prodSemFichaId = prodSemFichaRes.rows[0].id;

        const resProd2 = mockRes();
        await produtoController.criar({
            body: {
                nome: 'Quibe Tradicional',
                preco_venda: 5.00,
                categoria: 'Frito',
                ficha_tecnica_receitas: [{ receita_id: massaId, quantidade_gramas: 80 }]
            }
        }, resProd2);
        const quibeId = resProd2.body.produto_id;

        // =========================================================================
        // 3. CENÁRIOS DE ERRO E VALIDAÇÃO NA ALOCAÇÃO MANUAL DE OP
        // =========================================================================
        console.log('\n🚫 3. Testando cenários de erro na criação de OP manual...');

        // Quantidade negativa ou zero
        const resOpNeg = mockRes();
        await producaoController.alocar({ body: { produto_id: coxinhaId, quantidade_planejada: -10 } }, resOpNeg);
        verificar(
            'Bloqueia criação de OP com quantidade negativa (-10)',
            resOpNeg.statusCode === 400,
            `HTTP ${resOpNeg.statusCode}`,
            'HTTP 400'
        );

        const resOpZero = mockRes();
        await producaoController.alocar({ body: { produto_id: coxinhaId, quantidade_planejada: 0 } }, resOpZero);
        verificar(
            'Bloqueia criação de OP com quantidade zero (0)',
            resOpZero.statusCode === 400,
            `HTTP ${resOpZero.statusCode}`,
            'HTTP 400'
        );

        // Produto sem ficha técnica
        const resOpSemFicha = mockRes();
        await producaoController.alocar({ body: { produto_id: prodSemFichaId, quantidade_planejada: 50 } }, resOpSemFicha);
        verificar(
            'Bloqueia criação de OP para produto sem ficha técnica',
            resOpSemFicha.statusCode === 400,
            `HTTP ${resOpSemFicha.statusCode}`,
            'HTTP 400'
        );

        // =========================================================================
        // 4. GERAÇÃO DE OP VIA VENDA (APENAS MONTAGEM + VÍNCULO DE CLIENTE/PEDIDO)
        // =========================================================================
        console.log('\n💰 4. Testando geração de OP via Pedido de Venda (sem sub-OPs de PREPARO e com origem)...');

        const cli1 = (await pool.query(
            `INSERT INTO cliente (razao_social, cnpj, telefone) VALUES ('Padaria Alfa', '11111111000101', '11999990001') RETURNING id`
        )).rows[0].id;
        const cli2 = (await pool.query(
            `INSERT INTO cliente (razao_social, cnpj, telefone) VALUES ('Lanchonete Beta', '22222222000102', '11999990002') RETURNING id`
        )).rows[0].id;

        const resPed1 = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cli1,
                data_entrega: '2026-11-25',
                itens: [{ produto_id: coxinhaId, quantidade: 120, preco_unitario: 6.0 }]
            }
        }, resPed1);

        const resPed2 = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cli2,
                data_entrega: '2026-11-26',
                itens: [{ produto_id: coxinhaId, quantidade: 80, preco_unitario: 6.0 }]
            }
        }, resPed2);

        const todasOpsDb = await pool.query('SELECT * FROM ordem_producao ORDER BY id ASC');
        const opsPreparo = todasOpsDb.rows.filter(o => o.tipo_op === 'PREPARO');
        verificar(
            'Pedidos geraram apenas OPs de Produto Final (MONTAGEM) e zero sub-OPs de PREPARO',
            todasOpsDb.rows.length === 2 && opsPreparo.length === 0,
            `total=${todasOpsDb.rows.length}, preparo=${opsPreparo.length}`,
            'total=2, preparo=0'
        );

        const op1Id = todasOpsDb.rows[0].id;
        const op2Id = todasOpsDb.rows[1].id;

        const resFilaAntes = mockRes();
        await producaoController.listarFila({ query: {} }, resFilaAntes);
        const op1Fila = resFilaAntes.body.find(o => o.id === op1Id);
        verificar(
            'listarFila retorna cliente_nome, pedido_id, data_entrega e origens na OP de venda',
            Boolean(op1Fila && op1Fila.cliente_nome === 'Padaria Alfa' && op1Fila.pedido_id === resPed1.body.pedido_id && op1Fila.origens.length === 1),
            `cliente=${op1Fila?.cliente_nome}, pedido=${op1Fila?.pedido_id}, origens=${op1Fila?.origens?.length}`,
            `cliente=Padaria Alfa, pedido=${resPed1.body.pedido_id}, origens=1`
        );

        // =========================================================================
        // 5. AGRUPAMENTO MANUAL DE OPS (CENÁRIOS DE ERRO E CENÁRIO NORMAL)
        // =========================================================================
        console.log('\n🔗 5. Testando Agrupamento Manual de OPs (cenários de erro e sucesso)...');

        // Criar OP de produto diferente (Quibe)
        const resOpQuibe = mockRes();
        await producaoController.alocar({ body: { produto_id: quibeId, quantidade_planejada: 50 } }, resOpQuibe);
        const opQuibeId = resOpQuibe.body.id;

        // Erro: agrupar menos de 2 OPs
        const resAgrUm = mockRes();
        await planejamentoController.agruparOPs({ body: { ops_ids: [op1Id] } }, resAgrUm);
        verificar(
            'Bloqueia agrupamento com apenas 1 OP selecionada',
            resAgrUm.statusCode === 400,
            `HTTP ${resAgrUm.statusCode}`,
            'HTTP 400'
        );

        // Erro: agrupar OPs de produtos diferentes (Coxinha + Quibe)
        const resAgrDif = mockRes();
        await planejamentoController.agruparOPs({ body: { ops_ids: [op1Id, opQuibeId] } }, resAgrDif);
        verificar(
            'Bloqueia agrupamento de OPs de produtos diferentes (Coxinha + Quibe)',
            resAgrDif.statusCode === 400,
            `HTTP ${resAgrDif.statusCode} (${resAgrDif.body?.erro})`,
            'HTTP 400'
        );

        // Sucesso: agrupar OP #1 (120 un Padaria Alfa) + OP #2 (80 un Lanchonete Beta) = 200 un
        const resAgrOk = mockRes();
        await planejamentoController.agruparOPs({ body: { ops_ids: [op1Id, op2Id] } }, resAgrOk);
        verificar(
            'Agrupa 2 OPs de Coxinha (120 + 80 = 200 un) preservando os 2 clientes/pedidos em origens',
            Boolean(
                resAgrOk.statusCode === 200 &&
                resAgrOk.body?.op?.quantidade_planejada === 200 &&
                resAgrOk.body?.op?.agrupada === true &&
                resAgrOk.body?.op?.origens?.length === 2
            ),
            `qtd=${resAgrOk.body?.op?.quantidade_planejada}, agrupada=${resAgrOk.body?.op?.agrupada}, origens=${resAgrOk.body?.op?.origens?.length}`,
            'qtd=200, agrupada=true, origens=2'
        );

        // =========================================================================
        // 6. AGENDAMENTO E META EM UNIDADES SIMPLES (SEM PESO_PRODUTIVIDADE)
        // =========================================================================
        console.log('\n📊 6. Testando Agendamento e Meta Diária em Unidades Simples (sem peso_produtividade)...');

        // Nota: Coxinha tem peso_produtividade = 2.0, mas 200 unidades devem contar como 200 un (e NÃO 400 pontos!)
        const resValCap = mockRes();
        await planejamentoController.validarCapacidade({
            body: {
                colaborador_id: colabId,
                data_programada: '2026-11-23',
                ops: [{ op_id: op1Id }]
            }
        }, resValCap);

        verificar(
            'Validação de capacidade conta 200 unidades simples (não multiplica por peso_produtividade 2.0) e fica abaixo da meta 350',
            resValCap.body?.novo_total_unidades === 200 && resValCap.body?.ultrapassa_meta === false,
            `novo_total=${resValCap.body?.novo_total_unidades} un, ultrapassa=${resValCap.body?.ultrapassa_meta}`,
            'novo_total=200 un, ultrapassa=false'
        );

        // Agendar OP consolidada de 200 un para Maria na Segunda 2026-11-23
        const resAgendar = mockRes();
        await planejamentoController.agendarOP({
            params: { id: op1Id },
            body: { colaborador_id: colabId, data_programada: '2026-11-23' }
        }, resAgendar);

        verificar(
            'Agendamento aloca OP na Segunda 2026-11-23 sem criar sub-OPs de PREPARO',
            resAgendar.statusCode === 200 && (await pool.query("SELECT COUNT(*)::int AS c FROM ordem_producao WHERE tipo_op = 'PREPARO'")).rows[0].c === 0,
            'status=200, sub_ops_preparo=0',
            'status=200, sub_ops_preparo=0'
        );

        // Verificar quadro semanal
        const resSemanal = mockRes();
        await planejamentoController.obterPlanejamentoSemanal({
            query: { data_inicio: '2026-11-23', data_fim: '2026-11-27' }
        }, resSemanal);
        const colabSeg = resSemanal.body?.agenda?.['2026-11-23']?.colaboradores?.find(c => c.colaborador_id === colabId);

        verificar(
            'Quadro semanal retorna total_unidades=200 e OP com 2 origens detalhadas',
            Boolean(colabSeg && colabSeg.total_unidades === 200 && colabSeg.ops.length === 1 && colabSeg.ops[0].origens.length === 2),
            `total_unidades=${colabSeg?.total_unidades}, ops=${colabSeg?.ops?.length}, origens=${colabSeg?.ops?.[0]?.origens?.length}`,
            'total_unidades=200, ops=1, origens=2'
        );

        // =========================================================================
        // 7. ENDPOINTS DE IMPRESSÃO (MAPA DE PREPARO D-1/D+0, FICHA DIÁRIA E SEMANAL)
        // =========================================================================
        console.log('\n🖨️ 7. Testando Endpoints de Impressão (Cozinha Massas/Recheios e Colaborador Dia/Semana)...');

        const resMapa = mockRes();
        await planejamentoController.obterMapaPreparo({
            query: { data_inicio: '2026-11-23', data_fim: '2026-11-27' }
        }, resMapa);

        // 200 coxinhas * 60g Massa = 12 kg Massa (D+0) | 200 coxinhas * 40g Recheio = 8 kg Recheio (D-1)
        const prepMassa = resMapa.body?.massas_d0?.find(p => p.receita_id === massaId);
        const prepRecheio = resMapa.body?.recheios_molhos_d1?.find(p => p.receita_id === recheioId);

        verificar(
            'Mapa de Preparo separa Recheio em D-1 (8 kg) e Massa em D+0 (12 kg -> 1 panela de 10 kg + 1 de 2.00 kg)',
            Boolean(
                prepMassa && aproxIgual(prepMassa.peso_total_kg, 12.0) &&
                prepRecheio && aproxIgual(prepRecheio.peso_total_kg, 8.0) &&
                prepMassa.instrucao_batelada.includes('10 kg')
            ),
            `Massa=${prepMassa?.peso_total_kg}kg (${prepMassa?.instrucao_batelada}), Recheio=${prepRecheio?.peso_total_kg}kg`,
            'Massa=12kg (1 panela(s) de 10 kg + 1 panela de 2.00 kg), Recheio=8kg'
        );

        const resFichaDia = mockRes();
        await planejamentoController.obterFichaTrabalho({
            params: { colaborador_id: colabId, data: '2026-11-23' }
        }, resFichaDia);
        verificar(
            'Ficha Diária do Colaborador retorna OP de 200 un com origens e receitas de referência',
            Boolean(
                resFichaDia.statusCode === 200 &&
                resFichaDia.body?.total_unidades === 200 &&
                resFichaDia.body?.ops?.[0]?.origens?.length === 2 &&
                resFichaDia.body?.ops?.[0]?.receitas_requeridas?.length === 2
            ),
            `total_unidades=${resFichaDia.body?.total_unidades}, origens=${resFichaDia.body?.ops?.[0]?.origens?.length}`,
            'total_unidades=200, origens=2'
        );

        const resFichaSem = mockRes();
        await planejamentoController.obterFichaSemana({
            params: { colaborador_id: colabId },
            query: { data_inicio: '2026-11-23', data_fim: '2026-11-27' }
        }, resFichaSem);
        verificar(
            'Ficha Semanal do Colaborador retorna os 5 dias úteis (Seg-Sex) e total_unidades_semana=200',
            Boolean(
                resFichaSem.statusCode === 200 &&
                resFichaSem.body?.dias?.length === 5 &&
                resFichaSem.body?.total_unidades_semana === 200
            ),
            `dias=${resFichaSem.body?.dias?.length}, total_semana=${resFichaSem.body?.total_unidades_semana}`,
            'dias=5, total_semana=200'
        );

        // =========================================================================
        // 8. FINALIZAÇÃO DE OP COM BAIXA INTEGRADA EM CASCATA + BLOQUEIO DE EXCLUSÃO
        // =========================================================================
        console.log('\n❄️ 8. Testando Finalização da OP (baixa Almoxarifado + Embalagem + entrada Câmara Fria)...');

        const resFin = mockRes();
        await producaoController.finalizarOP({ params: { id: op1Id } }, resFin);

        // Estoques esperados:
        // Farinha: 50 kg - 12 kg = 38 kg
        // Frango: 30 kg - 8 kg = 22 kg
        // Embalagem (cap 50): 20 un - (200 / 50 = 4 un) = 16 un
        // Coxinha Câmara Fria: 0 un + 200 un = 200 un
        const estFarinhaPos = parseFloat((await pool.query('SELECT estoque_atual FROM insumo WHERE id = $1', [farinhaId])).rows[0].estoque_atual);
        const estFrangoPos = parseFloat((await pool.query('SELECT estoque_atual FROM insumo WHERE id = $1', [frangoId])).rows[0].estoque_atual);
        const estEmbPos = parseFloat((await pool.query('SELECT estoque_atual FROM insumo WHERE id = $1', [embId])).rows[0].estoque_atual);
        const estCoxinhaPos = parseInt((await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0].estoque_atual, 10);

        verificar(
            'Finalizar OP baixou Farinha (50 -> 38 kg), Frango (30 -> 22 kg) e Embalagem (20 -> 16 un) no Almoxarifado',
            aproxIgual(estFarinhaPos, 38) && aproxIgual(estFrangoPos, 22) && aproxIgual(estEmbPos, 16),
            `farinha=${estFarinhaPos}kg, frango=${estFrangoPos}kg, emb=${estEmbPos}un`,
            'farinha=38kg, frango=22kg, emb=16un'
        );

        verificar(
            'Finalizar OP creditou 200 un de Coxinha na Câmara Fria e retornou produto no JSON',
            estCoxinhaPos === 200 && resFin.body?.produto?.estoque_atual === 200,
            `camara_fria=${estCoxinhaPos}un, json_prod=${resFin.body?.produto?.estoque_atual}un`,
            'camara_fria=200un, json_prod=200un'
        );

        // Erro ao tentar finalizar novamente a mesma OP
        const resFinDuplo = mockRes();
        await producaoController.finalizarOP({ params: { id: op1Id } }, resFinDuplo);
        verificar(
            'Bloqueia tentativa de finalizar novamente uma OP já CONCLUIDA',
            resFinDuplo.statusCode === 400,
            `HTTP ${resFinDuplo.statusCode}`,
            'HTTP 400'
        );

        // Erro ao tentar excluir OP já CONCLUIDA
        const resDelConcluida = mockRes();
        await producaoController.excluirOP({ params: { id: op1Id } }, resDelConcluida);
        verificar(
            'Bloqueia exclusão de OP já CONCLUIDA (HTTP 400)',
            resDelConcluida.statusCode === 400,
            `HTTP ${resDelConcluida.statusCode}`,
            'HTTP 400'
        );

        // Sucesso ao excluir OP em FILA (opQuibeId)
        const resDelFila = mockRes();
        await producaoController.excluirOP({ params: { id: opQuibeId } }, resDelFila);
        verificar(
            'Permite excluir OP em status FILA (HTTP 200)',
            resDelFila.statusCode === 200 && resDelFila.body?.status === 'sucesso',
            `HTTP ${resDelFila.statusCode}`,
            'HTTP 200'
        );

        // OP Concluída deve continuar aparecendo no quadro semanal como CONCLUIDA
        const resSemPosFin = mockRes();
        await planejamentoController.obterPlanejamentoSemanal({
            query: { data_inicio: '2026-11-23', data_fim: '2026-11-27' }
        }, resSemPosFin);
        const opConcluidaNoQuadro = resSemPosFin.body?.agenda?.['2026-11-23']?.colaboradores
            ?.find(c => c.colaborador_id === colabId)?.ops?.[0];
        verificar(
            'OP CONCLUIDA permanece visível no quadro semanal com status CONCLUIDA',
            Boolean(opConcluidaNoQuadro && opConcluidaNoQuadro.status === 'CONCLUIDA'),
            `status=${opConcluidaNoQuadro?.status}`,
            'status=CONCLUIDA'
        );

        // =========================================================================
        // 9. NOVOS TESTES: SPLIT SEM DUPLICAR ORIGEM, AGENDAR LOTE E FICHAS SEPARADAS
        // =========================================================================
        console.log('\n🧩 9. Testando Correção de Split, Agendamento em Lote e Impressões Separadas (Massas/Recheios/Colaboradores)...');

        // 9a. Criar segundo colaborador e novo pedido de 160 Coxinhas (para testar split de origem)
        const colab2Id = (await pool.query(
            `INSERT INTO colaborador (nome, meta_diaria, meta_diaria_individual, eh_novato, ativo, status)
             VALUES ('João Salgadeiro', 400, 400, FALSE, TRUE, 'Ativo') RETURNING id`
        )).rows[0].id;

        const resPed3 = mockRes();
        await comercialController.lancarPedido({
            body: {
                cliente_id: cli1,
                data_entrega: '2026-11-27',
                itens: [{ produto_id: coxinhaId, quantidade: 160, preco_unitario: 6.0 }]
            }
        }, resPed3);
        const opPed3Id = resPed3.body.ops_geradas[0].op_id;

        // Dividir OP de 160 un -> 100 un (original) + 60 un (nova)
        const resSplit3 = mockRes();
        await planejamentoController.splitOP({
            body: { op_id: opPed3Id, quantidade_separar: 60 }
        }, resSplit3);
        const opSplitNovaId = resSplit3.body?.nova_op_criada?.id;

        const orig1 = (await pool.query('SELECT quantidade FROM ordem_producao_origem WHERE ordem_producao_id = $1', [opPed3Id])).rows;
        const orig2 = (await pool.query('SELECT quantidade FROM ordem_producao_origem WHERE ordem_producao_id = $1', [opSplitNovaId])).rows;

        verificar(
            'splitOP ajusta quantidade da origem original para 100 e nova para 60 (sem duplicar 160)',
            orig1.length === 1 && orig1[0].quantidade === 100 && orig2.length === 1 && orig2[0].quantidade === 60,
            `orig1=${orig1[0]?.quantidade}, orig2=${orig2[0]?.quantidade}`,
            'orig1=100, orig2=60'
        );

        // 9b. Testar erros no agendarLote
        const resLoteVazio = mockRes();
        await planejamentoController.agendarLote({
            body: { ops_ids: [], data_programada: '2026-11-24', colaborador_id: colab2Id }
        }, resLoteVazio);
        verificar(
            'agendarLote bloqueia lista vazia de OPs (HTTP 400)',
            resLoteVazio.statusCode === 400,
            `HTTP ${resLoteVazio.statusCode}`,
            'HTTP 400'
        );

        const resLoteConcluida = mockRes();
        await planejamentoController.agendarLote({
            body: { ops_ids: [op1Id], data_programada: '2026-11-24', colaborador_id: colab2Id }
        }, resLoteConcluida);
        verificar(
            'agendarLote bloqueia OP já CONCLUIDA (HTTP 400)',
            resLoteConcluida.statusCode === 400,
            `HTTP ${resLoteConcluida.statusCode}`,
            'HTTP 400'
        );

        // 9c. Agendar as 2 OPs de Coxinha (100 + 60 = 160 un) em lote para João na Terça (2026-11-24)
        const resLoteOk = mockRes();
        await planejamentoController.agendarLote({
            body: { ops_ids: [opPed3Id, opSplitNovaId], data_programada: '2026-11-24', colaborador_id: colab2Id }
        }, resLoteOk);
        verificar(
            'agendarLote atribui 2 OPs em uma transação para João (160 un na Terça 24/11)',
            resLoteOk.statusCode === 200 && resLoteOk.body?.total_dia === 160,
            `HTTP ${resLoteOk.statusCode}, total_dia=${resLoteOk.body?.total_dia}`,
            'HTTP 200, total_dia=160'
        );

        // 9d. Testar GET /api/planejamento/mapa-preparo com datas específicas e array vazio
        const resMapaVazio = mockRes();
        await planejamentoController.obterMapaPreparo({
            query: { datas: '' }
        }, resMapaVazio);
        verificar(
            'mapa-preparo com datas vazio retorna massas=[] e recheios=[]',
            Array.isArray(resMapaVazio.body?.massas) && resMapaVazio.body.massas.length === 0 &&
            Array.isArray(resMapaVazio.body?.recheios) && resMapaVazio.body.recheios.length === 0,
            `massas=${resMapaVazio.body?.massas?.length}, recheios=${resMapaVazio.body?.recheios?.length}`,
            'massas=0, recheios=0'
        );

        // Apenas Terça 2026-11-24 (160 Coxinhas: 160*0.06 = 9.6 kg Massa, 160*0.04 = 6.4 kg Recheio)
        const resMapaTerca = mockRes();
        await planejamentoController.obterMapaPreparo({
            query: { datas: '2026-11-24' }
        }, resMapaTerca);
        verificar(
            'mapa-preparo com datas=2026-11-24 separa massas (9.6 kg) e recheios (6.4 kg)',
            resMapaTerca.body?.massas?.length === 1 && aproxIgual(resMapaTerca.body.massas[0].peso_total_kg, 9.6) &&
            resMapaTerca.body?.recheios?.length === 1 && aproxIgual(resMapaTerca.body.recheios[0].peso_total_kg, 6.4),
            `massa=${resMapaTerca.body?.massas?.[0]?.peso_total_kg}kg, recheio=${resMapaTerca.body?.recheios?.[0]?.peso_total_kg}kg`,
            'massa=9.6kg, recheio=6.4kg'
        );

        // 9e. Testar GET /api/planejamento/fichas-colaboradores
        // Maria só tinha a OP #1 já CONCLUIDA na Segunda, então em TODOS só deve aparecer João (160 un consolidadas na Terça)
        const resFichasTodos = mockRes();
        await planejamentoController.obterFichasColaboradores({
            query: { colaborador_id: 'TODOS', data_inicio: '2026-11-23', data_fim: '2026-11-27' }
        }, resFichasTodos);
        const fichaJoao = resFichasTodos.body?.fichas?.[0];
        const diaTercaJoao = fichaJoao?.dias?.find(d => d.data === '2026-11-24');
        const itemCoxinhaJoao = diaTercaJoao?.itens?.[0];

        verificar(
            'fichas-colaboradores (TODOS) retorna folha apenas para colaboradores com OPs pendentes e soma 2 OPs iguais (100+60=160 un)',
            Boolean(
                resFichasTodos.body?.fichas?.length === 1 &&
                fichaJoao.colaborador.id === colab2Id &&
                diaTercaJoao?.itens?.length === 1 &&
                itemCoxinhaJoao?.quantidade_total === 160 &&
                itemCoxinhaJoao?.origens === undefined &&
                itemCoxinhaJoao?.receitas_requeridas === undefined
            ),
            `fichas=${resFichasTodos.body?.fichas?.length}, itens_terca=${diaTercaJoao?.itens?.length}, qtd=${itemCoxinhaJoao?.quantidade_total}`,
            'fichas=1 (João), itens_terca=1, qtd=160 (sem origens/receitas)'
        );

        console.log('\n================================================================================');
        console.log(`📊 RESUMO DE VERIFICAÇÕES: ${totalChecks - totalFalhas}/${totalChecks} aprovadas`);
        if (totalFalhas === 0) {
            console.log('🎉 TESTES DO PLANEJAMENTO DE PRODUÇÃO: 100% APROVADO');
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 TESTES REPROVADOS COM ${totalFalhas} FALHA(S).`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (err) {
        console.error('\n❌ ERRO FATAL DURANTE OS TESTES:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarTestesPlanejamento();
