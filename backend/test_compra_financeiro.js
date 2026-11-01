/**
 * TESTE AUTOMATIZADO DE INTEGRAÇÃO: NOTA FISCAL MULTI-ITENS (ALMOXARIFADO) -> BOLETO ÚNICO (CONTAS A PAGAR)
 * Execução: node backend/test_compra_financeiro.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');
const { runMigrations } = require('./src/config/migrate');

const insumoController = require('./src/controllers/insumoController');
const receitaController = require('./src/controllers/receitaController');
const estoqueController = require('./src/controllers/estoqueController');
const financeiroController = require('./src/controllers/financeiroController');
const estoqueRoutes = require('./src/routes/estoqueRoutes');
const financeiroRoutes = require('./src/routes/financeiroRoutes');

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

function rotaRegistrada(router, metodo, caminho) {
    return router.stack.some(
        (layer) =>
            layer.route &&
            layer.route.path === caminho &&
            Boolean(layer.route.methods[metodo.toLowerCase()])
    );
}

async function executarTesteCompraFinanceiro() {
    console.log('\n================================================================================');
    console.log('🧾 AUDITORIA INTEGRADA — NF MULTI-ITENS (ALMOXARIFADO) & BOLETO ÚNICO (FINANCEIRO)');
    console.log('================================================================================\n');

    try {
        await runMigrations();

        // =========================================================================
        // 0. VERIFICAR ROTAS REST REGISTRADAS
        // =========================================================================
        console.log('🔌 ETAPA 0: Verificando registro das rotas Express da integração...');
        const temRotaEntradaNF = rotaRegistrada(estoqueRoutes, 'POST', '/entrada-nf');
        const temRotaListarCP = rotaRegistrada(financeiroRoutes, 'GET', '/contas-pagar');
        const temRotaPagarCP = rotaRegistrada(financeiroRoutes, 'PUT', '/contas-pagar/:id/pagar');

        verificar(
            'Rotas REST registradas (/api/estoque/entrada-nf e /api/financeiro/contas-pagar)',
            temRotaEntradaNF && temRotaListarCP && temRotaPagarCP,
            `POST /entrada-nf=${temRotaEntradaNF}, GET /contas-pagar=${temRotaListarCP}, PUT /contas-pagar/:id/pagar=${temRotaPagarCP}`,
            'POST /entrada-nf=true, GET /contas-pagar=true, PUT /contas-pagar/:id/pagar=true'
        );

        // =========================================================================
        // 1. RESET DO BANCO DE DADOS PARA ESTADO VIRGEM
        // =========================================================================
        console.log('\n🧹 ETAPA 1: Resetando banco de dados via reset_db.sql...');
        const sqlResetPath = path.join(__dirname, 'reset_db.sql');
        const sqlReset = fs.readFileSync(sqlResetPath, 'utf8');
        await pool.query(sqlReset);

        const checkVirgem = (
            await pool.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM insumo) AS insumos,
                    (SELECT COUNT(*)::int FROM receita) AS receitas,
                    (SELECT COUNT(*)::int FROM movimentacao_estoque) AS kardex,
                    (SELECT COUNT(*)::int FROM conta_pagar) AS contas_pagar
            `)
        ).rows[0];

        verificar(
            'Banco de dados resetado em estado virgem',
            checkVirgem.insumos === 0 &&
                checkVirgem.receitas === 0 &&
                checkVirgem.kardex === 0 &&
                checkVirgem.contas_pagar === 0,
            `insumos=${checkVirgem.insumos}, receitas=${checkVirgem.receitas}, kardex=${checkVirgem.kardex}, contas_pagar=${checkVirgem.contas_pagar}`,
            'insumos=0, receitas=0, kardex=0, contas_pagar=0'
        );

        // =========================================================================
        // 2. PREPARAÇÃO DO CENÁRIO: 2 INSUMOS (FARINHA E AÇÚCAR) + RECEITA CONJUNTA
        // =========================================================================
        console.log('\n🌾 ETAPA 2: Cadastrando 2 insumos (Farinha de Trigo e Açúcar) e Receita vinculada...');

        // Insumo 1: Farinha de Trigo (estoque 0 kg, custo antigo R$ 6,00/kg)
        const resFarinha = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Farinha de Trigo',
                    categoria: 'Farináceo',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 6.00,
                    peso_embalagem: 1000,
                    estoque_atual: 0
                }
            },
            resFarinha
        );
        const farinhaId = resFarinha.body.id;

        // Insumo 2: Açúcar (estoque 0 kg, custo antigo R$ 5,50/kg)
        const resAcucar = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Açúcar',
                    categoria: 'Secos',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 5.50,
                    peso_embalagem: 1000,
                    estoque_atual: 0
                }
            },
            resAcucar
        );
        const acucarId = resAcucar.body.id;

        // Receita usando ambos (500g Farinha + 500g Açúcar = 1kg -> custo inicial R$ 5,75/kg; após NF: 0.5*4.50 + 0.5*4.00 = R$ 4,25/kg)
        const resReceita = mockRes();
        await receitaController.criar(
            {
                body: {
                    nome: 'Pré-Mistura Massa Doce',
                    categoria: 'Massa',
                    itens: [
                        { tipoOrigem: 'materia', idOrigem: farinhaId, nome: 'Farinha de Trigo', g: 500 },
                        { tipoOrigem: 'materia', idOrigem: acucarId, nome: 'Açúcar', g: 500 }
                    ]
                }
            },
            resReceita
        );
        const receitaDoceId = resReceita.body.id;

        // =========================================================================
        // 3. SIMULAÇÃO DE ENTRADA DE NF COM MÚLTIPLOS INSUMOS (R$ 450 + R$ 200 = R$ 650)
        // =========================================================================
        const datasDb = (
            await pool.query(`
                SELECT
                    TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS hoje,
                    TO_CHAR(CURRENT_DATE + INTERVAL '15 days', 'YYYY-MM-DD') AS vencimento_15d
            `)
        ).rows[0];
        const dataHoje = datasDb.hoje;
        const dataVencimento15Dias = datasDb.vencimento_15d;

        console.log(
            `\n🚚 ETAPA 3: Lançando NF-10500 ("Distribuidora Alvorada Ltda") com 2 insumos:`
        );
        console.log('   • Item 1: Farinha de Trigo — 100 kg por R$ 450,00 (R$ 4,50/kg)');
        console.log('   • Item 2: Açúcar           —  50 kg por R$ 200,00 (R$ 4,00/kg)');
        console.log(`   • Total da NF: R$ 650,00 | Boleto único para ${dataVencimento15Dias}\n`);

        const resEntradaNF = mockRes();
        await estoqueController.registrarEntradaNF(
            {
                body: {
                    fornecedor: 'Distribuidora Alvorada Ltda',
                    documento_ref: 'NF-10500',
                    data_emissao: dataHoje,
                    valor_total_nf: 650.00,
                    pagamento_tipo: 'A_PRAZO',
                    forma_pagamento: 'BOLETO',
                    data_vencimento: dataVencimento15Dias,
                    observacao: 'Carga de secos conferida (Farinha + Açúcar)',
                    itens: [
                        {
                            insumo_id: farinhaId,
                            quantidade: 100,
                            preco_pago_total: 450.00
                        },
                        {
                            insumo_id: acucarId,
                            quantidade: 50,
                            preco_pago_total: 200.00
                        }
                    ]
                }
            },
            resEntradaNF
        );

        verificar(
            'Endpoint POST /api/estoque/entrada-nf respondeu HTTP 201 com 2 itens processados',
            resEntradaNF.statusCode === 201 &&
                resEntradaNF.body?.status === 'sucesso' &&
                resEntradaNF.body?.total_itens === 2,
            `HTTP ${resEntradaNF.statusCode}, total_itens=${resEntradaNF.body?.total_itens}`,
            'HTTP 201, total_itens=2'
        );

        // 3.1 Validar subida de estoque e custo unitário de AMBOS os insumos
        const farinhaDb = (await pool.query('SELECT estoque_atual, custo_unitario FROM insumo WHERE id = $1', [farinhaId])).rows[0];
        const acucarDb  = (await pool.query('SELECT estoque_atual, custo_unitario FROM insumo WHERE id = $1', [acucarId])).rows[0];

        const estFarinha   = parseFloat(farinhaDb.estoque_atual);
        const custoFarinha = parseFloat(farinhaDb.custo_unitario);
        const estAcucar    = parseFloat(acucarDb.estoque_atual);
        const custoAcucar  = parseFloat(acucarDb.custo_unitario);

        verificar(
            'Estoque de Farinha de Trigo subiu para 100 kg (custo R$ 4,50/kg)',
            aproxIgual(estFarinha, 100) && aproxIgual(custoFarinha, 4.50),
            `estoque=${estFarinha.toFixed(2)} kg, custo=R$ ${custoFarinha.toFixed(2)}/kg`,
            'estoque=100.00 kg, custo=R$ 4.50/kg'
        );

        verificar(
            'Estoque de Açúcar subiu para 50 kg (custo R$ 4,00/kg)',
            aproxIgual(estAcucar, 50) && aproxIgual(custoAcucar, 4.00),
            `estoque=${estAcucar.toFixed(2)} kg, custo=R$ ${custoAcucar.toFixed(2)}/kg`,
            'estoque=50.00 kg, custo=R$ 4.00/kg'
        );

        // 3.2 Validar recálculo em cascata da receita que utiliza os 2 insumos
        const recDb = (await pool.query('SELECT custo_por_kg FROM receita WHERE id = $1', [receitaDoceId])).rows[0];
        const custoRec = parseFloat(recDb.custo_por_kg);

        verificar(
            'Receita com Farinha + Açúcar recalculou custo em cascata para R$ 4,25/kg',
            aproxIgual(custoRec, 4.25),
            `R$ ${custoRec.toFixed(2)}/kg`,
            'R$ 4.25/kg'
        );

        // 3.3 Validar se foram criados EXATAMENTE 2 registros de entrada no Kardex vinculados à NF-10500
        const kardexNF = (
            await pool.query(
                `SELECT * FROM movimentacao_estoque
                 WHERE documento_ref = 'NF-10500' AND tipo_movimento = 'ENTRADA'
                 ORDER BY id ASC`
            )
        ).rows;

        const movFarinha = kardexNF.find((m) => m.insumo_id === farinhaId);
        const movAcucar  = kardexNF.find((m) => m.insumo_id === acucarId);

        verificar(
            'Kardex registrou 2 entradas distintas (uma para Farinha 0->100kg e uma para Açúcar 0->50kg) na NF-10500',
            Boolean(
                kardexNF.length === 2 &&
                    movFarinha &&
                    movFarinha.motivo === 'COMPRA_FORNECEDOR' &&
                    aproxIgual(movFarinha.saldo_anterior, 0) &&
                    aproxIgual(movFarinha.saldo_posterior, 100) &&
                    movAcucar &&
                    movAcucar.motivo === 'COMPRA_FORNECEDOR' &&
                    aproxIgual(movAcucar.saldo_anterior, 0) &&
                    aproxIgual(movAcucar.saldo_posterior, 50)
            ),
            `registros_kardex=${kardexNF.length} [Farinha: ${parseFloat(movFarinha?.saldo_anterior || 0)}->${parseFloat(movFarinha?.saldo_posterior || 0)}kg | Açúcar: ${parseFloat(movAcucar?.saldo_anterior || 0)}->${parseFloat(movAcucar?.saldo_posterior || 0)}kg]`,
            'registros_kardex=2 [Farinha: 0->100kg | Açúcar: 0->50kg]'
        );

        // 3.4 Validar se foi criado APENAS 1 boleto consolidado de R$ 650,00 em conta_pagar
        const contasNF = (
            await pool.query(
                `SELECT
                    cp.*,
                    TO_CHAR(cp.data_vencimento, 'YYYY-MM-DD') AS data_vencimento_iso,
                    TO_CHAR(cp.data_pagamento, 'YYYY-MM-DD') AS data_pagamento_iso
                 FROM conta_pagar cp
                 WHERE cp.documento_ref = 'NF-10500'`
            )
        ).rows;

        const totalContasBanco = (await pool.query('SELECT COUNT(*)::int AS total FROM conta_pagar')).rows[0].total;
        const boletoUnico = contasNF[0];

        verificar(
            'Criado APENAS 1 boleto único de R$ 650,00 no Contas a Pagar vinculado à NF-10500',
            Boolean(
                totalContasBanco === 1 &&
                    contasNF.length === 1 &&
                    boletoUnico &&
                    boletoUnico.fornecedor === 'Distribuidora Alvorada Ltda' &&
                    aproxIgual(boletoUnico.valor, 650.00) &&
                    boletoUnico.status === 'PENDENTE' &&
                    boletoUnico.forma_pagamento === 'BOLETO' &&
                    boletoUnico.data_vencimento_iso === dataVencimento15Dias &&
                    boletoUnico.data_pagamento_iso === null
            ),
            boletoUnico
                ? `qtd_boletos=${totalContasBanco}, valor=R$ ${parseFloat(boletoUnico.valor).toFixed(2)}, status=${boletoUnico.status}, venc=${boletoUnico.data_vencimento_iso}`
                : `qtd_boletos=${totalContasBanco} (não encontrado)`,
            `qtd_boletos=1, valor=R$ 650.00, status=PENDENTE, venc=${dataVencimento15Dias}`
        );

        // =========================================================================
        // 4. BAIXA DO BOLETO ÚNICO E LIQUIDAÇÃO INTEGRAL DA FATURA NO FINANCEIRO
        // =========================================================================
        console.log(`\n💸 ETAPA 4: Liquidando o boleto único #${boletoUnico.id} (R$ 650,00) via API PUT /api/financeiro/contas-pagar/${boletoUnico.id}/pagar...`);

        const resPagar = mockRes();
        await financeiroController.pagarConta(
            {
                params: { id: boletoUnico.id },
                body: { forma_pagamento: 'BOLETO' }
            },
            resPagar
        );

        const boletoPagoDb = (
            await pool.query(
                `SELECT
                    cp.*,
                    TO_CHAR(cp.data_pagamento, 'YYYY-MM-DD') AS data_pagamento_iso
                 FROM conta_pagar cp
                 WHERE cp.id = $1`,
                [boletoUnico.id]
            )
        ).rows[0];

        const resFinanceiroPosBaixa = mockRes();
        await financeiroController.listarContasPagar({ query: {} }, resFinanceiroPosBaixa);
        const kpisPosBaixa = resFinanceiroPosBaixa.body?.kpis || {};

        verificar(
            'Baixa do boleto único mudou status para PAGO, gravou data_pagamento e liquidou a fatura inteira (R$ 650,00)',
            Boolean(
                resPagar.statusCode === 200 &&
                    boletoPagoDb &&
                    boletoPagoDb.status === 'PAGO' &&
                    boletoPagoDb.data_pagamento_iso === dataHoje &&
                    aproxIgual(kpisPosBaixa.total_pendente_geral, 0) &&
                    aproxIgual(kpisPosBaixa.total_pagos_mes, 650.00)
            ),
            `status=${boletoPagoDb?.status}, data_pgto=${boletoPagoDb?.data_pagamento_iso}, pendente_geral=R$ ${Number(kpisPosBaixa.total_pendente_geral || 0).toFixed(2)}, pagos_mes=R$ ${Number(kpisPosBaixa.total_pagos_mes || 0).toFixed(2)}`,
            `status=PAGO, data_pgto=${dataHoje}, pendente_geral=R$ 0.00, pagos_mes=R$ 650.00`
        );

        // =========================================================================
        // 5. RELATÓRIO FINAL
        // =========================================================================
        console.log('\n================================================================================');
        console.log(`📊 RESUMO DE VERIFICAÇÕES: ${totalChecks - totalFalhas}/${totalChecks} aprovadas`);
        if (totalFalhas === 0) {
            console.log('🎉 NOTA FISCAL MULTI-ITENS + CONTAS A PAGAR: 100% APROVADO');
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 TESTE REPROVADO COM ${totalFalhas} FALHA(S).`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (erroFatal) {
        console.error('\n❌ ERRO FATAL DURANTE O TESTE DE INTEGRAÇÃO:', erroFatal.message);
        console.error(erroFatal);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarTesteCompraFinanceiro();
