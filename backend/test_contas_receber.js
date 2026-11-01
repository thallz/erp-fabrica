/**
 * TESTE AUTOMATIZADO DE INTEGRAÇÃO — VENDAS B2B -> CONTAS A RECEBER (FATURAMENTO & BAIXA)
 * Execução: node backend/test_contas_receber.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');
const { runMigrations } = require('./src/config/migrate');

const insumoController = require('./src/controllers/insumoController');
const produtoController = require('./src/controllers/produtoController');
const comercialController = require('./src/controllers/comercialController');
const financeiroController = require('./src/controllers/financeiroController');
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

async function executarTesteContasReceber() {
    console.log('\n================================================================================');
    console.log('💰 AUDITORIA AUTOMATIZADA — PEDIDOS DE VENDA B2B & CONTAS A RECEBER');
    console.log('================================================================================\n');

    try {
        await runMigrations();

        // =========================================================================
        // 0. VERIFICAR ROTAS DE CONTAS A RECEBER EM financeiroRoutes
        // =========================================================================
        console.log('🔌 ETAPA 0: Verificando registro das rotas REST em /api/financeiro...');
        const rGet = rotaRegistrada(financeiroRoutes, 'GET', '/contas-receber');
        const rPost = rotaRegistrada(financeiroRoutes, 'POST', '/contas-receber');
        const rPutReceber = rotaRegistrada(financeiroRoutes, 'PUT', '/contas-receber/:id/receber');

        verificar(
            'Rotas REST de Contas a Receber registradas em financeiroRoutes',
            rGet && rPost && rPutReceber,
            `GET=${rGet}, POST=${rPost}, PUT/receber=${rPutReceber}`,
            'GET=true, POST=true, PUT/receber=true'
        );

        // =========================================================================
        // 1. RESET DO BANCO DE DADOS PARA ESTADO VIRGEM
        // =========================================================================
        console.log('\n🧹 ETAPA 1: Resetando banco de dados via reset_db.sql...');
        const sqlReset = fs.readFileSync(path.join(__dirname, 'reset_db.sql'), 'utf8');
        await pool.query(sqlReset);

        const virgem = (
            await pool.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM cliente) AS clientes,
                    (SELECT COUNT(*)::int FROM produto) AS produtos,
                    (SELECT COUNT(*)::int FROM pedido) AS pedidos,
                    (SELECT COUNT(*)::int FROM conta_receber) AS contas_receber
            `)
        ).rows[0];

        verificar(
            'Banco de dados limpo em estado virgem (IDs reiniciados)',
            virgem.clientes === 0 &&
                virgem.produtos === 0 &&
                virgem.pedidos === 0 &&
                virgem.contas_receber === 0,
            `clientes=${virgem.clientes}, produtos=${virgem.produtos}, pedidos=${virgem.pedidos}, contas_receber=${virgem.contas_receber}`,
            'clientes=0, produtos=0, pedidos=0, contas_receber=0'
        );

        // =========================================================================
        // 2. CADASTRO DE CLIENTE B2B E PRODUTO (COXINHA A R$ 8,00)
        // =========================================================================
        console.log('\n🏢 ETAPA 2: Cadastrando Cliente B2B e Produto "Coxinha Gourmet" (R$ 8,00/un)...');

        const resCliente = mockRes();
        await comercialController.criarCliente(
            {
                body: {
                    razao_social: 'Padaria Bella Vista Ltda',
                    cnpj: '24.680.135/0001-99',
                    telefone: '11988887777',
                    endereco: 'Av. Central, 450 - São Paulo/SP',
                    tipo: 'B2B'
                }
            },
            resCliente
        );
        const clienteId = resCliente.body.id;

        const resInsumo = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Farinha de Trigo',
                    categoria: 'Farináceo',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 4.50,
                    peso_embalagem: 1000,
                    estoque_atual: 50
                }
            },
            resInsumo
        );
        const insumoId = resInsumo.body.id;

        const resProduto = mockRes();
        await produtoController.criar(
            {
                body: {
                    nome: 'Coxinha Gourmet',
                    categoria: 'Frito',
                    categoria_producao: 'Frito',
                    preco_venda: 8.0,
                    estoque_atual: 100,
                    ficha_tecnica_insumos: [{ insumo_id: insumoId, quantidade: 0.12 }]
                }
            },
            resProduto
        );
        const produtoId = resProduto.body.produto_id;
        const prodDb = (await pool.query('SELECT id, preco_venda FROM produto WHERE id = $1', [produtoId])).rows[0];

        verificar(
            'Cliente B2B e Produto "Coxinha Gourmet" (R$ 8,00) cadastrados com ID=1',
            clienteId === 1 && produtoId === 1 && aproxIgual(prodDb?.preco_venda, 8.0),
            `clienteId=${clienteId}, produtoId=${produtoId}, preco_venda=R$ ${Number(prodDb?.preco_venda || 0).toFixed(2)}`,
            'clienteId=1, produtoId=1, preco_venda=R$ 8.00'
        );

        // Datas calculadas diretamente no PostgreSQL para evitar divergência de fuso horário
        const datasPg = (
            await pool.query(`
                SELECT
                    TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS hoje,
                    TO_CHAR(CURRENT_DATE + INTERVAL '2 days', 'YYYY-MM-DD') AS entrega_2d,
                    TO_CHAR(CURRENT_DATE + INTERVAL '15 days', 'YYYY-MM-DD') AS venc_15d
            `)
        ).rows[0];

        // =========================================================================
        // 3. LANÇAMENTO DE PEDIDO DE VENDA A PRAZO (50 COXINHAS = R$ 400,00 | BOLETO +15 DIAS)
        // =========================================================================
        console.log(`\n🛒 ETAPA 3: Lançando Pedido de 50 Coxinhas (R$ 400,00) A_PRAZO (BOLETO, venc. ${datasPg.venc_15d})...`);

        const resPedido = mockRes();
        await comercialController.lancarPedido(
            {
                body: {
                    cliente_id: clienteId,
                    data_entrega: datasPg.entrega_2d,
                    pagamento_tipo: 'A_PRAZO',
                    forma_pagamento: 'BOLETO',
                    data_vencimento: datasPg.venc_15d,
                    itens: [
                        {
                            produto_id: produtoId,
                            quantidade: 50,
                            preco_unitario: 8.0
                        }
                    ]
                }
            },
            resPedido
        );

        const pedDb = (await pool.query('SELECT * FROM pedido WHERE id = $1', [resPedido.body.pedido_id])).rows[0];

        verificar(
            'Pedido de Venda #1 criado com sucesso (valor_total = R$ 400,00)',
            resPedido.statusCode === 201 &&
                resPedido.body.pedido_id === 1 &&
                pedDb &&
                aproxIgual(pedDb.valor_total, 400.0),
            `HTTP ${resPedido.statusCode}, pedido_id=${resPedido.body.pedido_id}, valor_total=R$ ${Number(pedDb?.valor_total || 0).toFixed(2)}`,
            'HTTP 201, pedido_id=1, valor_total=R$ 400.00'
        );

        const crDb = (
            await pool.query(
                `SELECT *, TO_CHAR(data_vencimento, 'YYYY-MM-DD') AS venc_str
                 FROM conta_receber
                 WHERE pedido_id = $1`,
                [resPedido.body.pedido_id]
            )
        ).rows[0];

        verificar(
            'Título de R$ 400,00 gerado automaticamente em conta_receber com status PENDENTE e vencimento exato (+15 dias)',
            Boolean(crDb) &&
                crDb.id === 1 &&
                crDb.cliente_id === clienteId &&
                aproxIgual(crDb.valor, 400.0) &&
                crDb.status === 'PENDENTE' &&
                crDb.forma_pagamento === 'BOLETO' &&
                crDb.venc_str === datasPg.venc_15d &&
                crDb.data_recebimento === null,
            `id=${crDb?.id}, valor=R$ ${Number(crDb?.valor || 0).toFixed(2)}, status=${crDb?.status}, forma=${crDb?.forma_pagamento}, venc=${crDb?.venc_str}, data_recebimento=${crDb?.data_recebimento}`,
            `id=1, valor=R$ 400.00, status=PENDENTE, forma=BOLETO, venc=${datasPg.venc_15d}, data_recebimento=null`
        );

        // Validar KPIs antes da baixa via GET /api/financeiro/contas-receber
        const resListaAntes = mockRes();
        await financeiroController.listarContasReceber({ query: {} }, resListaAntes);
        const kpisAntes = resListaAntes.body?.kpis || {};

        verificar(
            'KPIs iniciais apontam R$ 400,00 a receber (pendente) e R$ 0,00 recebidos no mês',
            resListaAntes.statusCode === 200 &&
                aproxIgual(kpisAntes.total_a_receber, 400.0) &&
                aproxIgual(kpisAntes.total_recebidos_mes, 0.0) &&
                Array.isArray(resListaAntes.body?.dados) &&
                resListaAntes.body.dados.length === 1 &&
                resListaAntes.body.dados[0].razao_social === 'Padaria Bella Vista Ltda',
            `a_receber=R$ ${Number(kpisAntes.total_a_receber || 0).toFixed(2)}, recebidos_mes=R$ ${Number(kpisAntes.total_recebidos_mes || 0).toFixed(2)}, cliente="${resListaAntes.body?.dados?.[0]?.razao_social}"`,
            'a_receber=R$ 400.00, recebidos_mes=R$ 0.00, cliente="Padaria Bella Vista Ltda"'
        );

        // =========================================================================
        // 4. DAR BAIXA NO RECEBIMENTO (PUT /api/financeiro/contas-receber/1/receber)
        // =========================================================================
        console.log('\n💵 ETAPA 4: Liquidando o título via PUT /api/financeiro/contas-receber/1/receber...');

        const resBaixa = mockRes();
        await financeiroController.receberConta(
            {
                params: { id: '1' },
                body: { forma_pagamento: 'BOLETO' }
            },
            resBaixa
        );

        const crPosBaixa = (
            await pool.query(
                `SELECT *, TO_CHAR(data_recebimento, 'YYYY-MM-DD') AS rec_str
                 FROM conta_receber
                 WHERE id = 1`
            )
        ).rows[0];

        verificar(
            'Título #1 atualizado para status RECEBIDO e data_recebimento preenchida com a data atual',
            resBaixa.statusCode === 200 &&
                crPosBaixa.status === 'RECEBIDO' &&
                crPosBaixa.rec_str === datasPg.hoje,
            `HTTP ${resBaixa.statusCode}, status=${crPosBaixa?.status}, data_recebimento=${crPosBaixa?.rec_str}`,
            `HTTP 200, status=RECEBIDO, data_recebimento=${datasPg.hoje}`
        );

        // Validar bloqueio de baixa em duplicidade (idempotência / proteção financeira)
        const resBaixaDuplicada = mockRes();
        await financeiroController.receberConta(
            {
                params: { id: '1' },
                body: {}
            },
            resBaixaDuplicada
        );

        verificar(
            'Bloqueio contra baixa duplicada em título já RECEBIDO (HTTP 400)',
            resBaixaDuplicada.statusCode === 400,
            `HTTP ${resBaixaDuplicada.statusCode} (${resBaixaDuplicada.body?.erro})`,
            'HTTP 400'
        );

        // =========================================================================
        // 5. VALIDAR ATUALIZAÇÃO DOS KPIS APÓS O RECEBIMENTO
        // =========================================================================
        console.log('\n📊 ETAPA 5: Validando KPIs de Contas a Receber após confirmação do recebimento...');

        const resListaDepois = mockRes();
        await financeiroController.listarContasReceber({ query: {} }, resListaDepois);
        const kpisDepois = resListaDepois.body?.kpis || {};

        verificar(
            'KPIs atualizados para R$ 0,00 a receber e R$ 400,00 recebidos no mês',
            resListaDepois.statusCode === 200 &&
                aproxIgual(kpisDepois.total_a_receber, 0.0) &&
                aproxIgual(kpisDepois.total_recebidos_mes, 400.0),
            `a_receber=R$ ${Number(kpisDepois.total_a_receber || 0).toFixed(2)}, recebidos_mes=R$ ${Number(kpisDepois.total_recebidos_mes || 0).toFixed(2)}`,
            'a_receber=R$ 0.00, recebidos_mes=R$ 400.00'
        );

        // =========================================================================
        // RELATÓRIO FINAL
        // =========================================================================
        console.log('\n================================================================================');
        if (totalFalhas === 0) {
            console.log(`🏆 RESULTADO FINAL: ${totalChecks}/${totalChecks} VERIFICAÇÕES [PASS] — 100% APROVADO!`);
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 RESULTADO FINAL: ${totalFalhas} FALHA(S) EM ${totalChecks} VERIFICAÇÕES!`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (erro) {
        console.error('\n💥 ERRO CRÍTICO NA EXECUÇÃO DO TESTE DE CONTAS A RECEBER:', erro);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarTesteContasReceber();
